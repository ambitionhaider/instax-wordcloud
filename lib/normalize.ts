/**
 * Ingestion pipeline & normalization engine.
 *
 * Every submitted term runs through `normalize()` before it reaches the store.
 * Stages run in the order defined by the spec:
 *
 *   1. Sanitization       — strip HTML, newlines, edge whitespace, trailing punctuation
 *   2. Space collapsing   — consecutive internal whitespace -> single space
 *   3. Case folding       — lowercase aggregation key + Title Case display label
 *   4. Content guard      — profanity trie + host-defined banned terms
 *   5. Lemmatization      — optional plural grouping (Leader / Leaders)
 *
 * Compound phrases are preserved as a single entity throughout. Nothing here
 * ever tokenizes "machine learning" into two separate words.
 */

export interface NormalizeOptions {
  /** Max characters accepted after sanitization. Spec range: 25-50. */
  maxChars?: number
  /** Max distinct words accepted. Spec: reject above 4. */
  maxWords?: number
  /** Group simple plural suffixes onto their singular key. */
  lemmatize?: boolean
}

export type RejectReason = 'empty' | 'too_long' | 'too_many_words' | 'blocked'

export type NormalizeResult =
  | { ok: true; key: string; label: string; words: number }
  | { ok: false; reason: RejectReason; message: string }

export const DEFAULTS: Required<NormalizeOptions> = {
  maxChars: 50,
  maxWords: 4,
  lemmatize: true,
}

// ── Stages 1 & 2: sanitization + space collapsing ─────────────────────────────

const CONTROL_CHARS = /[\x00-\x1f\x7f]/g

