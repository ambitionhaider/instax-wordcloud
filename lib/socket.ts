'use client'

import { io, type Socket } from 'socket.io-client'

const PID_KEY = 'wordcloud.participantId'

/**
 * UUID v4 that works on insecure origins.
 *
 * `crypto.randomUUID()` is restricted to secure contexts — HTTPS or localhost.
 * Participants scanning the QR code reach the app over `http://<lan-ip>`, which
 * is NOT a secure context, so calling it directly throws
 * "crypto.randomUUID is not a function" and takes down every phone in the room.
 *
 * `crypto.getRandomValues()` carries no such restriction, so it is the fallback
 * that actually matters; the Math.random() path is a last resort for ancient
 * browsers and is not relied on for anything security-sensitive (this id only
 * distinguishes anonymous poll participants).
 */
function uuid(): string {
  const c: Crypto | undefined = globalThis.crypto

  if (typeof c?.randomUUID === 'function') return c.randomUUID()

  if (typeof c?.getRandomValues === 'function') {
    const b = c.getRandomValues(new Uint8Array(16))
    b[6] = (b[6] & 0x0f) | 0x40 // version 4
    b[8] = (b[8] & 0x3f) | 0x80 // variant 10xx
    const hex = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
  }

  return `pid-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/**
 * Stable per-browser participant id. It is what "Allow multiple answers: No"
 * enforces against, and what scopes an undo to its own submission. localStorage
 * survives a refresh; a private window or cleared storage reads as a new
 * participant, which is the correct failure mode for an anonymous poll.
 */
export function participantId(): string {
  if (typeof window === 'undefined') return ''
  try {
    let id = localStorage.getItem(PID_KEY)
    if (!id) {
      id = uuid()
      localStorage.setItem(PID_KEY, id)
    }
    return id
  } catch {
    // Storage blocked — fall back to a per-session id held in memory.
    return (memoryPid ??= uuid())
  }
}

let memoryPid: string | undefined
let socket: Socket | null = null

export function getSocket(): Socket {
  if (!socket) {
    socket = io({
      path: '/socket.io',
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 500,
      timeout: 5000,
      query: { pid: participantId() },
    })
  }
  return socket
}

/** Pulls fresh state whether or not the shared socket is already connected. */
export function requestState() {
  const s = getSocket()
  const ask = () => {
    s.emit('identify', { pid: participantId() })
    s.emit('get_state')
  }
  if (s.connected) ask()
  else s.once('connect', ask)
}
