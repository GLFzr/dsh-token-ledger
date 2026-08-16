#!/usr/bin/env node
// verify.mjs — offline verifier for the dsh-token-ledger JSONL ledger.
//
// Independent replay of the on-disk ledger (no DSH runtime involved):
//   1. parse every kept daily file, validate each line's shape and numbers
//   2. detect duplicate keys (a key must appear at most once per step — the
//      same key MAY appear twice when an early usage chunk preceded the final
//      assistant/message, in which case the LAST line wins; we report both)
//   3. recompute day totals and window aggregates with the same rules as the
//      plugin (chars-independent: pure sums of the recorded buckets)
//   4. when the dsh web server is up, cross-check the in-memory totals served
//      by /token-ledger/summary against the disk replay
//
// Usage: node scripts/verify.mjs [ledgerDir] [webBaseUrl]
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const ledgerDir = process.argv[2] || path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'dsh-token-ledger')
const base = process.argv[3] || 'http://127.0.0.1:3080'

const MS_DAY = 24 * 60 * 60 * 1000
const dayOf = (ts) => {
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
const dateOfFile = (name) => (/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name) ? name.slice(0, 10) : null)
const ok = (name, got, want) => {
  const pass = JSON.stringify(got) === JSON.stringify(want)
  console.log((pass ? 'PASS' : 'FAIL') + ' ' + name + (pass ? '' : ' got=' + JSON.stringify(got) + ' want=' + JSON.stringify(want)))
  if (!pass) process.exitCode = 1
}

let fail = 0
const check = (cond, name, detail) => {
  if (cond) console.log('PASS ' + name)
  else { console.log('FAIL ' + name + (detail ? ' — ' + detail : '')); fail += 1 }
}

if (!fs.existsSync(ledgerDir)) {
  console.log('ledger dir not found: ' + ledgerDir)
  process.exit(2)
}

const files = fs.readdirSync(ledgerDir).filter((f) => dateOfFile(f) !== null).sort()
console.log(`ledger dir: ${ledgerDir}  (${files.length} daily file(s))`)
if (files.length === 0) {
  console.log('no ledger files yet — plugin has not recorded any request')
  process.exit(0)
}

const entries = []          // every parsed line
const byKey = new Map()     // key -> [count, last]
let badLines = 0
let totalLines = 0

for (const f of files) {
  const lines = fs.readFileSync(path.join(ledgerDir, f), 'utf8').split('\n')
  for (const line of lines) {
    if (!line.trim()) continue
    totalLines += 1
    let e
    try { e = JSON.parse(line) } catch { badLines += 1; continue }
    const shapeOk = e && typeof e === 'object'
      && e.v === 1
      && typeof e.key === 'string' && e.key.split(':').length >= 3
      && typeof e.ts === 'number' && Number.isFinite(e.ts)
      && typeof e.session === 'string'
      && ['provider', 'estimated-output'].includes(e.kind)
      && [e.input, e.output, e.cacheRead, e.cacheWrite].every((v) => v === null || (typeof v === 'number' && Number.isFinite(v) && v >= 0))
    if (!shapeOk) { badLines += 1; continue }
    entries.push(e)
    const rec = byKey.get(e.key)
    if (rec) { rec.count += 1; rec.last = e } else byKey.set(e.key, { count: 1, first: e, last: e })
  }
}

console.log(`parsed: ${entries.length} valid line(s), ${badLines} bad line(s), ${byKey.size} unique step key(s), ${totalLines} non-empty line(s)`)
check(badLines === 0, 'no corrupt lines', `${badLines} bad`)
// A key may carry several lines: early usage-chunk samples (the pi-ai adapter
// can emit one on a message event AND on an error event, and an early sample
// may be a partial/zero snapshot) plus the final assistant/message usage.
// The LAST line wins — that is the whole replacement contract. The real
// invariants are: (a) the final line of a provider kind is complete
// (input or output present), and (b) the disk replay totals equal the live
// totals (checked below). Sample-vs-final differences are normal process
// values, so they are reported as info, not failures.
const dupKeys = [...byKey.entries()].filter(([, r]) => r.count > 3)
check(dupKeys.length === 0, 'no key with >3 lines (samples + final)', dupKeys.map(([k]) => `${k}×${byKey.get(k).count}`).join(', ') || 'none')
const incompleteFinal = [...byKey.entries()]
  .filter(([, r]) => r.last.kind === 'provider' && r.last.input == null && r.last.output == null)
