# Live Word Cloud

A real-time, Slido-style word cloud module. Four surfaces over one event-driven
server:

| Route | Surface | Purpose |
| --- | --- | --- |
| `/join` | Participant | Submit answers from a phone or desktop |
| `/display` | Big screen | Full-bleed cloud + QR code for the projector |
| `/presenter` | Operator console | Cloud, QR, question navigation |
| `/host` | Moderation panel | Tally, hide/merge, lock, settings, audit log |

```bash
npm install
npm run dev          # http://localhost:3000
PORT=3100 npm run dev
npm test             # normalization pipeline checks
npm run build        # production build
```

---

## Architecture

```
participant ──┐
              ├─ POST /api/poll/:id/submit ──┐
participant ──┘                              │
                                             ▼
                              normalization pipeline
                                             │
                                             ▼
                              store (memory | Redis ZSET)
                                             │
                          dirty set ─── 300ms tick ───► io.to(pollId)
                                             │
                                             ▼
                              event log (JSONL, append-only)
```

**Broadcast batching.** Votes never emit directly. A submission marks its poll
dirty and a single `BROADCAST_MS` (300ms) tick flushes one `word_update` per
poll, so a burst of 400 simultaneous answers costs one frame on the presenter
screen rather than 400. Verified: 12 concurrent submissions coalesce into 1
broadcast. Lock and config changes bypass the tick, since those must reach the
participant UI immediately.

**Rooms.** One Socket.io room per poll (`q0`, `q1`, …), plus a `:host` room that
receives the full tally including hidden terms. Advancing a question migrates
every connected socket to the new room.

---

## Ingestion pipeline (`lib/normalize.ts`)

Every term runs the same five stages before it reaches the store, whether it
arrives over REST or WebSocket:

1. **Sanitization** — strips HTML (script/style bodies removed whole), control
   characters, newlines, and edge punctuation. `"  Teamwork! "` → `Teamwork`.
   `C++` and `C#` survive intact.
2. **Space collapsing** — `"machine   learning"` → `"machine learning"`.
3. **Case folding** — the lowercase string is the aggregation key; the display
   label is Title Case with acronyms preserved (`AI` stays `AI`, never `Ai`).
   When a key arrives in several surface forms, the most frequently written form
   wins the label.
4. **Content guard** — trie-based blocklist, O(input length) regardless of list
   size, with leetspeak folding so `sh1t` is caught by the `shit` entry. Host
   terms merge in per session. Violations are dropped **silently**: the
   participant sees a normal success screen.
5. **Lemmatization** (configurable) — conservative plural folding.
   `Leaders` → `leader`, `boxes` → `box`, `stories` → `story`; `process`,
   `status` and words under 4 characters are left alone.

Compound phrases are preserved as a single entity at every stage — nothing ever
tokenizes `"Machine Learning"` into two words.

---

## Presenter canvas (`components/WordCloud.tsx`)

- **Archimedean spiral** `r = a + b·θ` with axis-aligned rectangle collision.
  The spiral is walked directly rather than delegated to `d3-cloud`, because two
  requirements need control `d3-cloud` does not expose: the #1 term must anchor
  at exactly `(0,0)`, and a word that merely gains votes must keep its
  coordinates so it can scale in place.
- **Top-N cap** (default 40, host-adjustable 10–50). Low-frequency terms fall
  out of view until their counts rise.
- **Square-root font scaling**
  `minFont + (maxFont - minFont) * sqrt((count - min) / (max - min))`,
  14px → 76px, so a runaway outlier cannot eclipse the rest.
- **Conditional re-layout.** A full spiral pass runs only when Top-N membership
  changes or a re-sized word overlaps a neighbour. Otherwise only `font-size`
  changes and CSS transitions handle the rest — existing words scale in place.
- **Session metadata bar** — participants and total votes, bottom corner.

---

## Moderation (`/host`)

- **Hide / Restore** — removes a term from the presenter screen without erasing
  history; the count is preserved and the term stays in the host tally.
