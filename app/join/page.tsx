'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getSocket, participantId, requestState } from '@/lib/socket'
import { DEFAULT_CONFIG, type AppState, type SubmitResponse } from '@/lib/types'

const LOGO =
  'https://slido-content.s3.amazonaws.com/event/200/057/05/c2b76b14-small.png?ts=1777008390496'

/** Grace window for Undo/Edit after a locked (single-answer) submission. */
const UNDO_SECONDS = 5

interface Toast {
  id: number
  text: string
  tone: 'ok' | 'warn'
}

const EMPTY: AppState = {
  questionIndex: 0,
  question: '',
  totalQuestions: 5,
  words: [],
  config: DEFAULT_CONFIG,
  stats: { participants: 0, votes: 0, connected: 0 },
}

export default function JoinPage() {
  const [state, setState] = useState<AppState>(EMPTY)
  const [answer, setAnswer] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [connected, setConnected] = useState(false)
  const [changing, setChanging] = useState(false)
  const [toasts, setToasts] = useState<Toast[]>([])
  const [sentCount, setSentCount] = useState(0)
  const [serverError, setServerError] = useState<string | null>(null)

  /** Set once a single-answer participant has submitted — drives the locked card. */
  const [locked, setLocked] = useState<{ label: string; voteId?: string } | null>(null)
  const [undoLeft, setUndoLeft] = useState(0)

  const inputRef = useRef<HTMLInputElement>(null)
  const { config, question, questionIndex, totalQuestions } = state

  // ── Client-side validation, mirroring the server pipeline ──────────────────

  const trimmed = answer.trim().replace(/\s+/g, ' ')
  const wordCount = trimmed ? trimmed.split(' ').length : 0
  const charsLeft = config.maxChars - answer.length
  const tooManyWords = wordCount > config.maxWords
  const validationError = tooManyWords ? 'Please enter 1–3 words max.' : null
  const canSubmit =
    connected && !!trimmed && !tooManyWords && !config.locked && !submitting && !locked

  const pushToast = useCallback((text: string, tone: Toast['tone'] = 'ok') => {
    const id = Date.now() + Math.random()
    setToasts((t) => [...t.slice(-2), { id, text, tone }])
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 2200)
  }, [])

  // ── Socket ─────────────────────────────────────────────────────────────────

  useEffect(() => {
    const socket = getSocket()

    const onConnect = () => {
      setConnected(true)
      socket.emit('identify', { pid: participantId() })
      socket.emit('get_state')
    }
    const onDisconnect = () => setConnected(false)
    const onState = (d: AppState) => {
      setState(d)
      setConnected(true)
    }
    const onConfig = (c: AppState['config']) => setState((s) => ({ ...s, config: c }))

    const onQuestionChange = (d: AppState) => {
      setChanging(true)
      setTimeout(() => {
        setState(d)
        setAnswer('')
        setLocked(null)
        setSentCount(0)
        setServerError(null)
        setChanging(false)
        setTimeout(() => inputRef.current?.focus(), 80)
      }, 420)
    }

    socket.on('connect', onConnect)
    socket.on('disconnect', onDisconnect)
    socket.on('state', onState)
    socket.on('config_change', onConfig)
    socket.on('question_change', onQuestionChange)
    requestState()

    return () => {
      socket.off('connect', onConnect)
      socket.off('disconnect', onDisconnect)
      socket.off('state', onState)
      socket.off('config_change', onConfig)
      socket.off('question_change', onQuestionChange)
    }
  }, [])

  // ── Undo countdown ─────────────────────────────────────────────────────────

  useEffect(() => {
    if (!locked?.voteId || undoLeft <= 0) return
    const t = setTimeout(() => setUndoLeft((n) => n - 1), 1000)
    return () => clearTimeout(t)
  }, [locked, undoLeft])

  // ── Submit ─────────────────────────────────────────────────────────────────

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!canSubmit) return
    setSubmitting(true)
    setServerError(null)

    getSocket().emit('submit_answer', { answer: trimmed }, (res: SubmitResponse) => {
      setSubmitting(false)
      if (!res?.ok) {
        setServerError(res?.error ?? 'Could not submit. Try again.')
        pushToast(res?.error ?? 'Could not submit', 'warn')
        return
      }

      setSentCount((n) => n + 1)

      if (config.allowMultiple) {
        // Clear and keep focus so the mobile keyboard never drops.
        setAnswer('')
        inputRef.current?.focus()
        pushToast('Added to the cloud ✓')
      } else {
        setLocked({ label: res.label ?? trimmed, voteId: res.voteId })
        setUndoLeft(UNDO_SECONDS)
        inputRef.current?.blur()
      }
    })
  }

  function handleUndo() {
    const voteId = locked?.voteId
    if (!voteId) return
    getSocket().emit('undo_answer', { voteId }, (res: { ok: boolean; error?: string }) => {
      if (!res?.ok) {
        pushToast(res?.error ?? 'Undo failed', 'warn')
        setUndoLeft(0)
        return
      }
      setAnswer(locked?.label ?? '')
      setLocked(null)
      setSentCount((n) => Math.max(0, n - 1))
      pushToast('Answer withdrawn — edit and resubmit')
      setTimeout(() => inputRef.current?.focus(), 60)
    })
  }

  const charTone = useMemo(() => {
    if (charsLeft < 0) return 'text-red-400'
    if (charsLeft <= 8) return 'text-amber-400'
    return 'text-slate-600'
  }, [charsLeft])

  return (
    <div
      className="flex min-h-screen flex-col items-center justify-center p-4 font-sans"
      style={{
        background: 'radial-gradient(ellipse at top, #1a0533 0%, #0a0e1a 50%, #070B14 100%)',
      }}
    >
      {/* Toasts */}
      <div className="pointer-events-none fixed inset-x-0 top-4 z-50 flex flex-col items-center gap-2 px-4">
        {toasts.map((t) => (
          <div
            key={t.id}
            role="status"
            className={`toast-in rounded-full px-5 py-2.5 text-sm font-semibold shadow-lg backdrop-blur ${
              t.tone === 'ok'
                ? 'bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-500/30'
                : 'bg-amber-500/15 text-amber-300 ring-1 ring-amber-500/30'
            }`}
          >
            {t.text}
          </div>
        ))}
      </div>

      <div
        className={`w-full max-w-sm transition-all duration-500 ${
          changing ? 'scale-95 opacity-0' : 'scale-100 opacity-100'
        }`}
      >
        {/* Header */}
        <div className="mb-7 flex flex-col items-center gap-3">
          <img
            src={LOGO}
            alt="Fujifilm"
            className="h-10 w-auto object-contain opacity-80 brightness-0 invert"
          />
          <div className="flex items-center gap-3">
            <span className="text-xs text-slate-600">
              Q {questionIndex + 1}/{totalQuestions}
            </span>
            <span className="h-3 w-px bg-white/10" />
            <span
              className={`flex items-center gap-1.5 text-xs ${
                connected ? 'text-emerald-400' : 'text-slate-600'
              }`}
            >
              <span
                className={`live-dot h-1.5 w-1.5 rounded-full ${
                  connected ? 'bg-emerald-400' : 'bg-slate-600'
                }`}
              />
              {connected ? 'Live' : 'Connecting…'}
            </span>
          </div>
        </div>

        {/* Question */}
        <div
          className="mb-5 rounded-3xl p-[1px]"
          style={{
            background:
              'linear-gradient(135deg, rgba(236,72,153,0.4), rgba(139,92,246,0.2), rgba(255,255,255,0.05))',
          }}
        >
          <div className="rounded-[calc(1.5rem-1px)] bg-[#0D1525] px-7 py-6">
            <p className="mb-2 text-[10px] font-bold uppercase tracking-[0.2em] text-pink-500">
              Your answer
            </p>
            {question ? (
              <h1 className="text-lg font-bold leading-snug text-slate-100">{question}</h1>
            ) : (
              <div className="space-y-2">
                <div className="h-4 animate-pulse rounded-full bg-white/5" />
                <div className="h-4 w-3/4 animate-pulse rounded-full bg-white/5" />
              </div>
            )}
          </div>
        </div>

        {/* Polling closed */}
        {config.locked && !locked && (
          <div className="mb-4 rounded-2xl border border-amber-500/25 bg-amber-500/10 px-5 py-4 text-center">
            <p className="text-sm font-bold text-amber-300">Polling is closed</p>
            <p className="mt-1 text-xs text-amber-200/60">
              The results are frozen on the big screen.
            </p>
          </div>
        )}

        {locked ? (
          /* ── Locked submission card with Undo/Edit grace window ── */
          <div className="page-fade space-y-3">
            <div
              className="rounded-2xl p-[1px]"
              style={{ background: 'linear-gradient(135deg, #10B981, #059669)' }}
            >
              <div className="rounded-[calc(1rem-1px)] bg-[#0D1525] px-6 py-5 text-center">
                <div className="mb-2 text-2xl">✓</div>
                <p className="text-xs uppercase tracking-widest text-slate-500">Your answer</p>
                <p className="mt-1 truncate text-xl font-black text-white">{locked.label}</p>
                <p className="mt-2 text-xs text-emerald-400">Locked in — one answer per person</p>
              </div>
            </div>

            {undoLeft > 0 ? (
              <button
                onClick={handleUndo}
                className="w-full rounded-2xl border border-white/10 py-3.5 text-sm font-semibold text-slate-300 transition hover:border-pink-500/40 hover:text-pink-300"
              >
                Undo / Edit
                <span className="ml-2 tabular-nums text-slate-600">{undoLeft}s</span>
              </button>
            ) : (
              <p className="text-center text-xs text-slate-700">
                Edit window closed. Your answer is on the big screen.
              </p>
            )}
          </div>
        ) : (
          /* ── Input form ── */
          <form onSubmit={handleSubmit} className="space-y-3">
            <div className="relative">
              <input
                ref={inputRef}
                type="text"
                value={answer}
                onChange={(e) => {
                  setAnswer(e.target.value)
                  setServerError(null)
                }}
                placeholder="Your answer (1-3 words work best)"
                maxLength={config.maxChars}
                autoComplete="off"
                autoCorrect="off"
                spellCheck={false}
                enterKeyHint="send"
                disabled={!connected || config.locked}
                aria-invalid={!!validationError}
                aria-describedby="answer-help"
                className={`w-full rounded-2xl border bg-white/5 px-5 py-4 text-center text-lg font-semibold text-white outline-none transition-all duration-200 placeholder:text-sm placeholder-slate-700 focus:bg-white/8 focus:ring-2 disabled:opacity-40 ${
                  validationError
                    ? 'border-amber-500/50 focus:border-amber-500/60 focus:ring-amber-500/20'
                    : 'border-white/8 focus:border-pink-500/50 focus:ring-pink-500/20'
                }`}
              />
            </div>

            {/* Live counters + validation */}
            <div id="answer-help" className="flex items-center justify-between px-1 text-xs">
              <span className={validationError ? 'font-semibold text-amber-400' : 'text-slate-600'}>
                {validationError ??
                  (wordCount > 0
                    ? `${wordCount} word${wordCount === 1 ? '' : 's'}`
                    : 'Compound phrases stay together')}
              </span>
              <span className={`tabular-nums ${charTone}`}>{charsLeft} left</span>
            </div>

            {serverError && (
              <p className="rounded-xl bg-red-500/10 px-4 py-2.5 text-center text-xs font-semibold text-red-300 ring-1 ring-red-500/20">
                {serverError}
              </p>
            )}

            <button
              type="submit"
              disabled={!canSubmit}
              className="btn-primary w-full rounded-2xl py-4 text-base font-bold text-white shadow-lg disabled:cursor-not-allowed disabled:opacity-30"
            >
              {submitting ? (
                <span className="flex items-center justify-center gap-2">
                  <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
                    <circle
                      className="opacity-25"
                      cx="12"
                      cy="12"
                      r="10"
                      stroke="currentColor"
                      strokeWidth="4"
                    />
                    <path
                      className="opacity-75"
                      fill="currentColor"
                      d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                    />
                  </svg>
                  Sending…
                </span>
              ) : (
                'Submit Answer →'
              )}
            </button>

            {config.allowMultiple && sentCount > 0 && (
              <p className="text-center text-xs text-emerald-400/70">
                {sentCount} answer{sentCount === 1 ? '' : 's'} sent — add as many as you like
              </p>
            )}
          </form>
        )}

        <p className="mt-8 text-center text-xs text-slate-700">
          Your answers appear live on the big screen
        </p>
      </div>
    </div>
  )
}