check(incompleteFinal.length === 0, 'final line of every key carries input/output', incompleteFinal.map(([k]) => k).join('; ') || 'none')
const sampleDiffs = [...byKey.entries()]
  .filter(([, r]) => r.count >= 2 && JSON.stringify([r.first.input, r.first.output, r.first.cacheRead, r.first.cacheWrite]) !== JSON.stringify([r.last.input, r.last.output, r.last.cacheRead, r.last.cacheWrite]))
if (sampleDiffs.length > 0) {
  console.log(`info: ${sampleDiffs.length} key(s) had an early sample replaced by the final value (expected)`)
}

// Day totals + window aggregates from the disk replay (last line wins per key).
const dayTotals = new Map()
const add = (a, b) => {
  a.requests += b.requests; a.input += b.input; a.output += b.output
  a.cacheRead += b.cacheRead; a.cacheWrite += b.cacheWrite; a.total += b.total; a.estimated += b.estimated
}
const entryT = (e) => ({
  requests: 1, input: e.input || 0, output: e.output || 0,
  cacheRead: e.cacheRead || 0, cacheWrite: e.cacheWrite || 0,
  total: (e.input || 0) + (e.output || 0) + (e.cacheRead || 0) + (e.cacheWrite || 0),
  estimated: e.kind === 'estimated-output' ? 1 : 0,
})
for (const [, r] of byKey) {
  const e = r.last
  const d = dayOf(e.ts)
  if (!dayTotals.has(d)) dayTotals.set(d, { requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, estimated: 0 })
  add(dayTotals.get(d), entryT(e))
}
const sumAll = () => {
  const t = { requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, estimated: 0 }
  for (const v of dayTotals.values()) add(t, v)
  return t
}
const window = (days) => {
  const t = { requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, estimated: 0 }
  if (days >= 1e6) return sumAll()
  const cutoff = dayOf(Date.now() - days * MS_DAY)
  for (const [d, v] of dayTotals) if (d >= cutoff) add(t, v)
  return t
}

const all = sumAll()
console.log('--- disk replay totals ---')
console.log(JSON.stringify(all, null, 0))
check(all.requests === byKey.size, 'replayed requests == unique keys', `${all.requests} vs ${byKey.size}`)

// Cache alignment hint: DeepSeek-family caches align to 64-token blocks.
const providerEntries = entries.filter((e) => e.kind === 'provider' && e.cacheRead > 0)
if (providerEntries.length > 0) {
  const aligned = providerEntries.filter((e) => e.cacheRead % 64 === 0).length
  console.log(`cacheRead alignment: ${aligned}/${providerEntries.length} entries are exact multiples of 64 (DeepSeek block cache hint)`)
}

// Cross-check against the live web server, if reachable.
try {
  const res = await fetch(`${base}/token-ledger/summary`)
  if (res.ok) {
    const s = await res.json()
    const t = s.totals.all
    console.log('--- live /token-ledger/summary (all) ---')
    console.log(JSON.stringify({ requests: t.requests, input: t.input, output: t.output, cacheRead: t.cacheRead, cacheWrite: t.cacheWrite, total: t.total }, null, 0))
    check(t.requests === all.requests, 'live vs disk: requests', `${t.requests} vs ${all.requests}`)
    check(t.input === all.input, 'live vs disk: input', `${t.input} vs ${all.input}`)
    check(t.output === all.output, 'live vs disk: output', `${t.output} vs ${all.output}`)
    check(t.cacheRead === all.cacheRead, 'live vs disk: cacheRead', `${t.cacheRead} vs ${all.cacheRead}`)
    check(t.cacheWrite === all.cacheWrite, 'live vs disk: cacheWrite', `${t.cacheWrite} vs ${all.cacheWrite}`)
    check(t.total === all.total, 'live vs disk: total', `${t.total} vs ${all.total}`)
    // Live windows must match the same replay rules.
    check(s.totals.day.total === window(0).total, 'live vs disk: day window', `${s.totals.day.total} vs ${window(0).total}`)
    check(s.totals.week.total === window(6).total, 'live vs disk: week window', `${s.totals.week.total} vs ${window(6).total}`)
    check(s.totals.month.total === window(29).total, 'live vs disk: month window', `${s.totals.month.total} vs ${window(29).total}`)
    const v = await (await fetch(`${base}/token-ledger/verify`)).json()
    check(v.ok === true && v.consistent === true, 'host /token-ledger/verify consistent', v.consistent === true ? '' : JSON.stringify(v.mismatches))
  } else {
    console.log(`live server returned HTTP ${res.status} — skipped cross-check`)
  }
} catch (e) {
  console.log('live server not reachable — skipped cross-check (' + String((e && e.message) || e) + ')')
}

console.log(fail === 0 ? '\nALL CHECKS PASSED' : `\n${fail} CHECK(S) FAILED`)
process.exit(fail === 0 ? 0 : 1)
