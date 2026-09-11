/**
 * Poll store.
 *
 * Two interchangeable adapters behind one async interface:
 *
 *   MemoryStore — zero-config default. Fine for a single presenter machine.
 *   RedisStore  — used when REDIS_URL is set. Sorted sets give atomic ZINCRBY
 *                 increments and O(log N) ZREVRANGE top-N retrieval, and let
 *                 multiple server processes share one poll.
 *
 * Both implement identical semantics; the server never knows which is live.
 */

import { DEFAULT_CONFIG } from './types'
import type { AuditEntry, ModerationAction, PollConfig, WordEntry } from './types'

export { DEFAULT_CONFIG }

export interface PollStore {
  /** Atomic increment. Returns the new count, or null if the key is merged away. */
  incr(pollId: string, key: string, label: string, delta?: number): Promise<number>
  /** Decrement for undo. Removes the member when the score hits zero. */
  decr(pollId: string, key: string, delta?: number): Promise<number>

  /** Top N visible terms, descending. Excludes hidden and merged-away keys. */
  top(pollId: string, n: number): Promise<WordEntry[]>
  /** Every term including hidden ones — host panel only. */
  all(pollId: string): Promise<WordEntry[]>

  setHidden(pollId: string, key: string, hidden: boolean): Promise<void>
  merge(pollId: string, from: string, into: string): Promise<{ from: number; into: number }>
  /** Follows the merge chain so later submissions of a merged key land on the target. */
  resolveKey(pollId: string, key: string): Promise<string>

  markParticipant(pollId: string, participantId: string): Promise<void>
  /** Undo removes the mark so a single-answer participant may submit again. */
  unmarkParticipant(pollId: string, participantId: string): Promise<void>
  hasSubmitted(pollId: string, participantId: string): Promise<boolean>
  stats(pollId: string): Promise<{ participants: number; votes: number }>
  addVote(pollId: string, delta?: number): Promise<void>

  getConfig(pollId: string): Promise<PollConfig>
  setConfig(pollId: string, patch: Partial<PollConfig>): Promise<PollConfig>

  reset(pollId: string): Promise<void>

  audit(entry: AuditEntry): Promise<void>
  auditLog(pollId: string, limit?: number): Promise<AuditEntry[]>

  close(): Promise<void>
  readonly kind: 'memory' | 'redis'
}

// ── Label picking ─────────────────────────────────────────────────────────────
//
// A key can arrive with several surface forms ("AI", "Ai", "ai"). We keep a
// frequency count per (key, label) and display whichever form was written most
// often, so the crowd's own preferred casing wins.

const SEP = '\u0000'

// ── Memory adapter ────────────────────────────────────────────────────────────

interface MemoryPoll {
  scores: Map<string, number>
  labels: Map<string, string>
  labelFreq: Map<string, number> // `${key}${SEP}${label}` -> count
  hidden: Set<string>
  merged: Map<string, string>
  participants: Set<string>
  votes: number
  config: PollConfig
  audit: AuditEntry[]
}

export class MemoryStore implements PollStore {
  readonly kind = 'memory' as const
  private polls = new Map<string, MemoryPoll>()

  private poll(id: string): MemoryPoll {
    let p = this.polls.get(id)
    if (!p) {
      p = {
        scores: new Map(),
        labels: new Map(),
        labelFreq: new Map(),
        hidden: new Set(),
        merged: new Map(),
        participants: new Set(),
        votes: 0,
        config: { ...DEFAULT_CONFIG },
        audit: [],
      }
      this.polls.set(id, p)
    }
    return p
  }

  async resolveKey(pollId: string, key: string): Promise<string> {
    const p = this.poll(pollId)
    let k = key
    // Bounded walk — a cycle would otherwise spin forever.
    for (let i = 0; i < 16; i++) {
      const next = p.merged.get(k)
      if (!next || next === k) break
      k = next
    }
    return k
  }

  async incr(pollId: string, key: string, label: string, delta = 1): Promise<number> {
    const p = this.poll(pollId)
    const k = await this.resolveKey(pollId, key)
    const next = (p.scores.get(k) ?? 0) + delta
    p.scores.set(k, next)

    const field = k + SEP + label
    const freq = (p.labelFreq.get(field) ?? 0) + 1
    p.labelFreq.set(field, freq)
    const current = p.labels.get(k)
    if (!current || freq > (p.labelFreq.get(k + SEP + current) ?? 0)) {
      p.labels.set(k, label)
    }
    return next
  }

