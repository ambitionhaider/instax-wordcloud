/**
 * Real-time word cloud server.
 *
 * Surfaces:
 *   /join       participant
 *   /presenter  operator console (cloud + QR + controls)
 *   /display    big-screen canvas
 *   /host       moderation panel
 *
 * Transport is Socket.io with one room per poll. Vote updates are never emitted
 * per-submission — they are coalesced into a dirty set and flushed on a fixed
 * BROADCAST_MS tick, so a burst of 400 simultaneous submissions costs one frame
 * on the presenter screen instead of 400.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'http'
import { parse } from 'url'
import next from 'next'
import { Server, type Socket } from 'socket.io'
import os from 'os'
import { createHmac, randomUUID, timingSafeEqual } from 'crypto'

import { Blocklist, normalize } from './lib/normalize'
import { createStore, describeAction, type PollStore } from './lib/store'
import { defaultEventLog } from './lib/persist'
import type { AppState, HostState, ModerationAction, PollConfig, WordEntry } from './lib/types'

const dev = process.env.NODE_ENV !== 'production'
const port = parseInt(process.env.PORT || '3000', 10)
const app = next({ dev })
const handle = app.getRequestHandler()

/** Broadcast coalescing interval. Spec range: 250–500ms. */
const BROADCAST_MS = 300
/** How long a participant may undo their own submission. */
const UNDO_WINDOW_MS = 5_000

// ── Host auth ─────────────────────────────────────────────────────────────────

const HOST_USER = process.env.HOST_USER ?? ''
const HOST_PASSWORD = process.env.HOST_PASSWORD ?? ''
const HOST_AUTH_ON = Boolean(HOST_USER && HOST_PASSWORD)
const HOST_COOKIE = 'wc_host'

/**
 * Per-boot cookie value. A restart invalidates it, which costs nothing: the
 * browser re-sends its Basic credentials on the next load and gets a new one.
 */
const hostCookieValue = createHmac('sha256', randomUUID())
  .update(`${HOST_USER}:${HOST_PASSWORD}`)
  .digest('hex')

const safeEqual = (a: string, b: string) => {
  const [ab, bb] = [Buffer.from(a), Buffer.from(b)]
  return ab.length === bb.length && timingSafeEqual(ab, bb)
}

/** Basic-auth header against HOST_USER / HOST_PASSWORD. */
function hasHostCredentials(req: IncomingMessage): boolean {
  const header = req.headers.authorization ?? ''
  if (!header.startsWith('Basic ')) return false
  const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8')
  const sep = decoded.indexOf(':')
  if (sep < 0) return false
  return safeEqual(decoded.slice(0, sep), HOST_USER) && safeEqual(decoded.slice(sep + 1), HOST_PASSWORD)
}

/**
 * Socket-side twin of the HTTP guard. The moderation panel talks over the
 * socket, so gating only the page would leave the tally readable to anyone who
 * opened a socket by hand.
 */
function hasHostCookie(socket: Socket): boolean {
  if (!HOST_AUTH_ON) return true
  const match = (socket.handshake.headers.cookie ?? '').match(
    new RegExp(`(?:^|;\\s*)${HOST_COOKIE}=([^;]+)`),
  )
  return Boolean(match && safeEqual(match[1], hostCookieValue))
}

// ── Questions ─────────────────────────────────────────────────────────────────

const QUESTIONS: string[] = [
  'What is the ONE word that describes your Fujifilm business?',
  'If Instax was a person at this conference, what would its personality be?',
  'Which camera feature is your ultimate "secret weapon" when closing a high-value sale?',
  'Which color of Instax Camera best matches your personal mood today?',
  'If you could bundle ONE surprising item inside an Instax starter kit to double its sales, what non-camera item would you pick?',
  'What is the strongest reason a customer has given for NOT buying an Instax?',
  'If the GFX System were a luxury vehicle, which model would it be on the road?',
  'If Instax had a Bollywood movie title, what would you call it?',
]

/** One poll per question. The poll id is the unit of isolation everywhere. */
const pollId = (index: number) => `q${index}`

let currentQuestion = 0

// ── Undo ledger ───────────────────────────────────────────────────────────────

interface PendingVote {
  pollId: string
  key: string
  participantId: string
  at: number
}

const pendingVotes = new Map<string, PendingVote>()

function sweepPendingVotes() {
  const cutoff = Date.now() - UNDO_WINDOW_MS
  for (const [id, v] of pendingVotes) {
    if (v.at < cutoff) pendingVotes.delete(id)
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function getLocalIP(): string {
  const nets = os.networkInterfaces()
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] ?? []) {
      if (net.family === 'IPv4' && !net.internal) return net.address
    }
  }
  return 'localhost'
}

