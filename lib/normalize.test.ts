/**
 * Pipeline checks. Run with: npm test
 * Cases are drawn from the examples named in the spec, plus the edges that the
 * pipeline is most likely to get wrong.
 */

import assert from 'assert'
import { Blocklist, normalize, sanitize, singularize, titleCase } from './normalize'

let passed = 0
let failed = 0

function check(name: string, fn: () => void) {
  try {
    fn()
    passed++
    console.log(`  ✓ ${name}`)
  } catch (err) {
    failed++
    console.log(`  ✗ ${name}\n      ${(err as Error).message}`)
  }
}

function ok(raw: string, opts = {}, banned?: Blocklist) {
  const r = normalize(raw, opts, banned)
  assert(r.ok, `expected "${raw}" to be accepted, got ${JSON.stringify(r)}`)
  return r as Extract<typeof r, { ok: true }>
}

console.log('\nSanitization')
check('strips edge whitespace and trailing punctuation', () => {
  assert.strictEqual(sanitize('  Teamwork! '), 'Teamwork')
})
check('collapses internal whitespace', () => {
  assert.strictEqual(sanitize('machine   learning'), 'machine learning')
})
check('strips HTML tags', () => {
  assert.strictEqual(sanitize('<b>bold</b>'), 'bold')
})
check('drops script bodies entirely', () => {
  assert.strictEqual(sanitize('<script>alert(1)</script>'), '')
  const r = normalize('<script>alert(1)</script>')
  assert(!r.ok && r.reason === 'empty')
})
check('strips newlines and tabs', () => {
  assert.strictEqual(sanitize('line\none\ttwo'), 'line one two')
})
check('keeps C++ intact', () => {
  assert.strictEqual(sanitize('C++'), 'C++')
})

console.log('\nCompound phrases')
check('"Machine Learning" stays one entity', () => {
  const r = ok('Machine Learning')
  assert.strictEqual(r.key, 'machine learning')
  assert.strictEqual(r.words, 2)
})
check('"Remote Work" stays one entity', () => {
  assert.strictEqual(ok('Remote Work').key, 'remote work')
})
check('casing variants collapse to one key', () => {
  assert.strictEqual(ok('REMOTE WORK').key, ok('remote work').key)
})

console.log('\nDisplay labels')
check('acronyms keep their casing', () => {
  assert.strictEqual(titleCase('AI'), 'AI')
})
check('ordinary words title-case', () => {
  assert.strictEqual(titleCase('remote work'), 'Remote Work')
})
check('small words stay lowercase mid-phrase', () => {
  assert.strictEqual(titleCase('work of art'), 'Work of Art')
})

console.log('\nValidation')
check('rejects more than 4 words with the spec message', () => {
  const r = normalize('one two three four five')
  assert(!r.ok)
  assert.strictEqual(r.reason, 'too_many_words')
  assert.strictEqual(r.message, 'Please enter 1–3 words max.')
})
check('rejects over the character limit', () => {
  const r = normalize('x'.repeat(60), { maxChars: 50 })
  assert(!r.ok && r.reason === 'too_long')
})
check('rejects empty and whitespace-only input', () => {
  assert(!normalize('   ').ok)
  assert(!normalize('').ok)
})

console.log('\nLemmatization')
check('Leader and Leaders share a key', () => {
  assert.strictEqual(ok('Leaders').key, ok('Leader').key)
})
check('boxes -> box', () => assert.strictEqual(singularize('boxes'), 'box'))
check('stories -> story', () => assert.strictEqual(singularize('stories'), 'story'))
check('does not maul "process" or "status"', () => {
  assert.strictEqual(singularize('process'), 'process')
  assert.strictEqual(singularize('status'), 'status')
})
check('short words are left alone', () => {
  assert.strictEqual(singularize('bus'), 'bus')
})
check('can be turned off', () => {
  assert.strictEqual(normalize('Leaders', { lemmatize: false }).ok && ok('Leaders', { lemmatize: false }).key, 'leaders')
})

console.log('\nContent guard')
check('blocks baseline profanity', () => {
  const r = normalize('shit')
  assert(!r.ok && r.reason === 'blocked')
})
check('catches leetspeak evasion', () => {
  const r = normalize('sh1t')
  assert(!r.ok && r.reason === 'blocked')
})
check('blocks host-defined terms', () => {
  const r = normalize('competitorname', {}, new Blocklist(['competitorname']))
  assert(!r.ok && r.reason === 'blocked')
})
check('clean answers pass the guard', () => {
  assert(normalize('Teamwork', {}, new Blocklist(['competitorname'])).ok)
})
check('blocklist trie reports its size', () => {
  assert.strictEqual(new Blocklist(['a', 'b', 'a']).size, 2)
})

console.log(`\n${passed} passed, ${failed} failed\n`)
process.exit(failed ? 1 : 0)
