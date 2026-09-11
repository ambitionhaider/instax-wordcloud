'use client'

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { PollStats, WordEntry } from '@/lib/types'

/**
 * Presenter word cloud.
 *
 * Placement is a center-weighted Archimedean spiral (r = a + b·θ) with
 * axis-aligned rectangle collision. The spiral is walked directly rather than
 * handed to d3-cloud because two requirements need control d3-cloud does not
 * expose: the #1 term must land exactly at (0,0), and an existing word that
 * merely gains votes must keep its coordinates so it can scale in place.
 *
 * Re-layout is therefore conditional. A full spiral pass runs only when the
 * Top-N membership changes or a re-sized word starts overlapping a neighbour;
 * otherwise only the font size changes and CSS transitions the rest.
 */

// Spec: minFont 14px, maxFont 72-80px.
const MIN_FONT = 14
const MAX_FONT = 76

interface Placed {
  key: string
  text: string
  count: number
  x: number
  y: number
  w: number
  h: number
  size: number
  rank: number
}

interface Box {
  x: number
  y: number
  w: number
  h: number
}

const PAD_X = 14
const PAD_Y = 8

function overlaps(a: Box, b: Box): boolean {
  return (
    Math.abs(a.x - b.x) * 2 < a.w + b.w + PAD_X &&
    Math.abs(a.y - b.y) * 2 < a.h + b.h + PAD_Y
  )
}

/**
 * Non-linear font scaling. Square-root dampening keeps a runaway outlier from
 * eclipsing everything else: at 4x the votes a term is only 2x the excess size.
 */
export function fontSizeFor(count: number, minCount: number, maxCount: number): number {
  if (maxCount <= minCount) return (MIN_FONT + MAX_FONT) / 2
  const t = Math.sqrt((count - minCount) / (maxCount - minCount))
  return MIN_FONT + (MAX_FONT - MIN_FONT) * t
}

/** Rank-based colour ramp — dominant terms read darkest. */
function tier(rank: number, total: number): { color: string; bg: string } {
  const t = rank / Math.max(total - 1, 1)
  if (t < 0.15) return { color: '#1e3a5f', bg: 'rgba(30,58,95,0.10)' }
  if (t < 0.35) return { color: '#0e8fa8', bg: 'rgba(14,143,168,0.12)' }
  if (t < 0.58) return { color: '#3a6fa8', bg: 'rgba(58,111,168,0.09)' }
  if (t < 0.78) return { color: '#6b82a0', bg: 'rgba(107,130,160,0.08)' }
  return { color: '#9baab8', bg: 'rgba(155,170,184,0.07)' }
}

function weightFor(rank: number, total: number): number {
  if (rank === 0) return 800
  if (rank < total * 0.25) return 700
  if (rank < total * 0.6) return 600
  return 500
}

const FONT_STACK = 'Inter, system-ui, sans-serif'

/** Canvas text measurement — synchronous and far cheaper than DOM reflow. */
function makeMeasurer() {
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')!
  return (text: string, size: number, weight: number, count: number) => {
    ctx.font = `${weight} ${size}px ${FONT_STACK}`
    let width = ctx.measureText(text).width
    if (count > 1) {
      // The "xN" badge is rendered inside the same chip, so it counts toward
      // the collision box or tall stacks would overlap their neighbours.
      ctx.font = `500 ${size * 0.45}px ${FONT_STACK}`
      width += size * 0.18 + ctx.measureText(`\u00d7${count}`).width
    }
    return {
      w: width + size * 0.76, // + horizontal chip padding
      h: size * 1.52,         // + vertical chip padding
    }
  }
}

export interface WordCloudProps {
  words: WordEntry[]
  /** Cap on rendered terms. Spec: 30-50. */
  topN?: number
  stats?: PollStats
  /** Hide the metadata bar on surfaces that show counts elsewhere. */
  showMeta?: boolean
}

