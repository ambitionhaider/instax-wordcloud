'use client'

import { io, type Socket } from 'socket.io-client'

const PID_KEY = 'wordcloud.participantId'

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
      id = crypto.randomUUID()
      localStorage.setItem(PID_KEY, id)
    }
    return id
  } catch {
    // Storage blocked — fall back to a per-session id held in memory.
    return memoryPid ??= crypto.randomUUID()
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
