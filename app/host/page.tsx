'use client'

import { useEffect, useMemo, useState } from 'react'
import { getSocket, requestState } from '@/lib/socket'
import { DEFAULT_CONFIG, type AuditEntry, type HostState, type WordEntry } from '@/lib/types'

const EMPTY: HostState = {
  questionIndex: 0,
  question: '',
  totalQuestions: 8,
  words: [],
  allWords: [],
  config: DEFAULT_CONFIG,
  stats: { participants: 0, votes: 0, connected: 0 },
}

export default function HostPage() {
  const [state, setState] = useState<HostState>(EMPTY)
  const [audit, setAudit] = useState<AuditEntry[]>([])
  const [connected, setConnected] = useState(false)

  /** Merge flow: click a source term, then click its target. */
  const [mergeFrom, setMergeFrom] = useState<string | null>(null)
  const [dragKey, setDragKey] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  const [banDraft, setBanDraft] = useState('')

  const { config, stats } = state

  useEffect(() => {
    const socket = getSocket()

    const onConnect = () => {
      setConnected(true)
      socket.emit('host:join')
    }
    const onDisconnect = () => setConnected(false)
    const onHostState = (d: HostState) => {
      setState(d)
      setConnected(true)
    }
    const onAudit = (rows: AuditEntry[]) => setAudit(rows)

    socket.on('connect', onConnect)
    socket.on('disconnect', onDisconnect)
    socket.on('host_state', onHostState)
    socket.on('audit_log', onAudit)

    if (socket.connected) socket.emit('host:join')
    requestState()

    return () => {
      socket.off('connect', onConnect)
      socket.off('disconnect', onDisconnect)
      socket.off('host_state', onHostState)
      socket.off('audit_log', onAudit)
    }
  }, [])

  // Refresh the audit trail whenever a moderation action lands.
  useEffect(() => {
    getSocket().emit('get_audit')
  }, [state.allWords])

  const active = useMemo(
    () =>
      state.allWords
        .filter((w) => !w.mergedInto)
        .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key)),
    [state.allWords],
  )

  const merged = useMemo(
    () => state.allWords.filter((w) => w.mergedInto),
    [state.allWords],
  )

  const visibleCount = active.filter((w) => !w.hidden).length

  // ── Actions ────────────────────────────────────────────────────────────────

  const emit = (event: string, payload: Record<string, unknown>) =>
    getSocket().emit(event, payload)

  const toggleHide = (w: WordEntry) =>
    emit(w.hidden ? 'word:restore' : 'word:hide', { key: w.key })

  const doMerge = (from: string, into: string) => {
    if (from === into) return
    emit('word:merge', { from, into })
    setMergeFrom(null)
    setDragKey(null)
    setDropTarget(null)
  }

  const toggleLock = () => emit('poll:lock', { locked: !config.locked })

  const patchConfig = (patch: Record<string, unknown>) => emit('poll:config', { patch })

  const addBanned = () => {
    const term = banDraft.trim().toLowerCase()
    if (!term) return
    if (!config.bannedTerms.includes(term)) {
      patchConfig({ bannedTerms: [...config.bannedTerms, term] })
    }
    setBanDraft('')
  }

  const removeBanned = (term: string) =>
    patchConfig({ bannedTerms: config.bannedTerms.filter((t) => t !== term) })

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-[#070B14] font-sans text-slate-100">
      {/* ── Top bar ── */}
      <header className="flex flex-shrink-0 items-center justify-between border-b border-white/5 bg-[#080D17] px-6 py-3">
        <div className="flex items-center gap-3">
          <span className="rounded-lg bg-violet-500/15 px-2.5 py-1 text-[10px] font-black uppercase tracking-widest text-violet-300 ring-1 ring-violet-500/25">
            Host
          </span>
          <h1 className="text-sm font-bold text-slate-200">Moderation & Control</h1>
          <span
            className={`flex items-center gap-1.5 text-xs ${
              connected ? 'text-emerald-400' : 'text-red-400'
            }`}
          >
            <span
              className={`live-dot h-1.5 w-1.5 rounded-full ${
                connected ? 'bg-emerald-400' : 'bg-red-400'
              }`}
            />
            {connected ? 'Live' : 'Offline'}
          </span>
        </div>

        <div className="flex items-center gap-4 text-xs text-slate-500">
          <span>
            <span className="font-bold text-slate-200">{stats.participants}</span> participants
          </span>
          <span>
            <span className="font-bold text-slate-200">{stats.votes}</span> votes
          </span>
          <span>
            <span className="font-bold text-slate-200">{stats.connected}</span> connected
          </span>

          <button
            onClick={toggleLock}
            className={`rounded-xl px-4 py-2 text-xs font-bold transition ${
              config.locked
                ? 'bg-amber-500/20 text-amber-300 ring-1 ring-amber-500/40 hover:bg-amber-500/30'
                : 'bg-white/5 text-slate-300 ring-1 ring-white/10 hover:bg-white/10'
            }`}
          >
            {config.locked ? '🔒 Polling locked — unlock' : '🔓 Lock polling'}
          </button>
        </div>
      </header>

      {/* Question strip */}
      <div className="flex flex-shrink-0 items-center justify-between border-b border-white/5 px-6 py-3">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-pink-500">
            Question {state.questionIndex + 1} of {state.totalQuestions}
          </p>
          <p className="mt-0.5 text-base font-bold text-slate-200">
            {state.question || 'Loading…'}
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => getSocket().emit('prev_question')}
            disabled={state.questionIndex === 0}
            className="rounded-xl border border-white/8 px-4 py-2 text-xs font-medium text-slate-400 transition hover:border-white/15 hover:text-slate-200 disabled:opacity-25"
          >
            ← Prev
          </button>
          <button
            onClick={() => getSocket().emit('next_question')}
            disabled={state.questionIndex === state.totalQuestions - 1}
            className="btn-primary rounded-xl px-4 py-2 text-xs font-bold text-white disabled:opacity-30"
          >
            Next →
          </button>
        </div>
      </div>

      {/* ── Body ── */}
      <div className="flex flex-1 overflow-hidden">
        {/* Tally list */}
        <main className="flex flex-1 flex-col overflow-hidden p-5">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-xs font-bold uppercase tracking-[0.2em] text-slate-500">
              Live tally · {visibleCount} shown / {active.length} total
            </h2>
            {mergeFrom && (
              <span className="rounded-full bg-violet-500/15 px-3 py-1 text-xs font-semibold text-violet-300 ring-1 ring-violet-500/30">
                Merging “{mergeFrom}” — pick a target
                <button
                  onClick={() => setMergeFrom(null)}
                  className="ml-2 text-violet-400 hover:text-white"
                >
                  ✕
                </button>
              </span>
            )}
          </div>

          <div className="flex-1 overflow-y-auto rounded-2xl border border-white/5">
            {active.length === 0 ? (
              <p className="p-8 text-center text-sm text-slate-600">No answers yet.</p>
            ) : (
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-[#0D1525] text-[10px] uppercase tracking-widest text-slate-600">
                  <tr>
                    <th className="px-4 py-2.5 text-left font-bold">#</th>
                    <th className="px-4 py-2.5 text-left font-bold">Term</th>
                    <th className="px-4 py-2.5 text-right font-bold">Votes</th>
                    <th className="px-4 py-2.5 text-right font-bold">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {active.map((w, i) => {
                    const isSource = mergeFrom === w.key
                    const isDropTarget = dropTarget === w.key && dragKey !== w.key
                    return (
                      <tr
                        key={w.key}
                        draggable
                        onDragStart={() => setDragKey(w.key)}
                        onDragEnd={() => {
                          setDragKey(null)
                          setDropTarget(null)
                        }}
                        onDragOver={(e) => {
                          e.preventDefault()
                          setDropTarget(w.key)
                        }}
                        onDrop={(e) => {
                          e.preventDefault()
                          if (dragKey) doMerge(dragKey, w.key)
                        }}
                        className={`border-t border-white/5 transition ${
                          isDropTarget
                            ? 'bg-violet-500/20 ring-1 ring-inset ring-violet-500/50'
                            : isSource
                              ? 'bg-violet-500/10'
                              : w.hidden
                                ? 'opacity-40'
                                : 'hover:bg-white/[0.03]'
                        }`}
                      >
                        <td className="px-4 py-2.5 tabular-nums text-slate-600">{i + 1}</td>
                        <td className="px-4 py-2.5">
                          <span
                            className={`font-semibold ${
                              w.hidden ? 'text-slate-500 line-through' : 'text-slate-100'
                            }`}
                          >
                            {w.text}
                          </span>
                          {w.hidden && (
                            <span className="ml-2 rounded bg-white/5 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-slate-500">
                              hidden
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-2.5 text-right tabular-nums font-bold text-slate-300">
                          {w.count}
                        </td>
                        <td className="px-4 py-2.5 text-right">
                          <div className="flex justify-end gap-1.5">
                            {mergeFrom && mergeFrom !== w.key ? (
                              <button
                                onClick={() => doMerge(mergeFrom, w.key)}
                                className="rounded-lg bg-violet-500/20 px-2.5 py-1 text-[11px] font-bold text-violet-300 ring-1 ring-violet-500/40 transition hover:bg-violet-500/30"
                              >
                                Merge into this
                              </button>
                            ) : (
                              <button
                                onClick={() => setMergeFrom(isSource ? null : w.key)}
                                className="rounded-lg px-2.5 py-1 text-[11px] font-semibold text-slate-500 transition hover:bg-white/5 hover:text-violet-300"
                              >
                                {isSource ? 'Cancel' : 'Merge'}
                              </button>
                            )}
                            <button
                              onClick={() => toggleHide(w)}
                              className={`rounded-lg px-2.5 py-1 text-[11px] font-semibold transition ${
                                w.hidden
                                  ? 'text-emerald-400 hover:bg-emerald-500/10'
                                  : 'text-slate-500 hover:bg-white/5 hover:text-amber-300'
                              }`}
                            >
                              {w.hidden ? 'Restore' : 'Hide'}
                            </button>
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            )}
          </div>

          <p className="mt-2 text-[11px] text-slate-600">
            Drag a row onto another to merge, or use the Merge button. Hiding removes a term from
            the screen without deleting its history.
          </p>

          {merged.length > 0 && (
            <div className="mt-3 rounded-2xl border border-white/5 p-3">
              <p className="mb-2 text-[10px] font-bold uppercase tracking-widest text-slate-600">
                Merged away
              </p>
              <div className="flex flex-wrap gap-1.5">
                {merged.map((w) => (
                  <span
                    key={w.key}
                    className="rounded-lg bg-white/5 px-2 py-1 text-[11px] text-slate-500"
                  >
                    {w.text} → <span className="text-slate-400">{w.mergedInto}</span>
                  </span>
                ))}
              </div>
            </div>
          )}
        </main>

        {/* ── Settings sidebar ── */}
        <aside className="flex w-[320px] flex-shrink-0 flex-col gap-4 overflow-y-auto border-l border-white/5 bg-[#080D17] p-5">
          <section>
            <h3 className="mb-3 text-[10px] font-bold uppercase tracking-[0.2em] text-slate-600">
              Submission rules
            </h3>

            <Toggle
              label="Allow multiple answers"
              hint="Off locks each participant to one answer, with a 5s undo."
              value={config.allowMultiple}
              onChange={(v) => patchConfig({ allowMultiple: v })}
            />

            <Toggle
              label="Group plurals"
              hint="Folds “Leaders” onto “Leader”."
              value={config.lemmatize}
              onChange={(v) => patchConfig({ lemmatize: v })}
            />

            <Slider
              label="Character limit"
              value={config.maxChars}
              min={25}
              max={50}
              onChange={(v) => patchConfig({ maxChars: v })}
            />

            <Slider
              label="Words shown on screen"
              value={config.topN}
              min={10}
              max={50}
              onChange={(v) => patchConfig({ topN: v })}
            />
          </section>

          <section>
            <h3 className="mb-2 text-[10px] font-bold uppercase tracking-[0.2em] text-slate-600">
              Banned terms
            </h3>
            <div className="flex gap-2">
              <input
                value={banDraft}
                onChange={(e) => setBanDraft(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && addBanned()}
                placeholder="add a term…"
                className="min-w-0 flex-1 rounded-xl border border-white/8 bg-white/5 px-3 py-2 text-xs text-white outline-none focus:border-pink-500/40"
              />
              <button
                onClick={addBanned}
                className="rounded-xl bg-white/5 px-3 py-2 text-xs font-bold text-slate-300 transition hover:bg-white/10"
              >
                Add
              </button>
            </div>
            {config.bannedTerms.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {config.bannedTerms.map((t) => (
                  <button
                    key={t}
                    onClick={() => removeBanned(t)}
                    className="group rounded-lg bg-red-500/10 px-2 py-1 text-[11px] text-red-300 ring-1 ring-red-500/20 transition hover:bg-red-500/20"
                  >
                    {t} <span className="text-red-500 group-hover:text-red-300">✕</span>
                  </button>
                ))}
              </div>
            )}
            <p className="mt-2 text-[10px] leading-relaxed text-slate-700">
              Matching answers are dropped silently — the participant still sees a success screen.
            </p>
          </section>

          <section className="flex-1">
            <h3 className="mb-2 text-[10px] font-bold uppercase tracking-[0.2em] text-slate-600">
              Audit log
            </h3>
            <div className="space-y-1.5">
              {audit.length === 0 ? (
                <p className="text-[11px] text-slate-700">No moderation actions yet.</p>
              ) : (
                audit.slice(0, 12).map((a, i) => (
                  <div key={`${a.at}-${i}`} className="rounded-lg bg-white/[0.03] px-2.5 py-1.5">
                    <p className="text-[11px] text-slate-400">{summarize(a)}</p>
                    <p className="text-[10px] text-slate-700">
                      {new Date(a.at).toLocaleTimeString()}
                    </p>
                  </div>
                ))
              )}
            </div>
          </section>

          <button
            onClick={() => {
              if (confirm('Clear every answer for this question? This cannot be undone.')) {
                getSocket().emit('reset_question')
              }
            }}
            className="flex-shrink-0 rounded-xl border border-white/5 py-2.5 text-xs font-medium text-slate-600 transition hover:border-red-500/30 hover:text-red-400"
          >
            Reset this question
          </button>
        </aside>
      </div>
    </div>
  )
}

// ── Small controls ────────────────────────────────────────────────────────────

function Toggle({
  label,
  hint,
  value,
  onChange,
}: {
  label: string
  hint?: string
  value: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <button
      onClick={() => onChange(!value)}
      className="mb-3 flex w-full items-start gap-3 rounded-xl border border-white/5 p-3 text-left transition hover:border-white/10"
    >
      <span
        className={`mt-0.5 flex h-5 w-9 flex-shrink-0 items-center rounded-full p-0.5 transition ${
          value ? 'bg-emerald-500/80' : 'bg-white/10'
        }`}
      >
        <span
          className={`h-4 w-4 rounded-full bg-white transition-transform ${
            value ? 'translate-x-4' : 'translate-x-0'
          }`}
        />
      </span>
      <span className="min-w-0">
        <span className="block text-xs font-semibold text-slate-200">{label}</span>
        {hint && <span className="mt-0.5 block text-[10px] leading-snug text-slate-600">{hint}</span>}
      </span>
    </button>
  )
}

function Slider({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string
  value: number
  min: number
  max: number
  onChange: (v: number) => void
}) {
  return (
    <div className="mb-3 rounded-xl border border-white/5 p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs font-semibold text-slate-200">{label}</span>
        <span className="tabular-nums text-xs font-bold text-pink-400">{value}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full accent-pink-500"
      />
    </div>
  )
}

function summarize(a: AuditEntry): string {
  const act = a.action
  switch (act.type) {
    case 'hide':
      return `Hid “${act.key}”`
    case 'restore':
      return `Restored “${act.key}”`
    case 'merge':
      return `Merged “${act.from}” → “${act.into}” (${a.detail?.movedVotes ?? 0} votes)`
    case 'lock':
      return act.locked ? 'Locked polling' : 'Unlocked polling'
    case 'reset':
      return 'Reset all answers'
    case 'config':
      return `Settings: ${Object.keys(act.patch).join(', ')}`
  }
}