  async decr(pollId: string, key: string, delta = 1): Promise<number> {
    const p = this.poll(pollId)
    const k = await this.resolveKey(pollId, key)
    const next = (p.scores.get(k) ?? 0) - delta
    if (next <= 0) {
      p.scores.delete(k)
      return 0
    }
    p.scores.set(k, next)
    return next
  }

  private entries(p: MemoryPoll): WordEntry[] {
    return [...p.scores.entries()]
      .map(([key, count]) => ({
        key,
        text: p.labels.get(key) ?? key,
        count,
        hidden: p.hidden.has(key),
      }))
      .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))
  }

  async top(pollId: string, n: number): Promise<WordEntry[]> {
    return this.entries(this.poll(pollId))
      .filter((w) => !w.hidden)
      .slice(0, n)
  }

  async all(pollId: string): Promise<WordEntry[]> {
    const p = this.poll(pollId)
    const list = this.entries(p)
    for (const [from, into] of p.merged) {
      list.push({ key: from, text: p.labels.get(from) ?? from, count: 0, mergedInto: into })
    }
    return list
  }

  async setHidden(pollId: string, key: string, hidden: boolean): Promise<void> {
    const p = this.poll(pollId)
    if (hidden) p.hidden.add(key)
    else p.hidden.delete(key)
  }

  async merge(pollId: string, from: string, into: string): Promise<{ from: number; into: number }> {
    const p = this.poll(pollId)
    const target = await this.resolveKey(pollId, into)
    if (from === target) return { from: 0, into: p.scores.get(target) ?? 0 }

    const moved = p.scores.get(from) ?? 0
    p.scores.delete(from)
    p.hidden.delete(from)
    const total = (p.scores.get(target) ?? 0) + moved
    if (total > 0) p.scores.set(target, total)
    p.merged.set(from, target)
    return { from: moved, into: total }
  }

  async markParticipant(pollId: string, participantId: string): Promise<void> {
    this.poll(pollId).participants.add(participantId)
  }

  async unmarkParticipant(pollId: string, participantId: string): Promise<void> {
    this.poll(pollId).participants.delete(participantId)
  }

  async hasSubmitted(pollId: string, participantId: string): Promise<boolean> {
    return this.poll(pollId).participants.has(participantId)
  }

  async stats(pollId: string) {
    const p = this.poll(pollId)
    return { participants: p.participants.size, votes: p.votes }
  }

  async addVote(pollId: string, delta = 1): Promise<void> {
    const p = this.poll(pollId)
    p.votes = Math.max(0, p.votes + delta)
  }

  async getConfig(pollId: string): Promise<PollConfig> {
    return { ...this.poll(pollId).config }
  }

  async setConfig(pollId: string, patch: Partial<PollConfig>): Promise<PollConfig> {
    const p = this.poll(pollId)
    p.config = { ...p.config, ...patch }
    return { ...p.config }
  }

  async reset(pollId: string): Promise<void> {
    const p = this.poll(pollId)
    p.scores.clear()
    p.labels.clear()
    p.labelFreq.clear()
    p.hidden.clear()
    p.merged.clear()
    p.participants.clear()
    p.votes = 0
  }

  async audit(entry: AuditEntry): Promise<void> {
    const p = this.poll(entry.pollId)
    p.audit.unshift(entry)
    if (p.audit.length > 500) p.audit.length = 500
  }

  async auditLog(pollId: string, limit = 50): Promise<AuditEntry[]> {
    return this.poll(pollId).audit.slice(0, limit)
  }

  async close(): Promise<void> {}
}

// ── Redis adapter ─────────────────────────────────────────────────────────────

type RedisLike = {
  zincrby(k: string, d: number, m: string): Promise<string>
  zscore(k: string, m: string): Promise<string | null>
  zrem(k: string, ...m: string[]): Promise<number>
  zrevrange(k: string, s: number, e: number, wp: 'WITHSCORES'): Promise<string[]>
  hget(k: string, f: string): Promise<string | null>
  hset(k: string, ...a: string[]): Promise<number>
  hgetall(k: string): Promise<Record<string, string>>
  hincrby(k: string, f: string, d: number): Promise<number>
  sadd(k: string, m: string): Promise<number>
  srem(k: string, m: string): Promise<number>
  sismember(k: string, m: string): Promise<number>
  smembers(k: string): Promise<string[]>
  scard(k: string): Promise<number>
  incrby(k: string, d: number): Promise<number>
  get(k: string): Promise<string | null>
  set(k: string, v: string): Promise<unknown>
  del(...k: string[]): Promise<number>
  lpush(k: string, v: string): Promise<number>
  ltrim(k: string, s: number, e: number): Promise<unknown>
  lrange(k: string, s: number, e: number): Promise<string[]>
  quit(): Promise<unknown>
}

