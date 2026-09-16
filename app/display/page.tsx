'use client'

import { useEffect, useState } from 'react'
import dynamic from 'next/dynamic'
import { QRCodeSVG } from 'qrcode.react'
import { getSocket, requestState } from '@/lib/socket'
import { DEFAULT_CONFIG, type AppState, type PollStats, type WordEntry } from '@/lib/types'

const WordCloud = dynamic(() => import('@/components/WordCloud'), { ssr: false })

/** Square side for the code: whatever the column can spare, capped. */
const QR_BOX = 'h-[min(100dvh-17rem,22rem)] w-[min(100dvh-17rem,22rem)] [&>svg]:h-full [&>svg]:w-full'

const LOGO = 'https://slido-content.s3.amazonaws.com/event/200/057/05/c2b76b14-small.png?ts=1777008390496'

export default function DisplayPage() {
  const [state, setState] = useState<AppState>({
    questionIndex: 0,
    question: '',
    totalQuestions: 8,
    words: [],
    config: DEFAULT_CONFIG,
    stats: { participants: 0, votes: 0, connected: 0 },
  })
  const [transitioning, setTransitioning] = useState(false)
  const [joinUrl, setJoinUrl] = useState('')
  const [responseCount, setResponseCount] = useState(0)

  useEffect(() => { setJoinUrl(window.location.origin + '/join') }, [])

  useEffect(() => {
    setResponseCount(state.stats.votes)
  }, [state.stats.votes])

  useEffect(() => {
    const socket = getSocket()
    const onState   = (d: AppState) => setState(d)
    const onUpdate  = ({ questionIndex, words, stats }: { questionIndex: number; words: WordEntry[]; stats: PollStats }) => {
      setState(prev => prev.questionIndex === questionIndex ? { ...prev, words, stats } : prev)
    }
    const onQChange = (d: AppState) => {
      setTransitioning(true)
      setTimeout(() => { setState(d); setTransitioning(false) }, 500)
    }
    const onConnect = () => socket.emit('get_state')

    socket.on('state',           onState)
    socket.on('word_update',     onUpdate)
    socket.on('question_change', onQChange)
    socket.on('connect',         onConnect)

    requestState()

    return () => {
      socket.off('state',           onState)
      socket.off('word_update',     onUpdate)
      socket.off('question_change', onQChange)
      socket.off('connect',         onConnect)
    }
  }, [])

  const { question, questionIndex, totalQuestions, words } = state

  return (
    <div className="flex h-screen overflow-hidden bg-[#070B14] font-sans text-white">

      {/* ── Left: question + cloud ── */}
      <div className="flex flex-1 flex-col overflow-hidden">

        {/* Top bar */}
        <div className="flex flex-shrink-0 items-center justify-between border-b border-white/5 bg-[#080D17] px-10 py-4">
          <img src={LOGO} alt="Fujifilm" className="h-9 w-auto object-contain brightness-0 invert opacity-80" />

          <div className="flex items-center gap-4">
            {/* Progress pills */}
            <div className="flex items-center gap-2">
              {Array.from({ length: totalQuestions }).map((_, i) => (
                <div key={i} className={`h-1.5 rounded-full transition-all duration-700 ${
                  i < questionIndex  ? 'w-4 bg-pink-500/40' :
                  i === questionIndex? 'w-8 bg-pink-500 shadow-[0_0_10px_rgba(236,72,153,0.7)]' :
                                      'w-4 bg-white/10'
                }`} />
              ))}
            </div>

            <div className="flex items-center gap-2 rounded-full bg-pink-500/10 border border-pink-500/20 px-4 py-1">
              <span className="live-dot h-1.5 w-1.5 rounded-full bg-pink-500" />
              <span className="text-sm font-bold text-pink-400">{responseCount}</span>
              <span className="text-xs text-slate-500">responses</span>
            </div>
          </div>
        </div>

        {/* Question */}
        <div
          className={`flex-shrink-0 px-10 py-7 border-b border-white/5 transition-all duration-500 ${
            transitioning ? 'opacity-0 -translate-y-3' : 'opacity-100 translate-y-0'
          }`}
        >
          <p className="mb-2 text-[11px] font-bold uppercase tracking-[0.25em] text-pink-500">
            Question {questionIndex + 1} of {totalQuestions}
          </p>
          <h1 className="text-4xl font-black leading-tight text-white">
            {question || <span className="text-slate-700">Loading…</span>}
          </h1>
        </div>

        {/* Word cloud */}
        <div
          className={`flex-1 overflow-hidden rounded-b-none transition-all duration-500 ${
            transitioning ? 'opacity-0 scale-95' : 'opacity-100 scale-100'
          }`}
        >
          <div className="h-full bg-white">
            <WordCloud words={words} topN={state.config.topN} stats={state.stats} />
          </div>
        </div>
      </div>

      {/* ── Right: QR panel ── */}
      <div className="relative flex w-[26rem] flex-shrink-0 flex-col items-center justify-center gap-5 border-l border-white/5 bg-[#080D17] px-8 py-10">

        <div className="flex items-center gap-2">
          <span className="live-dot h-1.5 w-1.5 rounded-full bg-emerald-400" />
          <span className="text-[10px] font-bold uppercase tracking-widest text-emerald-400">Live Session</span>
        </div>

        <p className="text-lg font-semibold text-slate-400 text-center">
          Scan to answer <span className="grad-text font-black">live</span>
        </p>

        {joinUrl ? (
          <div
            className="rounded-3xl p-[3px]"
            style={{ background: 'linear-gradient(135deg, #EC4899, #8B5CF6)' }}
          >
            <div className="rounded-[calc(1.5rem-3px)] bg-white p-4">
              <div className={QR_BOX}>
                <QRCodeSVG
                  value={joinUrl}
                  size={320}
                  bgColor="#ffffff"
                  fgColor="#070B14"
                  level="H"
                  marginSize={1}
                />
              </div>
            </div>
          </div>
        ) : (
          <div className={`animate-pulse rounded-3xl bg-white/5 ${QR_BOX}`} />
        )}

        {/* Absolute so the logo can't pull the code off centre. */}
        <img
          src={LOGO}
          alt="Fujifilm"
          className="absolute bottom-8 h-8 w-auto object-contain brightness-0 invert opacity-20"
        />
      </div>
    </div>
  )
}