/** Strips HTML, control chars, collapses whitespace, trims edge punctuation. */
export function sanitize(raw: string): string {
  return raw
    // Script/style bodies are markup, not answers — drop tag AND content, or
    // "<script>alert(1)</script>" survives as the term "alert(1".
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')                 // remaining HTML tags
    .replace(/&[a-z]+;|&#\d+;/gi, ' ')        // HTML entities
    .replace(CONTROL_CHARS, ' ')              // control chars incl. newlines/tabs
    .replace(/\s+/g, ' ')                     // stage 2: collapse internal whitespace
    .trim()
    .replace(/^[^\p{L}\p{N}]+/u, '')          // leading punctuation
    .replace(/[^\p{L}\p{N}+#]+$/u, '')        // trailing punctuation (keeps "C++", "C#")
    .trim()
}

// ── Stage 4: content guard ────────────────────────────────────────────────────

interface TrieNode {
  children: Map<string, TrieNode>
  terminal: boolean
}

/**
 * Trie-based blocklist. Keeps the check O(len of input) regardless of how many
 * terms are banned, which matters when a host pastes in a long custom list.
 */
export class Blocklist {
  private root: TrieNode = { children: new Map(), terminal: false }
  private count = 0

  constructor(terms: string[] = []) {
    for (const t of terms) this.add(t)
  }

  add(term: string): void {
    const t = term.toLowerCase().trim()
    if (!t) return
    let node = this.root
    for (const ch of t) {
      let next = node.children.get(ch)
      if (!next) {
        next = { children: new Map(), terminal: false }
        node.children.set(ch, next)
      }
      node = next
    }
    if (!node.terminal) {
      node.terminal = true
      this.count++
    }
  }

  /** True if `text` contains any banned term as a substring run. */
  has(text: string): boolean {
    const s = text.toLowerCase()
    for (let i = 0; i < s.length; i++) {
      let node = this.root
      for (let j = i; j < s.length; j++) {
        const next = node.children.get(s[j])
        if (!next) break
        node = next
        if (node.terminal) return true
      }
    }
    return false
  }

  get size(): number {
    return this.count
  }
}

/**
 * Baseline profanity list. Deliberately short — the real defence is the
 * host-defined list, merged in per session.
 */
const BASE_PROFANITY = [
  'fuck', 'shit', 'bitch', 'cunt', 'asshole', 'bastard',
  'nigger', 'faggot', 'retard', 'whore', 'slut', 'nazi',
]

const baseBlocklist = new Blocklist(BASE_PROFANITY)

/** Folds leetspeak substitutions so the blocklist can't be trivially bypassed. */
function deleet(s: string): string {
  return s
    .replace(/[4@]/g, 'a')
    .replace(/3/g, 'e')
    .replace(/[1!|]/g, 'i')
    .replace(/0/g, 'o')
    .replace(/[5$]/g, 's')
    .replace(/7/g, 't')
}

export function isBlocked(key: string, hostBanned?: Blocklist): boolean {
  const folded = deleet(key)
  if (baseBlocklist.has(key) || baseBlocklist.has(folded)) return true
  if (hostBanned && (hostBanned.has(key) || hostBanned.has(folded))) return true
  return false
}

// ── Stage 5: lemmatization ────────────────────────────────────────────────────

/**
 * Conservative plural folding — only the regular English suffixes where a wrong
 * guess is unlikely. Words under 4 chars are left alone so "bus" and "gas"
 * survive intact.
 */
export function singularize(word: string): string {
  if (word.length < 4) return word
  if (/(ss|us|is)$/.test(word)) return word                     // process, status, basis
  if (/[^aeiou]ies$/.test(word)) return word.slice(0, -3) + 'y' // stories -> story
  if (/(ch|sh|s|x|z)es$/.test(word)) return word.slice(0, -2)   // boxes -> box
  if (/[^s]s$/.test(word)) return word.slice(0, -1)             // leaders -> leader
  return word
}

/** Applies singularization per token, preserving the phrase as one entity. */
export function lemmaKey(key: string): string {
  return key.split(' ').map(singularize).join(' ')
}

// ── Stage 3: display label casing ─────────────────────────────────────────────

const LOWER_WORDS = new Set([
  'a', 'an', 'and', 'at', 'but', 'by', 'for', 'in', 'of', 'on', 'or', 'the', 'to', 'vs',
])

/**
 * Title-cases a phrase for display. Tokens the user wrote in all-caps are kept
 * verbatim so acronyms survive: "AI" stays "AI", never "Ai".
 */
export function titleCase(raw: string): string {
  return raw
    .split(' ')
    .map((tok, i) => {
      if (!tok) return tok
      if (tok.length <= 4 && tok === tok.toUpperCase() && /[A-Z]/.test(tok)) return tok
      const lower = tok.toLowerCase()
      if (i > 0 && LOWER_WORDS.has(lower)) return lower
      return lower.charAt(0).toUpperCase() + lower.slice(1)
    })
    .join(' ')
}

// ── The pipeline ──────────────────────────────────────────────────────────────

export function countWords(s: string): number {
  const t = s.trim()
  return t ? t.split(/\s+/).length : 0
}

export function normalize(
  raw: string,
  opts: NormalizeOptions = {},
  hostBanned?: Blocklist,
): NormalizeResult {
  const maxChars = opts.maxChars ?? DEFAULTS.maxChars
  const maxWords = opts.maxWords ?? DEFAULTS.maxWords
  const lemma = opts.lemmatize ?? DEFAULTS.lemmatize

  if (typeof raw !== 'string') {
    return { ok: false, reason: 'empty', message: 'No answer provided.' }
  }

  const clean = sanitize(raw)
  if (!clean) {
    return { ok: false, reason: 'empty', message: 'No answer provided.' }
  }
  if (clean.length > maxChars) {
    return { ok: false, reason: 'too_long', message: `Keep it under ${maxChars} characters.` }
  }

  const words = countWords(clean)
  if (words > maxWords) {
    return { ok: false, reason: 'too_many_words', message: 'Please enter 1–3 words max.' }
  }

  const folded = clean.toLowerCase()
  if (isBlocked(folded, hostBanned)) {
    // Dropped silently per spec — the participant sees a normal success response.
    return { ok: false, reason: 'blocked', message: 'Answer submitted.' }
  }

  return {
    ok: true,
    key: lemma ? lemmaKey(folded) : folded,
    label: titleCase(clean),
    words,
  }
}
