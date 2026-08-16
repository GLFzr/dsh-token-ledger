// Smoke test for dsh-token-ledger host half: fake ctx + fake sessions,
// fold events, fire the live firehose, hit the summary route, assert totals.
import { apply } from '../lib/index.js'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'

const ledgerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-test-'))
const firehose = []
let handler = null

const sessions = []
const fakeSession = {
  id: 'sess-1',
  header: { cwd: 'E:\\dsh' },
  requestContext: () => ({ provider: 'opencode-go', model: 'deepseek-v4-flash' }),
  events: [
    { type: 'request/context', seq: 0, time: Date.now() - 100000, data: { provider: 'opencode-go', model: 'deepseek-v4-flash' } },
    { type: 'assistant/chunk', seq: 1, time: Date.now() - 90000, data: { turn: 0, step: 0, chunk: { type: 'usage', usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 200, cacheWriteTokens: 0 } } } },
    { type: 'assistant/message', seq: 2, time: Date.now() - 80000, data: { turn: 0, step: 0, message: { content: [{ type: 'text', text: 'hello world' }] }, usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 200, cacheWriteTokens: 0 } } },
    { type: 'assistant/message', seq: 3, time: Date.now() - 70000, data: { turn: 0, step: 1, message: { content: [{ type: 'text', text: 'hi' }] }, usage: { inputTokens: 300, outputTokens: 80, cacheReadTokens: 900 } } },
    { type: 'assistant/message', seq: 4, time: Date.now() - 60000, data: { turn: 0, step: 2, message: { content: [{ type: 'text', text: 'x'.repeat(400) }] } } },
  ],
}
sessions.push(fakeSession)

const ctx = {
  sessions: { list: () => sessions },
  webServer: { register: (spec) => { handler = spec.handler } },
  on: (name, fn) => { if (name === 'session/event') firehose.push(fn) },
  effect: (fn) => fn(),
}

apply(ctx, { ledgerDir })

// Live firehose: one more step after backfill.
firehose[0](fakeSession, {
  type: 'assistant/message', seq: 5, time: Date.now(),
  data: { turn: 0, step: 3, message: { content: [{ type: 'text', text: 'ok' }] }, usage: { inputTokens: 25, outputTokens: 10, cacheReadTokens: 50 } },
})

async function getSummary() {
  const body = await new Promise((resolve) => {
    handler({ method: 'GET', url: '/token-ledger/summary' }, {
      writeHead: () => {}, end: (b) => resolve(b),
    })
  })
  return JSON.parse(body)
}

const s = await getSummary()
const all = s.totals.all
const assert = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  console.log((ok ? 'PASS' : 'FAIL') + ' ' + name + ' got=' + JSON.stringify(got) + (ok ? '' : ' want=' + JSON.stringify(want)))
  if (!ok) process.exitCode = 1
}
assert('all.requests', all.requests, 4)
assert('all.input', all.input, 425)
assert('all.output', all.output, 244) // 50+80+104(estimate)+10
assert('all.cacheRead', all.cacheRead, 1150)
assert('all.cacheWrite', all.cacheWrite, 0)
assert('all.total', all.total, 1819)
assert('all.estimated', all.estimated, 1)
assert('day.total', s.totals.day.total, 1819)
assert('models[0]', { m: s.models[0].model, t: s.models[0].total }, { m: 'deepseek-v4-flash', t: 1819 })
assert('sessions[0]', { cwd: s.sessions[0].cwd, t: s.sessions[0].total }, { cwd: 'E:\\dsh', t: 1819 })
assert('days has today', s.days[s.days.length - 1].requests, 4)

// Entries endpoint.
const entriesBody = await new Promise((resolve) => {
  handler({ method: 'GET', url: '/token-ledger/entries?limit=10' }, {
    writeHead: () => {}, end: (b) => resolve(b),
  })
})
const e = JSON.parse(entriesBody)
assert('entries count (deduped keys)', e.entries.length, 4)
assert('entries keys', e.entries.map((x) => x.key).sort(), ['sess-1:0:0', 'sess-1:0:1', 'sess-1:0:2', 'sess-1:0:3'])
assert('entry kind estimate', e.entries.find((x) => x.key === 'sess-1:0:2').kind, 'estimated-output')

// Disk: 5 lines (step0 wrote chunk + message, same key), 1 file.
const files = fs.readdirSync(ledgerDir).filter((f) => f.endsWith('.jsonl'))
const lines = files.length ? fs.readFileSync(path.join(ledgerDir, files[0]), 'utf8').split('\n').filter(Boolean) : []
assert('disk lines', lines.length, 5)
assert('disk file count', files.length, 1)

// Reload idempotency: re-apply on a fresh ctx with the same ledger dir.
const firehose2 = []
let handler2 = null
const ctx2 = {
  sessions: { list: () => [] },
  webServer: { register: (spec) => { handler2 = spec.handler } },
  on: () => {},
  effect: (fn) => fn(),
}
apply(ctx2, { ledgerDir })
const body2 = await new Promise((resolve) => {
  handler2({ method: 'GET', url: '/token-ledger/summary' }, { writeHead: () => {}, end: (b) => resolve(b) })
})
const s2 = JSON.parse(body2)
assert('reload totals stable', s2.totals.all.total, 1819)
assert('reload requests stable', s2.totals.all.requests, 4)

// Verify endpoint: memory vs disk replay must agree exactly.
const verifyBody = await new Promise((resolve) => {
  handler2({ method: 'GET', url: '/token-ledger/verify' }, { writeHead: () => {}, end: (b) => resolve(b) })
})
const v = JSON.parse(verifyBody)
assert('verify consistent', v.consistent, true)
assert('verify mismatches empty', v.mismatches, [])
assert('verify disk entries (unique keys)', v.entries, 4)
assert('verify unique keys', v.kinds.provider + v.kinds.estimatedOutput, 4)
assert('verify badLines', v.badLines, 0)
assert('verify totals match memory', v.memory.total, s2.totals.all.total)

// Per-session report route.
const sessionBody = await new Promise((resolve) => {
  handler2({ method: 'GET', url: '/token-ledger/session?sessionId=sess-1' }, { writeHead: () => {}, end: (b) => resolve(b) })
})
const sr = JSON.parse(sessionBody)
assert('session report ok', sr.ok, true)
assert('session report requests', sr.requests, 4)
assert('session report totals', sr.totals.total, 1819)
assert('session report series length', sr.series.length, 4)
assert('session report series order', sr.series.map((x) => x.turn + ':' + x.step), ['0:0', '0:1', '0:2', '0:3'])
assert('session report series fields', Object.keys(sr.series[0]).sort(), ['cacheRead', 'cacheWrite', 'input', 'kind', 'model', 'output', 'step', 'ts', 'turn'])
const missingBody = await new Promise((resolve) => {
  handler2({ method: 'GET', url: '/token-ledger/session?sessionId=nope' }, { writeHead: () => {}, end: (b) => resolve(b) })
})
assert('session report missing session', JSON.parse(missingBody).requests, 0)

console.log('ledger dir:', ledgerDir)
