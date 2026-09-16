'use client'

import { useEffect, useState, useRef } from 'react'
import dynamic from 'next/dynamic'
import { QRCodeSVG } from 'qrcode.react'
import { getSocket, requestState } from '@/lib/socket'
import { DEFAULT_CONFIG, type AppState, type PollStats, type WordEntry } from '@/lib/types'

const WordCloud = dynamic(() => import('@/components/WordCloud'), { ssr: false })

const LOGO = 'https://slido-content.s3.amazonaws.com/event/200/057/05/c2b76b14-small.png?ts=1777008390496'

export default function PresenterPage() {
  const [state, setState] = useState<AppState>({
    questionIndex: 0,
    question: '',
    totalQuestions: 7,
    words: [],
    config: DEFAULT_CONFIG,
    stats: { participants: 0, votes: 0, connected: 0 },
  })
  const [joinUrl, setJoinUrl]       = useState('')
  const [displayUrl, setDisplayUrl] = useState('')
  const [responseCount, setResponseCount] = useState(0)
  const [flash, setFlash]           = useState(false)
  const [connected, setConnected]   = useState(false)
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    setJoinUrl(window.location.origin + '/join')
    setDisplayUrl(window.location.origin + '/display')
  }, [])

  useEffect(() => {
    setResponseCount(state.stats.votes)
  }, [state.stats.votes])

  useEffect(() => {
    const socket = getSocket()

    const onState   = (d: AppState) => { setState(d); setConnected(true) }
    const onUpdate  = ({ questionIndex, words, stats }: { questionIndex: number; words: WordEntry[]; stats: PollStats }) => {
      setState(prev => prev.questionIndex === questionIndex ? { ...prev, words, stats } : prev)
      setFlash(true)
      if (flashTimer.current) clearTimeout(flashTimer.current)
      flashTimer.current = setTimeout(() => setFlash(false), 700)
    }
    const onQChange = (d: AppState) => setState(d)
    const onConnect = () => { setConnected(true); socket.emit('get_state') }
    const onDisconnect = () => setConnected(false)

    socket.on('state',           onState)
    socket.on('word_update',     onUpdate)
    socket.on('question_change', onQChange)
    socket.on('connect',         onConnect)
    socket.on('disconnect',      onDisconnect)

    // Always pull fresh state on mount (handles singleton already-connected case)
    requestState()

    return () => {
      socket.off('state',           onState)
      socket.off('word_update',     onUpdate)
      socket.off('question_change', onQChange)
      socket.off('connect',         onConnect)
      socket.off('disconnect',      onDisconnect)
    }
  }, [])

  function next()  { getSocket().emit('next_question') }
  function prev()  { getSocket().emit('prev_question') }
  function reset() { if (confirm('Clear all answers for this question?')) getSocket().emit('reset_question') }

  const { questionIndex, question, totalQuestions, words } = state

  return (
    <div className="flex h-screen flex-col bg-[#070B14] font-sans text-slate-100 overflow-hidden page-fade">

      {/* ── Top bar ── */}
      <header className="flex flex-shrink-0 items-center justify-between border-b border-white/5 bg-[#080D17] px-8 py-3">
        {/* Logo */}
        <img src={LOGO} alt="Fujifilm" className="h-9 w-auto object-contain brightness-0 invert opacity-90" />

        {/* Question dots */}
        <div className="flex items-center gap-3">
          {Array.from({ length: totalQuestions }).map((_, i) => (
            <div key={i} className="flex items-center gap-1.5">
              <div className={`h-2 rounded-full transition-all duration-500 ${
                i < questionIndex  ? 'w-2 bg-pink-500/40' :
                i === questionIndex? 'w-6 bg-pink-500 shadow-[0_0_8px_rgba(236,72,153,0.8)]' :
                                    'w-2 bg-white/10'
              }`} />
            </div>
          ))}
          <span className="ml-2 text-sm text-slate-500">
            <span className="text-slate-300 font-semibold">{questionIndex + 1}</span>/{totalQuestions}
          </span>
        </div>

        {/* Right: live stats */}
        <div className="flex items-center gap-5">
          <div className="flex items-center gap-2">
            <span className={`live-dot h-2 w-2 rounded-full ${connected ? 'bg-emerald-400' : 'bg-red-400'}`} />
            <span className={`text-xs font-semibold uppercase tracking-widest ${connected ? 'text-emerald-400' : 'text-red-400'}`}>
              {connected ? 'Live' : 'Offline'}
            </span>
          </div>
          <div className={`flex items-center gap-2 rounded-full px-4 py-1.5 transition-all duration-500 ${
            flash ? 'bg-pink-500/20 ring-1 ring-pink-500/50' : 'bg-white/5'
          }`}>
            <span className={`text-xl font-black tabular-nums transition-colors duration-300 ${flash ? 'text-pink-400' : 'text-slate-200'}`}>
              {responseCount}
            </span>
            <span className="text-xs text-slate-500">responses</span>
          </div>
          <a
            href={displayUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1.5 rounded-full border border-white/10 px-3 py-1.5 text-xs text-slate-400 transition hover:border-violet-500/50 hover:text-violet-400"
          >
            <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" /></svg>
            Big Screen
          </a>
        </div>
      </header>

      {/* ── Body ── */}
      <div className="flex flex-1 overflow-hidden">

        {/* Word cloud area */}
        <main className="flex flex-1 flex-col gap-4 overflow-hidden p-5">

          {/* Question card */}
          <div className="grad-border flex-shrink-0">
            <div className="rounded-[calc(1rem-1px)] bg-[#0D1525] px-6 py-4">
              <p className="mb-1 text-[10px] font-bold uppercase tracking-[0.2em] text-pink-500">
                Question {questionIndex + 1} of {totalQuestions}
              </p>
              <h1 className="text-2xl font-bold leading-snug text-slate-100">
                {question || <span className="text-slate-600">Loading…</span>}
              </h1>
            </div>
          </div>

          {/* Word cloud */}
          <div className="grad-border flex-1 overflow-hidden">
            <div className="h-full rounded-[calc(1rem-1px)] bg-white overflow-hidden shadow-inner">
              <WordCloud words={words} topN={state.config.topN} stats={state.stats} />
            </div>
          </div>
        </main>

        {/* ── Sidebar ── */}
        <aside className="flex w-[300px] flex-shrink-0 flex-col gap-4 overflow-y-auto border-l border-white/5 bg-[#080D17] p-5">

          {/* QR Code */}
          <div className="grad-border">
            <div className="flex flex-col items-center gap-3 rounded-[calc(1rem-1px)] bg-[#0D1525] p-4">
              <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-slate-500">Scan to Join</p>
              {joinUrl ? (
                <div className="rounded-2xl bg-white p-3 shadow-[0_0_30px_rgba(236,72,153,0.2)]">
                  <QRCodeSVG value={joinUrl} size={176} bgColor="#ffffff" fgColor="#0a0e1a" level="H" marginSize={1} />
                </div>
              ) : (
                <div className="h-[176px] w-[176px] animate-pulse rounded-2xl bg-white/5" />
              )}
              <p className="break-all text-center text-[10px] leading-relaxed text-slate-600">{joinUrl}</p>
            </div>
          </div>

          <div className="flex-1" />

          {/* Controls */}
          <div className="flex-shrink-0 space-y-2 border-t border-white/5 pt-4">
            <div className="flex gap-2">
              <button onClick={prev} disabled={questionIndex === 0}
                className="flex-1 rounded-xl border border-white/8 py-2.5 text-sm font-medium text-slate-400 transition hover:border-white/15 hover:text-slate-200 disabled:cursor-not-allowed disabled:opacity-25">
                ← Prev
              </button>
              <button onClick={next} disabled={questionIndex === totalQuestions - 1}
                className="btn-primary flex-1 rounded-xl py-2.5 text-sm font-bold text-white disabled:cursor-not-allowed disabled:opacity-30">
                Next →
              </button>
            </div>
            <button onClick={reset}
              className="w-full rounded-xl border border-white/5 py-2 text-xs font-medium text-slate-600 transition hover:border-red-500/30 hover:text-red-400">
              Reset answers
            </button>
          </div>
        </aside>
      </div>
    </div>
  )
}