export class RedisStore implements PollStore {
  readonly kind = 'redis' as const

  constructor(private redis: RedisLike) {}

  private k(pollId: string, suffix: string) {
    return `poll:${pollId}:${suffix}`
  }

  async resolveKey(pollId: string, key: string): Promise<string> {
    let k = key
    for (let i = 0; i < 16; i++) {
      const next = await this.redis.hget(this.k(pollId, 'merged'), k)
      if (!next || next === k) break
      k = next
    }
    return k
  }

  async incr(pollId: string, key: string, label: string, delta = 1): Promise<number> {
    const k = await this.resolveKey(pollId, key)
    const score = Number(await this.redis.zincrby(this.k(pollId, 'words'), delta, k))

    const freq = await this.redis.hincrby(this.k(pollId, 'labelfreq'), k + SEP + label, 1)
    const current = await this.redis.hget(this.k(pollId, 'labels'), k)
    if (!current) {
      await this.redis.hset(this.k(pollId, 'labels'), k, label)
    } else if (current !== label) {
      const currentFreq = Number(
        (await this.redis.hget(this.k(pollId, 'labelfreq'), k + SEP + current)) ?? 0,
      )
      if (freq > currentFreq) await this.redis.hset(this.k(pollId, 'labels'), k, label)
    }
    return score
  }

  async decr(pollId: string, key: string, delta = 1): Promise<number> {
    const k = await this.resolveKey(pollId, key)
    const score = Number(await this.redis.zincrby(this.k(pollId, 'words'), -delta, k))
    if (score <= 0) {
      await this.redis.zrem(this.k(pollId, 'words'), k)
      return 0
    }
    return score
  }

  /** ZREVRANGE gives the top slice without reading the whole set. */
  private async range(pollId: string, start: number, stop: number): Promise<WordEntry[]> {
    const flat = await this.redis.zrevrange(this.k(pollId, 'words'), start, stop, 'WITHSCORES')
    if (!flat.length) return []

    const labels = await this.redis.hgetall(this.k(pollId, 'labels'))
    const hidden = new Set(await this.redis.smembers(this.k(pollId, 'hidden')))

    const out: WordEntry[] = []
    for (let i = 0; i < flat.length; i += 2) {
      const key = flat[i]
      out.push({
        key,
        text: labels[key] ?? key,
        count: Number(flat[i + 1]),
        hidden: hidden.has(key),
      })
    }
    return out
  }

  async top(pollId: string, n: number): Promise<WordEntry[]> {
    // Over-fetch so hidden terms don't shrink the visible list below N.
    const hiddenCount = await this.redis.scard(this.k(pollId, 'hidden'))
    const rows = await this.range(pollId, 0, n + hiddenCount - 1)
    return rows.filter((w) => !w.hidden).slice(0, n)
  }

  async all(pollId: string): Promise<WordEntry[]> {
    const rows = await this.range(pollId, 0, -1)
    const merged = await this.redis.hgetall(this.k(pollId, 'merged'))
    const labels = await this.redis.hgetall(this.k(pollId, 'labels'))
    for (const [from, into] of Object.entries(merged)) {
      rows.push({ key: from, text: labels[from] ?? from, count: 0, mergedInto: into })
    }
    return rows
  }

  async setHidden(pollId: string, key: string, hidden: boolean): Promise<void> {
    if (hidden) await this.redis.sadd(this.k(pollId, 'hidden'), key)
    else await this.redis.srem(this.k(pollId, 'hidden'), key)
  }