export default function WordCloud({ words, topN = 40, stats, showMeta = true }: WordCloudProps) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const [dims, setDims] = useState({ w: 0, h: 0 })
  const [placed, setPlaced] = useState<Placed[]>([])
  const [entering, setEntering] = useState<Set<string>>(new Set())
  const [bumped, setBumped] = useState<Set<string>>(new Set())

  const measureRef = useRef<ReturnType<typeof makeMeasurer> | null>(null)
  const placedRef = useRef<Placed[]>([])
  const prevCounts = useRef<Map<string, number>>(new Map())

  placedRef.current = placed

  // ── Container size ────────────────────────────────────────────────────────

  useLayoutEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect()
      if (r.width > 0 && r.height > 0) {
        setDims({ w: Math.floor(r.width), h: Math.floor(r.height) })
      }
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // ── Top-N slice ───────────────────────────────────────────────────────────

  const visible = useMemo(() => {
    return [...words]
      .filter((w) => !w.hidden && w.count > 0)
      .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))
      .slice(0, topN)
  }, [words, topN])

  // ── Layout ────────────────────────────────────────────────────────────────

  useEffect(() => {
    if (!dims.w || !dims.h) return
    if (!measureRef.current) measureRef.current = makeMeasurer()
    const measure = measureRef.current

    if (!visible.length) {
      setPlaced([])
      prevCounts.current = new Map()
      return
    }

    const maxCount = visible[0].count
    const minCount = visible[visible.length - 1].count
    const total = visible.length

    const sized = visible.map((w, rank) => {
      const size = fontSizeFor(w.count, minCount, maxCount)
      const weight = weightFor(rank, total)
      const { w: tw, h: th } = measure(w.text, size, weight, w.count)
      return { key: w.key, text: w.text, count: w.count, size, rank, w: tw, h: th }
    })

    // Which words are new, and which merely gained votes?
    const previous = new Map(placedRef.current.map((p) => [p.key, p]))
    const newKeys = sized.filter((s) => !previous.has(s.key)).map((s) => s.key)

    const grew = new Set<string>()
    for (const s of sized) {
      const before = prevCounts.current.get(s.key)
      if (before !== undefined && s.count > before) grew.add(s.key)
    }
    prevCounts.current = new Map(sized.map((s) => [s.key, s.count]))

    // Can we keep the existing coordinates? Only if membership is unchanged and
    // nothing has grown into a neighbour.
    const membershipStable =
      newKeys.length === 0 && placedRef.current.length === sized.length

    let reuse = false
    if (membershipStable) {
      const candidate = sized.map((s) => {
        const p = previous.get(s.key)!
        return { ...s, x: p.x, y: p.y }
      })
      // The top term must stay anchored at the centre even after a rank swap.
      const anchorHeld = candidate[0].x === 0 && candidate[0].y === 0
      let clash = false
      for (let i = 0; i < candidate.length && !clash; i++) {
        for (let j = i + 1; j < candidate.length; j++) {
          if (overlaps(candidate[i], candidate[j])) {
            clash = true
            break
          }
        }
      }
      if (anchorHeld && !clash) {
        setPlaced(candidate)
        reuse = true
      }
    }

    if (!reuse) {
      setPlaced(spiralLayout(sized, dims))
    }

    // Animation cues.
    if (newKeys.length) {
      setEntering(new Set(newKeys))
      setTimeout(() => setEntering(new Set()), 620)
    }
    if (grew.size) {
      setBumped(new Set(grew))
      setTimeout(() => setBumped(new Set()), 700)
    }
    // placedRef is a ref on purpose — including `placed` here would re-run the
    // layout against its own output every time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, dims])

  const total = visible.length

  // The wrapper element is rendered unconditionally so the ResizeObserver stays
  // attached to it. Branching to a separate empty-state element here would
  // leave the observer watching a detached node, and `dims` would never update
  // once the first answers arrived.
  return (
    <div ref={wrapRef} className="relative h-full w-full overflow-hidden bg-white">
      {!total && (
        <div className="flex h-full w-full items-center justify-center">
          <p className="animate-pulse text-lg font-light tracking-widest text-slate-300">
            Waiting for responses…
          </p>
        </div>
      )}
      {placed.map((p) => {
        const { color, bg } = tier(p.rank, total)
        const isNew = entering.has(p.key)
        const didGrow = bumped.has(p.key)
        return (
          <div
            key={p.key}
            style={{
              position: 'absolute',
              left: dims.w / 2 + p.x,
              top: dims.h / 2 + p.y,
              transform: 'translate(-50%,-50%)',
              fontSize: p.size,
              fontWeight: weightFor(p.rank, total),
              color,
              background: bg,
              padding: `${Math.round(p.size * 0.2)}px ${Math.round(p.size * 0.38)}px`,
              borderRadius: Math.round(p.size * 0.24),
              whiteSpace: 'nowrap',
              lineHeight: 1.12,
              userSelect: 'none',
              fontFamily: FONT_STACK,
              // Spring-ish easing so a vote bump reads as a pop, not a slide.
              transition:
                'font-size 0.62s cubic-bezier(0.34,1.56,0.64,1), left 0.62s cubic-bezier(0.4,0,0.2,1), top 0.62s cubic-bezier(0.4,0,0.2,1), color 0.4s ease, background 0.4s ease',
              animation: isNew
                ? 'wcEnter 0.6s cubic-bezier(0.34,1.56,0.64,1) both'
                : didGrow
                  ? 'wcBump 0.7s cubic-bezier(0.34,1.56,0.64,1)'
                  : undefined,
              zIndex: total - p.rank,
            }}
          >
            {p.text}
            {p.count > 1 && (
              <span
                style={{
                  fontSize: p.size * 0.45,
                  opacity: 0.4,
                  marginLeft: p.size * 0.18,
                  fontWeight: 500,
                }}
              >
                ×{p.count}
              </span>
            )}
          </div>
        )
      })}

      {/* Session metadata bar */}
      {showMeta && stats && (
        <div className="pointer-events-none absolute bottom-3 right-4 flex items-center gap-3 rounded-full bg-slate-900/5 px-4 py-1.5 text-[11px] font-semibold text-slate-500 backdrop-blur-sm">
          <span className="tabular-nums">
            <span className="text-slate-800">{stats.participants}</span> participants
          </span>
          <span className="h-3 w-px bg-slate-300" />
          <span className="tabular-nums">
            <span className="text-slate-800">{stats.votes}</span> votes
          </span>
          {words.length > total && (
            <>
              <span className="h-3 w-px bg-slate-300" />
              <span className="tabular-nums text-slate-400">top {total}</span>
            </>
          )}
        </div>
      )}

      <style>{`
        @keyframes wcEnter {
          0%   { opacity: 0; transform: translate(-50%,-50%) scale(0.3); }
          60%  { opacity: 1; }
          100% { opacity: 1; transform: translate(-50%,-50%) scale(1); }
        }
        @keyframes wcBump {
          0%   { transform: translate(-50%,-50%) scale(1); }
          35%  { transform: translate(-50%,-50%) scale(1.14); }
          100% { transform: translate(-50%,-50%) scale(1); }
        }
      `}</style>
    </div>
  )
}

// ── Archimedean spiral placement ──────────────────────────────────────────────

type Sized = Omit<Placed, 'x' | 'y'>

/**
 * Walks r = a + b·θ outward from the centre, placing each word at the first
 * position where its box clears everything already placed.
 *
 * x is stretched by the canvas aspect ratio so the cloud fills a 16:9 stage
 * instead of leaving wide margins. Words that cannot be placed within the
 * iteration budget are dropped rather than overlapped — falling out of view is
 * the documented behaviour for low-frequency terms.
 */
function spiralLayout(sized: Sized[], dims: { w: number; h: number }): Placed[] {
  const out: Placed[] = []
  const halfW = dims.w / 2
  const halfH = dims.h / 2
  const aspect = dims.w / Math.max(dims.h, 1)

  // b controls how fast the spiral opens; tie it to canvas size so the cloud
  // scales with the stage rather than clumping on large displays.
  const b = Math.max(2.2, Math.min(dims.w, dims.h) / 190)
  const dTheta = 0.22
  const MAX_THETA = 90 * Math.PI

  for (const s of sized) {
    // Rank 1 is anchored dead centre, unconditionally.
    if (out.length === 0) {
      out.push({ ...s, x: 0, y: 0 })
      continue
    }

    let placedIt = false
    for (let theta = 0; theta <= MAX_THETA; theta += dTheta) {
      const r = b * theta
      const x = r * Math.cos(theta) * aspect
      const y = r * Math.sin(theta)

      // Reject anything that would spill off the stage.
      if (Math.abs(x) + s.w / 2 > halfW || Math.abs(y) + s.h / 2 > halfH) continue

      const candidate = { x, y, w: s.w, h: s.h }
      if (out.some((p) => overlaps(candidate, p))) continue

      out.push({ ...s, x, y })
      placedIt = true
      break
    }

    if (!placedIt) {
      // No room at this size — the term falls out of view until its count rises.
      continue
    }
  }

  return out
}
