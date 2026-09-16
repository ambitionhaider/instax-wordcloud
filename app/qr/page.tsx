'use client'

import { useEffect, useState } from 'react'
import { QRCodeSVG } from 'qrcode.react'

const LOGO = 'https://slido-content.s3.amazonaws.com/event/200/057/05/c2b76b14-small.png?ts=1777008390496'

/**
 * Projector screen: nothing but the join QR, as large as the viewport allows.
 * The SVG is stretched by CSS rather than sized in JS so it reflows on resize
 * without a listener.
 */
export default function QrPage() {
  const [joinUrl, setJoinUrl] = useState('')

  useEffect(() => { setJoinUrl(window.location.origin + '/join') }, [])

  return (
    <div className="flex h-dvh w-screen flex-col items-center justify-center gap-8 overflow-hidden bg-[#070B14] px-8 py-10">

      <div className="flex items-center gap-2.5">
        <span className="live-dot h-2 w-2 rounded-full bg-emerald-400" />
        <span className="text-sm font-bold uppercase tracking-[0.25em] text-emerald-400">Live Session</span>
      </div>

      <p className="text-center text-3xl font-semibold text-slate-300 sm:text-4xl">
        Scan to answer <span className="grad-text font-black">live</span>
      </p>

      {joinUrl ? (
        <div
          className="rounded-[2.5rem] p-[5px]"
          style={{ background: 'linear-gradient(135deg, #EC4899, #8B5CF6)' }}
        >
          <div className="rounded-[calc(2.5rem-5px)] bg-white p-5">
            <div className="h-[min(58vh,58vw)] w-[min(58vh,58vw)] [&>svg]:h-full [&>svg]:w-full">
              <QRCodeSVG
                value={joinUrl}
                size={512}
                bgColor="#ffffff"
                fgColor="#070B14"
                level="H"
                marginSize={1}
              />
            </div>
          </div>
        </div>
      ) : (
        <div className="h-[min(58vh,58vw)] w-[min(58vh,58vw)] animate-pulse rounded-[2.5rem] bg-white/5" />
      )}

      <p className="break-all text-center text-xl font-medium tracking-wide text-slate-400 sm:text-2xl">
        {joinUrl}
      </p>

      <img src={LOGO} alt="Fujifilm" className="h-9 w-auto object-contain opacity-20 brightness-0 invert" />
    </div>
  )
}