  async merge(pollId: string, from: string, into: string): Promise<{ from: number; into: number }> {
    const target = await this.resolveKey(pollId, into)
    if (from === target) {
      return { from: 0, into: Number((await this.redis.zscore(this.k(pollId, 'words'), target)) ?? 0) }
    }
    const moved = Number((await this.redis.zscore(this.k(pollId, 'words'), from)) ?? 0)
    await this.redis.zrem(this.k(pollId, 'words'), from)
    await this.redis.srem(this.k(pollId, 'hidden'), from)
    let total = Number((await this.redis.zscore(this.k(pollId, 'words'), target)) ?? 0)
    if (moved > 0) total = Number(await this.redis.zincrby(this.k(pollId, 'words'), moved, target))
    await this.redis.hset(this.k(pollId, 'merged'), from, target)
    return { from: moved, into: total }
  }

  async markParticipant(pollId: string, participantId: string): Promise<void> {
    await this.redis.sadd(this.k(pollId, 'participants'), participantId)
  }

  async unmarkParticipant(pollId: string, participantId: string): Promise<void> {
    await this.redis.srem(this.k(pollId, 'participants'), participantId)
  }

  async hasSubmitted(pollId: string, participantId: string): Promise<boolean> {
    return (await this.redis.sismember(this.k(pollId, 'participants'), participantId)) === 1
  }

  async stats(pollId: string) {
    const participants = await this.redis.scard(this.k(pollId, 'participants'))
    const votes = Number((await this.redis.get(this.k(pollId, 'votes'))) ?? 0)
    return { participants, votes }
  }

  async addVote(pollId: string, delta = 1): Promise<void> {
    await this.redis.incrby(this.k(pollId, 'votes'), delta)
  }

  async getConfig(pollId: string): Promise<PollConfig> {
    const raw = await this.redis.get(this.k(pollId, 'config'))
    if (!raw) return { ...DEFAULT_CONFIG }
    try {
      return { ...DEFAULT_CONFIG, ...(JSON.parse(raw) as Partial<PollConfig>) }
    } catch {
      return { ...DEFAULT_CONFIG }
    }
  }

  async setConfig(pollId: string, patch: Partial<PollConfig>): Promise<PollConfig> {
    const next = { ...(await this.getConfig(pollId)), ...patch }
    await this.redis.set(this.k(pollId, 'config'), JSON.stringify(next))
    return next
  }

  async reset(pollId: string): Promise<void> {
    await this.redis.del(
      this.k(pollId, 'words'),
      this.k(pollId, 'labels'),
      this.k(pollId, 'labelfreq'),
      this.k(pollId, 'hidden'),
      this.k(pollId, 'merged'),
      this.k(pollId, 'participants'),
      this.k(pollId, 'votes'),
    )
  }

  async audit(entry: AuditEntry): Promise<void> {
    const key = this.k(entry.pollId, 'audit')
    await this.redis.lpush(key, JSON.stringify(entry))
    await this.redis.ltrim(key, 0, 499)
  }

  async auditLog(pollId: string, limit = 50): Promise<AuditEntry[]> {
    const rows = await this.redis.lrange(this.k(pollId, 'audit'), 0, limit - 1)
    return rows.flatMap((r) => {
      try {
        return [JSON.parse(r) as AuditEntry]
      } catch {
        return []
      }
    })
  }

  async close(): Promise<void> {
    await this.redis.quit()
  }
}

// ── Factory ───────────────────────────────────────────────────────────────────

/**
 * Returns a Redis-backed store when REDIS_URL is set and reachable, otherwise
 * falls back to memory. The fallback is deliberate: a presenter shouldn't lose
 * their session because Redis is down five minutes before the keynote.
 */
export async function createStore(): Promise<PollStore> {
  const url = process.env.REDIS_URL
  if (!url) return new MemoryStore()

  try {
    const { default: Redis } = await import('ioredis')
    const client = new Redis(url, {
      lazyConnect: true,
      maxRetriesPerRequest: 2,
    })
    await client.connect()
    await client.ping()
    return new RedisStore(client as unknown as RedisLike)
  } catch (err) {
    console.warn(
      `⚠️  REDIS_URL set but unreachable (${(err as Error).message}) — falling back to in-memory store.`,
    )
    return new MemoryStore()
  }
}

export function describeAction(a: ModerationAction): string {
  switch (a.type) {
    case 'hide':
      return `Hid "${a.key}"`
    case 'restore':
      return `Restored "${a.key}"`
    case 'merge':
      return `Merged "${a.from}" into "${a.into}"`
    case 'lock':
      return a.locked ? 'Locked polling' : 'Unlocked polling'
    case 'reset':
      return 'Reset all answers'
    case 'config':
      return `Changed settings: ${Object.keys(a.patch).join(', ')}`
  }
}