/** Per-poll blocklist cache, rebuilt only when the host edits the banned list. */
const blocklistCache = new Map<string, { terms: string; list: Blocklist }>()

function blocklistFor(id: string, config: PollConfig): Blocklist {
  const terms = config.bannedTerms.join('|')
  const cached = blocklistCache.get(id)
  if (cached && cached.terms === terms) return cached.list
  const list = new Blocklist(config.bannedTerms)
  blocklistCache.set(id, { terms, list })
  return list
}

function readJsonBody(req: IncomingMessage, limit = 4096): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > limit) {
        reject(new Error('payload too large'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {})
      } catch {
        reject(new Error('invalid JSON'))
      }
    })
    req.on('error', reject)
  })
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

// ── Boot ──────────────────────────────────────────────────────────────────────

async function main() {
  const store: PollStore = await createStore()
  const { log, path: logPath } = defaultEventLog()

  await app.prepare()

  const httpServer = createServer(async (req, res) => {
    const parsedUrl = parse(req.url!, true)
    const pathname = parsedUrl.pathname || '/'

    // POST /api/poll/:id/submit — REST twin of the socket submit path.
    const submitMatch = pathname.match(/^\/api\/poll\/([^/]+)\/submit$/)
    if (submitMatch && req.method === 'POST') {
      try {
        const body = (await readJsonBody(req)) as { answer?: string; participantId?: string }
        const result = await submitAnswer(
          decodeURIComponent(submitMatch[1]),
          String(body.answer ?? ''),
          body.participantId || randomUUID(),
        )
        sendJson(res, result.ok ? 200 : 400, result)
      } catch (err) {
        sendJson(res, 400, { ok: false, error: (err as Error).message })
      }
      return
    }

    // GET /api/poll/:id — current visible tally.
    const pollMatch = pathname.match(/^\/api\/poll\/([^/]+)$/)
    if (pollMatch && req.method === 'GET') {
      const id = decodeURIComponent(pollMatch[1])
      const config = await store.getConfig(id)
      sendJson(res, 200, {
        pollId: id,
        words: await store.top(id, config.topN),
        config,
        stats: await store.stats(id),
      })
      return
    }

    // /host is the moderation panel: Basic auth, then a cookie the socket reads.
    if (pathname === '/host') {
      if (!HOST_AUTH_ON) {
        if (!dev) {
          sendJson(res, 503, { error: 'Host panel disabled: set HOST_USER and HOST_PASSWORD.' })
          return
        }
      } else if (!hasHostCredentials(req)) {
        res.writeHead(401, {
          'WWW-Authenticate': 'Basic realm="Host panel", charset="UTF-8"',
          'Content-Type': 'text/plain; charset=utf-8',
        })
        res.end('Authentication required.')
        return
      } else {
        res.setHeader(
          'Set-Cookie',
          `${HOST_COOKIE}=${hostCookieValue}; HttpOnly; SameSite=Lax; Path=/${dev ? '' : '; Secure'}`,
        )
      }
    }

    handle(req, res, parsedUrl)
  })

  const io = new Server(httpServer, { cors: { origin: '*' } })

  // ── Batched broadcast ───────────────────────────────────────────────────────
  //
  // Submissions mark their poll dirty; this tick is the only thing that emits
  // word updates. One flush per poll per interval, regardless of vote volume.

  const dirty = new Set<string>()

  function markDirty(id: string) {
    dirty.add(id)
  }

  setInterval(() => {
    if (!dirty.size) return
    const ids = [...dirty]
    dirty.clear()
    for (const id of ids) void broadcastPoll(id)
  }, BROADCAST_MS)

  setInterval(sweepPendingVotes, UNDO_WINDOW_MS)

  async function buildState(id: string, index: number): Promise<AppState> {
    const config = await store.getConfig(id)
    const [words, counts] = await Promise.all([store.top(id, config.topN), store.stats(id)])
    return {
      questionIndex: index,
      question: QUESTIONS[index],
      totalQuestions: QUESTIONS.length,
      words,
      config,
      stats: {
        participants: counts.participants,
        votes: counts.votes,
        connected: io.sockets.adapter.rooms.get(id)?.size ?? 0,
      },
    }
  }

  async function buildHostState(id: string, index: number): Promise<HostState> {
    const base = await buildState(id, index)
    return { ...base, allWords: await store.all(id) }
  }

  async function broadcastPoll(id: string) {
    const index = Number(id.slice(1))
    if (!Number.isInteger(index) || !QUESTIONS[index]) return
    const state = await buildState(id, index)
    io.to(id).emit('word_update', {
      pollId: id,
      questionIndex: index,
      words: state.words,
      stats: state.stats,
    })
    io.to(`${id}:host`).emit('host_state', await buildHostState(id, index))
  }

  async function broadcastQuestionChange() {
    const id = pollId(currentQuestion)
    const state = await buildState(id, currentQuestion)
    io.emit('question_change', state)
    log.append('question.change', id, { index: currentQuestion })
  }

  // ── Submission (shared by REST and socket) ──────────────────────────────────

  interface SubmitOutcome {
    ok: boolean
    error?: string
    label?: string
    voteId?: string
    count?: number
  }

  async function submitAnswer(
    id: string,
    answer: string,
    participantId: string,
  ): Promise<SubmitOutcome> {
    const config = await store.getConfig(id)

    if (config.locked) {
      return { ok: false, error: 'Polling is closed.' }
    }
    if (!config.allowMultiple && (await store.hasSubmitted(id, participantId))) {
      return { ok: false, error: 'You have already answered this question.' }
    }

    const result = normalize(
      answer,
      { maxChars: config.maxChars, maxWords: config.maxWords, lemmatize: config.lemmatize },
      blocklistFor(id, config),
    )

    if (!result.ok) {
      log.append('vote.rejected', id, { reason: result.reason }, participantId)
      // A blocked term is dropped silently: the participant gets a success
      // response and never learns they were filtered.
      if (result.reason === 'blocked') return { ok: true, label: answer.trim() }
      return { ok: false, error: result.message }
    }

    const count = await store.incr(id, result.key, result.label)
    await store.markParticipant(id, participantId)
    await store.addVote(id, 1)

    const voteId = randomUUID()
    pendingVotes.set(voteId, { pollId: id, key: result.key, participantId, at: Date.now() })

    log.append('vote.cast', id, { key: result.key, label: result.label, count }, participantId)
    markDirty(id)

    return { ok: true, label: result.label, voteId, count }
  }

  async function undoVote(voteId: string, participantId: string): Promise<SubmitOutcome> {
    const vote = pendingVotes.get(voteId)
    if (!vote) return { ok: false, error: 'Undo window has expired.' }
    if (vote.participantId !== participantId) return { ok: false, error: 'Not your submission.' }
    if (Date.now() - vote.at > UNDO_WINDOW_MS) {
      pendingVotes.delete(voteId)
      return { ok: false, error: 'Undo window has expired.' }
    }

    pendingVotes.delete(voteId)
    await store.decr(vote.pollId, vote.key)
    await store.addVote(vote.pollId, -1)

    // If this was their only vote, free them to answer again.
    const stillHasVotes = [...pendingVotes.values()].some(
      (v) => v.pollId === vote.pollId && v.participantId === participantId,
    )
    const config = await store.getConfig(vote.pollId)
    if (!config.allowMultiple && !stillHasVotes) {
      await store.unmarkParticipant(vote.pollId, participantId)
    }

    log.append('vote.undo', vote.pollId, { key: vote.key }, participantId)
    markDirty(vote.pollId)
    return { ok: true }
  }

  // ── Moderation ──────────────────────────────────────────────────────────────

  async function applyModeration(id: string, action: ModerationAction, actor: string) {
    const detail: Record<string, unknown> = {}

    switch (action.type) {
      case 'hide':
        await store.setHidden(id, action.key, true)
        break
      case 'restore':
        await store.setHidden(id, action.key, false)
        break
      case 'merge': {
        const moved = await store.merge(id, action.from, action.into)
        detail.movedVotes = moved.from
        detail.newTotal = moved.into
        break
      }
      case 'lock':
        await store.setConfig(id, { locked: action.locked })
        break
      case 'reset':
        await store.reset(id)
        for (const [vid, v] of pendingVotes) if (v.pollId === id) pendingVotes.delete(vid)
        break
      case 'config':
        await store.setConfig(id, action.patch)
        break
    }

    await store.audit({ at: Date.now(), pollId: id, actor, action, detail })
    log.append('moderation', id, { action, detail, summary: describeAction(action) }, actor)
    markDirty(id)

    // Config and lock changes affect the participant UI, so they go out
    // immediately rather than waiting on the vote-coalescing tick.
    if (action.type === 'lock' || action.type === 'config' || action.type === 'reset') {
      const index = Number(id.slice(1))
      io.to(id).emit('config_change', await store.getConfig(id))
      io.emit('question_change', await buildState(id, index))
    }
  }

  // ── Socket wiring ───────────────────────────────────────────────────────────

  io.on('connection', (socket: Socket) => {
    let isHost = false
    let participantId = String(socket.handshake.query.pid || '') || randomUUID()

    socket.join(pollId(currentQuestion))

    const sendState = async () => {
      socket.emit('state', await buildState(pollId(currentQuestion), currentQuestion))
      if (isHost) {
        socket.emit('host_state', await buildHostState(pollId(currentQuestion), currentQuestion))
      }
    }

    void sendState()

    socket.on('get_state', () => void sendState())

    socket.on('identify', ({ pid }: { pid?: string }) => {
      if (typeof pid === 'string' && pid) participantId = pid
    })

    /** Host panel opt-in: joins the host room and starts receiving full tallies. */
    socket.on('host:join', async () => {
      if (!hasHostCookie(socket)) return
      isHost = true
      socket.join(`${pollId(currentQuestion)}:host`)
      socket.emit('host_state', await buildHostState(pollId(currentQuestion), currentQuestion))
      socket.emit('audit_log', await store.auditLog(pollId(currentQuestion), 50))
    })

    // ── Participant ──
    socket.on('submit_answer', async ({ answer }: { answer: string }, ack?: (r: unknown) => void) => {
      const result = await submitAnswer(pollId(currentQuestion), String(answer ?? ''), participantId)
      socket.emit('submit_result', result)
      ack?.(result)
    })

    socket.on('undo_answer', async ({ voteId }: { voteId: string }, ack?: (r: unknown) => void) => {
      const result = await undoVote(String(voteId ?? ''), participantId)
      socket.emit('undo_result', result)
      ack?.(result)
    })

    // ── Presenter navigation ──
    const goTo = async (index: number) => {
      if (index < 0 || index >= QUESTIONS.length || index === currentQuestion) return
      const previous = pollId(currentQuestion)
      currentQuestion = index
      const nextId = pollId(currentQuestion)

      // Move every connected socket to the new poll's room.
      for (const s of await io.fetchSockets()) {
        s.leave(previous)
        s.leave(`${previous}:host`)
        s.join(nextId)
      }
      socket.join(nextId)
      if (isHost) socket.join(`${nextId}:host`)

      await broadcastQuestionChange()
      io.to(`${nextId}:host`).emit('host_state', await buildHostState(nextId, currentQuestion))
    }

    socket.on('next_question', () => void goTo(currentQuestion + 1))
    socket.on('prev_question', () => void goTo(currentQuestion - 1))
    socket.on('goto_question', ({ index }: { index: number }) => void goTo(Number(index)))

    // ── Moderation events ──
    // Host-only. Question navigation and reset stay open, since the presenter
    // console drives those and sits behind no login.
    socket.on('word:hide', ({ key }: { key: string }) => {
      if (!hasHostCookie(socket)) return
      void applyModeration(pollId(currentQuestion), { type: 'hide', key: String(key) }, participantId)
    })
    socket.on('word:restore', ({ key }: { key: string }) => {
      if (!hasHostCookie(socket)) return
      void applyModeration(pollId(currentQuestion), { type: 'restore', key: String(key) }, participantId)
    })
    socket.on('word:merge', ({ from, into }: { from: string; into: string }) => {
      if (!hasHostCookie(socket)) return
      void applyModeration(
        pollId(currentQuestion),
        { type: 'merge', from: String(from), into: String(into) },
        participantId,
      )
    })
    socket.on('poll:lock', ({ locked }: { locked: boolean }) => {
      if (!hasHostCookie(socket)) return
      void applyModeration(pollId(currentQuestion), { type: 'lock', locked: !!locked }, participantId)
    })
    socket.on('poll:config', ({ patch }: { patch: Partial<PollConfig> }) => {
      if (!hasHostCookie(socket)) return
      void applyModeration(pollId(currentQuestion), { type: 'config', patch: patch ?? {} }, participantId)
    })
    socket.on('reset_question', () =>
      void applyModeration(pollId(currentQuestion), { type: 'reset' }, participantId),
    )

    socket.on('get_audit', async () => {
      if (!hasHostCookie(socket)) return
      socket.emit('audit_log', await store.auditLog(pollId(currentQuestion), 50))
    })

    // Connected-count in the metadata bar changes, so refresh on the next tick.
    socket.on('disconnect', () => markDirty(pollId(currentQuestion)))
  })

  httpServer.listen(port, '0.0.0.0', () => {
    const ip = getLocalIP()
    console.log(`\n✅  Presenter:   http://localhost:${port}/presenter`)
    console.log(`🖥️   Big screen:  http://localhost:${port}/display`)
    console.log(`🛡️   Host panel:  http://localhost:${port}/host`)
    console.log(`📱  Participant: http://${ip}:${port}/join`)
    console.log(`\n   store: ${store.kind}   broadcast: ${BROADCAST_MS}ms   log: ${logPath}\n`)
  })
}

main().catch((err) => {
  console.error('Fatal startup error:', err)
  process.exit(1)
})
