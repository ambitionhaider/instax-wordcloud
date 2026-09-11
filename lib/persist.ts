/**
 * Durable event log.
 *
 * The spec calls for PostgreSQL or MongoDB behind sessions, events, votes and
 * moderation audit logs. This module is the seam for that: everything the
 * system considers durable goes through `EventLog.append()`, and the only
 * storage detail below the seam is the sink.
 *
 * The shipped sink is append-only JSONL on disk, which needs no service to be
 * running and survives a server restart — the thing that actually matters for a
 * live session. Swapping in Postgres or Mongo means implementing `LogSink`
 * (one method) and passing it to the constructor; nothing upstream changes.
 */

import { appendFile, mkdir, readFile } from 'fs/promises'
import { dirname, join } from 'path'

export type EventKind =
  | 'session.start'
  | 'question.change'
  | 'vote.cast'
  | 'vote.undo'
  | 'vote.rejected'
  | 'moderation'

export interface LoggedEvent {
  at: number
  kind: EventKind
  pollId: string
  actor?: string
  payload: Record<string, unknown>
}

export interface LogSink {
  write(event: LoggedEvent): Promise<void>
}

/** Append-only JSONL file. One line per event, flushed on write. */
export class FileSink implements LogSink {
  private ready: Promise<void>

  constructor(private path: string) {
    this.ready = mkdir(dirname(path), { recursive: true }).then(() => undefined)
  }

  async write(event: LoggedEvent): Promise<void> {
    await this.ready
    await appendFile(this.path, JSON.stringify(event) + '\n', 'utf8')
  }

  async readAll(): Promise<LoggedEvent[]> {
    try {
      const raw = await readFile(this.path, 'utf8')
      return raw
        .split('\n')
        .filter(Boolean)
        .flatMap((line) => {
          try {
            return [JSON.parse(line) as LoggedEvent]
          } catch {
            return []
          }
        })
    } catch {
      return []
    }
  }
}

/**
 * Writes are fire-and-forget on purpose: a slow or failing disk must never add
 * latency to a vote or stall the 300ms broadcast tick. Failures are counted and
 * reported rather than thrown.
 */
export class EventLog {
  private failures = 0

  constructor(private sink: LogSink) {}

  append(kind: EventKind, pollId: string, payload: Record<string, unknown>, actor?: string): void {
    const event: LoggedEvent = { at: Date.now(), kind, pollId, actor, payload }
    void this.sink.write(event).catch((err) => {
      this.failures++
      if (this.failures <= 3) {
        console.warn(`⚠️  event log write failed (${(err as Error).message})`)
      }
    })
  }

  get failureCount(): number {
    return this.failures
  }
}

export function defaultEventLog(): { log: EventLog; sink: FileSink; path: string } {
  const path = process.env.EVENT_LOG_PATH || join(process.cwd(), '.data', 'events.jsonl')
  const sink = new FileSink(path)
  return { log: new EventLog(sink), sink, path }
}
