// ── Shared wire types ─────────────────────────────────────────────────────────

export interface WordEntry {
  /** Lowercase aggregation key — the Redis sorted-set member. */
  key: string
  /** Display label (Title Case / preserved acronym). */
  text: string
  /** Vote count — the sorted-set score. */
  count: number
  /** Hidden by a host moderation action. Never sent to presenter/display. */
  hidden?: boolean
  /** Key this term was merged into, if any. */
  mergedInto?: string
}

export interface PollConfig {
  /** Host toggle: may a participant submit more than once? */
  allowMultiple: boolean
  /** Submissions frozen — cloud stays on screen. */
  locked: boolean
  /** Max characters a participant may submit (spec range 25-50). */
  maxChars: number
  /** Max distinct words before rejection. */
  maxWords: number
  /** Cap on rendered terms (spec: top 30-50). */
  topN: number
  /** Group simple plurals (Leader / Leaders). */
  lemmatize: boolean
  /** Host-defined banned terms, lowercase. */
  bannedTerms: string[]
}

export const DEFAULT_CONFIG: PollConfig = {
  allowMultiple: true,
  locked: false,
  maxChars: 50,
  maxWords: 4,
  topN: 40,
  lemmatize: true,
  bannedTerms: [],
}

export interface PollStats {
  /** Distinct participants that have submitted at least once. */
  participants: number
  /** Total accepted submissions. */
  votes: number
  /** Currently connected sockets in the room. */
  connected: number
}

export interface AppState {
  questionIndex: number
  question: string
  totalQuestions: number
  words: WordEntry[]
  config: PollConfig
  stats: PollStats
}

/** Full tally including hidden terms — host panel only. */
export interface HostState extends AppState {
  allWords: WordEntry[]
}

export type ModerationAction =
  | { type: 'hide'; key: string }
  | { type: 'restore'; key: string }
  | { type: 'merge'; from: string; into: string }
  | { type: 'lock'; locked: boolean }
  | { type: 'reset' }
  | { type: 'config'; patch: Partial<PollConfig> }

export interface AuditEntry {
  at: number
  pollId: string
  actor: string
  action: ModerationAction
  /** Snapshot of affected counts, so a merge can be explained after the fact. */
  detail?: Record<string, unknown>
}

export interface SubmitResponse {
  ok: boolean
  /** Present when rejected for a reason the participant should see. */
  error?: string
  /** The accepted display label, for the undo card. */
  label?: string
  /** Server-assigned id so the participant can undo within the grace window. */
  voteId?: string
}