- **Merge** — drag a row onto another, or use the Merge button. Counts combine
  (`AI` 10 + `Artificial Intelligence` 8 → 18) and the merge is recorded, so
  *later* submissions of the merged key route to the target automatically.
  Merge chains are followed with a bounded walk.
- **Lock polling** — freezes submissions while the cloud stays on screen.
- **Settings** — allow-multiple toggle, plural grouping, character limit
  (25–50), Top-N, and a host-defined banned-terms list.
- **Audit log** — every moderation action with actor, timestamp, and for merges
  the number of votes moved.

---

## Storage

**Counters.** `lib/store.ts` defines one async interface with two adapters:

- `MemoryStore` — the zero-config default.
- `RedisStore` — used automatically when `REDIS_URL` is set. Sorted sets give
  atomic `ZINCRBY` increments and O(log N) `ZREVRANGE` Top-N retrieval, and let
  several server processes share one poll.

```
poll:{id}:words         ZSET   member = key, score = votes
poll:{id}:labels        HASH   key -> display label
poll:{id}:labelfreq     HASH   key\0label -> times written
poll:{id}:hidden        SET    moderation-hidden keys
poll:{id}:merged        HASH   from -> into
poll:{id}:participants  SET    ids that have submitted
poll:{id}:votes         STRING total accepted submissions
poll:{id}:config        STRING JSON PollConfig
poll:{id}:audit         LIST   moderation entries (capped at 500)
```

If `REDIS_URL` is set but unreachable, the server logs a warning and falls back
to memory rather than refusing to start — a presenter should not lose their
session because Redis is down five minutes before the keynote.

**Durable events.** `lib/persist.ts` writes every session, vote, rejection and
moderation action to an append-only JSONL log (`.data/events.jsonl`, override
with `EVENT_LOG_PATH`). Writes are fire-and-forget so a slow disk never adds
latency to a vote or stalls the broadcast tick.

### Deviation from the brief

The brief specifies PostgreSQL or MongoDB for persistence. This ships the
`LogSink` seam and a file-backed implementation instead, because the app is a
single-binary presentation tool that must start with `npm run dev` and no
services running. Moving to Postgres or Mongo means implementing one method
(`LogSink.write`) and passing it to `EventLog` — nothing upstream changes.
Redis, by contrast, *is* wired up for real, since the counter semantics it
provides (atomic increments, cheap Top-N) are load-bearing.

---

## API

```
POST /api/poll/:id/submit   { answer, participantId }
  -> 200 { ok: true,  label, voteId, count }
  -> 400 { ok: false, error }

GET  /api/poll/:id
  -> 200 { pollId, words, config, stats }
```

### Socket events

| Direction | Event | Payload |
| --- | --- | --- |
| → server | `submit_answer` | `{ answer }` (acked) |
| → server | `undo_answer` | `{ voteId }` (acked, 5s window) |
| → server | `word:hide` / `word:restore` | `{ key }` |
| → server | `word:merge` | `{ from, into }` |
| → server | `poll:lock` | `{ locked }` |
| → server | `poll:config` | `{ patch }` |
| → server | `host:join`, `get_state`, `get_audit`, `next_question`, `prev_question`, `goto_question`, `reset_question` | |
| ← client | `state` / `question_change` | `AppState` |
| ← client | `word_update` | `{ pollId, questionIndex, words, stats }` (batched) |
| ← client | `host_state` | `AppState` + `allWords` |
| ← client | `config_change`, `audit_log`, `submit_result`, `undo_result` | |

---

## Participant rules

- Placeholder: *"Your answer (1-3 words work best)"*, live character countdown.
- More than 4 words is rejected client- and server-side with
  *"Please enter 1–3 words max."*
- **Allow multiple answers on** — the field clears, a success toast appears, and
  focus is retained so the mobile keyboard stays up.
- **Allow multiple answers off** — the input locks behind a submission card with
  a 5-second Undo/Edit countdown. Undo withdraws the vote and frees the
  participant to answer again. A participant id in `localStorage` enforces this
  across reloads; undo is scoped to its own submission.

---

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `REDIS_URL` | *(unset)* | Enables the Redis store |
| `EVENT_LOG_PATH` | `.data/events.jsonl` | Durable event log |
