// dsh-token-ledger — Host half (persistent profile plugin).
//
// Self-recorded token ledger. The provider (e.g. OpenCode Go) reports exact
// per-request usage in its stream — uncached input / output / cache-read /
// cache-write — but its dashboard only surfaces cost, and DSH does not keep
// these numbers anywhere the user can accumulate over time. This plugin
// folds the session/event firehose (the same events the built-in token-meter
// consumes) into an append-only JSONL ledger on disk, one line per request
// step, and serves aggregates over /token-ledger routes for the web badge.
//
// The plugin is pure local accounting: no LLM calls, no prompt injection, no
// network egress — its own token cost is zero.
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

export const name = 'dsh-token-ledger'
export const inject = ['webServer', 'sessions', 'sessionPersistence']

/** Default ledger directory: <DSH_HOME>/dsh-token-ledger (DSH_HOME or ~/.dsh). */
function defaultLedgerDir() {
  return path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'dsh-token-ledger')
}

const MS_DAY = 24 * 60 * 60 * 1000
/** Local calendar day key for a Unix-epoch-ms timestamp. */
function dayOf(ts) {
  const d = new Date(ts)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${dd}`
}

/** Non-negative finite number or null. */
function num(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : null
}

/** Empty totals bucket. */
function emptyTotals() {
  return { requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, estimated: 0 }
}

/** Sum two totals buckets (in place on `a`). */
function addTotals(a, b) {
  a.requests += b.requests
  a.input += b.input
  a.output += b.output
  a.cacheRead += b.cacheRead
  a.cacheWrite += b.cacheWrite
  a.total += b.total
  a.estimated += b.estimated
  return a
}

/** Subtract `b` from `a` (in place; used to undo a replaced entry). */
function subTotals(a, b) {
  a.requests -= b.requests
  a.input -= b.input
  a.output -= b.output
  a.cacheRead -= b.cacheRead
  a.cacheWrite -= b.cacheWrite
  a.total -= b.total
  a.estimated -= b.estimated
  return a
}

/**
 * Extract the disjoint harness usage buckets from a provider usage record.
 * Returns null when the record carries no usable token counts at all.
 */
function bucketsOf(usage) {
  if (!usage || typeof usage !== 'object') return null
  const input = num(usage.inputTokens)
  const output = num(usage.outputTokens)
  if (input === null && output === null) return null
  return {
    input,
    output,
    cacheRead: num(usage.cacheReadTokens),
    cacheWrite: num(usage.cacheWriteTokens),
  }
}

/**
 * Heuristic output-token estimate for an assistant message whose provider
 * reported no usage (chars/4 + framing overhead, the same fixed-density rule
 * the harness token-meter uses). Returns null when there is nothing to price.
 */
function estimateOutputTokens(message) {
  const blocks = message && Array.isArray(message.content) ? message.content : null
  if (!blocks) return null
  let chars = 0
  for (const b of blocks) {
    if (!b || typeof b !== 'object') continue
    if (typeof b.text === 'string') chars += b.text.length
    else if (typeof b.name === 'string') chars += b.name.length + (typeof b.arguments === 'string' ? b.arguments.length : 0)
  }
  return chars > 0 ? Math.ceil(chars / 4) + 4 : null
}

/** One request step's ledger record. */
function makeEntry(session, event, b, kind, model) {
  return {
    v: 1,
    key: `${session.id}:${event.data.turn}:${event.data.step}`,
    ts: event.time,
    session: session.id,
    cwd: (session.header && session.header.cwd) || null,
    provider: (model && model.provider) || 'unknown',
    model: (model && model.model) || 'unknown',
    kind,
    input: b.input,
    output: b.output,
    cacheRead: b.cacheRead,
    cacheWrite: b.cacheWrite,
  }
}

/** Totals from one entry (missing buckets count zero). */
function entryTotals(e) {
  return {
    requests: 1,
    input: e.input || 0,
    output: e.output || 0,
    cacheRead: e.cacheRead || 0,
    cacheWrite: e.cacheWrite || 0,
    total: (e.input || 0) + (e.output || 0) + (e.cacheRead || 0) + (e.cacheWrite || 0),
    estimated: e.kind === 'estimated-output' ? 1 : 0,
  }
}

export function apply(ctx, config = {}) {
  const ledgerDir = typeof config.ledgerDir === 'string' && config.ledgerDir
    ? path.resolve(config.ledgerDir)
    : defaultLedgerDir()
  const retentionDays = Number(config.retentionDays) > 0 ? Number(config.retentionDays) : 366
  /** Recent entries ring for the /entries endpoint. */
  const recentLimit = 500

  /** key -> entry (last write wins; early usage chunks are replaced by the step's final message). */
  const entries = new Map()
  /** date (YYYY-MM-DD) -> totals */
  const dayTotals = new Map()
  /** `${provider}/${model}` -> totals + lastTs */
  const modelTotals = new Map()
  /** session id -> totals + lastTs + cwd */
  const sessionTotals = new Map()
  /** Recent entries, newest first (bounded). */
  const recent = []

  function ensureLedgerDir() {
    try {
      fs.mkdirSync(ledgerDir, { recursive: true })
      return true
    } catch (e) {
      console.error('[dsh-token-ledger] cannot create ledger dir:', String((e && e.message) || e))
      return false
    }
  }

  function dateOfFile(name) {
    return /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name) ? name.slice(0, 10) : null
  }

  function insert(entry, persist) {
    const old = entries.get(entry.key)
    if (old !== undefined) {
      const oldDay = dayTotals.get(dayOf(old.ts))
      if (oldDay) subTotals(oldDay, entryTotals(old))
      const mk = `${old.provider}/${old.model}`
      const m = modelTotals.get(mk)
      if (m) subTotals(m, entryTotals(old))
      const s = sessionTotals.get(old.session)
      if (s) subTotals(s, entryTotals(old))
    }
    entries.set(entry.key, entry)
    const day = dayOf(entry.ts)
    let dt = dayTotals.get(day)
    if (!dt) {
      dt = emptyTotals()
      dayTotals.set(day, dt)
    }
    addTotals(dt, entryTotals(entry))
    const mk = `${entry.provider}/${entry.model}`
    let mt = modelTotals.get(mk)
    if (!mt) {
      mt = emptyTotals()
      mt.label = mk
      modelTotals.set(mk, mt)
    }
    addTotals(mt, entryTotals(entry))
    mt.lastTs = Math.max(mt.lastTs || 0, entry.ts)
    let st = sessionTotals.get(entry.session)
    if (!st) {
      st = emptyTotals()
      st.session = entry.session
      st.cwd = entry.cwd
      sessionTotals.set(entry.session, st)
    }
    addTotals(st, entryTotals(entry))
    st.lastTs = Math.max(st.lastTs || 0, entry.ts)
    if (st.cwd == null && entry.cwd != null) st.cwd = entry.cwd
    // The recent ring mirrors the keyed ledger: one entry per key, newest wins.
    const dup = recent.findIndex((x) => x.key === entry.key)
    if (dup !== -1) recent.splice(dup, 1)
    recent.unshift(entry)
    if (recent.length > recentLimit) recent.length = recentLimit
    if (persist) appendToDisk(entry)
  }

  function appendToDisk(entry) {
    if (!ensureLedgerDir()) return
    const file = path.join(ledgerDir, `${dayOf(entry.ts)}.jsonl`)
    try {
      fs.appendFileSync(file, JSON.stringify(entry) + '\n', 'utf8')
    } catch (e) {
      console.error('[dsh-token-ledger] ledger append failed:', String((e && e.message) || e))
    }
  }

  /** Load every kept daily file into the in-memory index (idempotent replay). */
  function load() {
    let files = []
    try {
      files = fs.existsSync(ledgerDir)
        ? fs.readdirSync(ledgerDir).filter((f) => dateOfFile(f) !== null).sort()
        : []
    } catch (e) {
      console.error('[dsh-token-ledger] ledger dir read failed:', String((e && e.message) || e))
      return
    }
    const cutoff = dayOf(Date.now() - retentionDays * MS_DAY)
    for (const f of files) {
      const date = dateOfFile(f)
      if (date < cutoff) {
        try { fs.unlinkSync(path.join(ledgerDir, f)) } catch (e) {}
        continue
      }
      let lines = []
      try {
        lines = fs.readFileSync(path.join(ledgerDir, f), 'utf8').split('\n')
      } catch (e) {
        console.error('[dsh-token-ledger] ledger read failed:', f, String((e && e.message) || e))
        continue
      }
      for (const line of lines) {
        if (!line.trim()) continue
        try {
          const entry = JSON.parse(line)
          if (entry && typeof entry.key === 'string' && typeof entry.ts === 'number') {
            insert(entry, false)
          }
        } catch (e) {
          // One corrupt line must not block the rest of the ledger.
        }
      }
    }
  }

  /**
   * Fold one session event into the ledger. `routes` carries the latest
   * request/context (provider + model) per session id; the session object's
   * own `requestContext()` fold is preferred when it returns a value (it
   * reconstructs the latest route metadata from the full log).
   */
  function foldEvent(session, event, routes) {
    switch (event.type) {
      case 'request/context':
        routes.set(session.id, { provider: event.data.provider, model: event.data.model })
        return
      case 'assistant/chunk': {
        const chunk = event.data.chunk
        if (!chunk || chunk.type !== 'usage') return
        const b = bucketsOf(chunk.usage)
        if (!b) return
        insert(makeEntry(session, event, b, 'provider', routeOf(session, routes)), true)
        return
      }
      case 'assistant/message': {
        const usage = event.data.usage
        if (usage !== undefined) {
          const b = bucketsOf(usage)
          if (b) {
            insert(makeEntry(session, event, b, 'provider', routeOf(session, routes)), true)
            return
          }
        }
        // Provider reported nothing: log the estimate so the day is not silent.
        const est = estimateOutputTokens(event.data.message)
        if (est !== null) {
          insert(makeEntry(session, event, { input: null, output: est, cacheRead: null, cacheWrite: null }, 'estimated-output', routeOf(session, routes)), true)
        }
        return
      }
      default:
        return
    }
  }

  function routeOf(session, routes) {
    try {
      const rc = session.requestContext ? session.requestContext() : undefined
      if (rc && typeof rc.provider === 'string' && typeof rc.model === 'string') {
        return { provider: rc.provider, model: rc.model }
      }
    } catch (e) {
      // Fall through to the tracked route.
    }
    return routes.get(session.id)
  }

  load()

  // Backfill: fold every live session's full log once. Replay is idempotent —
  // ledger keys are session:turn:step and the last write wins — so a plugin
  // restart or an already-seen session simply re-folds the same keys.
  const routes = new Map()
  let backfilled = 0
  try {
    const sessions = ctx.sessions.list()
    for (const session of sessions) {
      for (const event of session.events) foldEvent(session, event, routes)
      backfilled += 1
    }
  } catch (e) {
    console.warn('[dsh-token-ledger] backfill skipped:', String((e && e.message) || e))
  }
  if (backfilled > 0) {
    console.log(`[dsh-token-ledger] backfilled ${backfilled} session(s), ${entries.size} ledger entries`)
  }

  // Live firehose.
  ctx.on('session/event', (session, event) => {
    try {
      foldEvent(session, event, routes)
    } catch (e) {
      console.error('[dsh-token-ledger] fold failed:', String((e && e.message) || e))
    }
  })

  function totalsBetween(daysAgo) {
    const t = emptyTotals()
    if (daysAgo >= 1e6) {
      // All-time: sum every kept day bucket.
      for (const totals of dayTotals.values()) addTotals(t, totals)
      return t
    }
    const cutoff = dayOf(Date.now() - daysAgo * MS_DAY)
    for (const [date, totals] of dayTotals) {
      if (date >= cutoff) addTotals(t, totals)
    }
    return t
  }

  function daySeries(days) {
    const out = []
    const today = dayOf(Date.now())
    for (let i = days - 1; i >= 0; i--) {
      const date = dayOf(Date.now() - i * MS_DAY)
      const t = dayTotals.get(date) || emptyTotals()
      out.push({ date, ...t })
    }
    return out
  }

  function summarize() {
    const byModel = [...modelTotals.values()]
      .map((t) => ({ provider: t.label.split('/')[0], model: t.label.split('/').slice(1).join('/'), ...strip(t) }))
      .sort((a, b) => b.total - a.total)
    const bySession = [...sessionTotals.values()]
      .map((t) => ({ session: t.session, cwd: t.cwd || null, lastTs: t.lastTs || null, ...strip(t) }))
      .sort((a, b) => b.total - a.total)
      .slice(0, 20)
    return {
      ok: true,
      now: Date.now(),
      path: ledgerDir,
      retentionDays,
      totals: {
        day: strip(totalsBetween(0)),
        week: strip(totalsBetween(6)),
        month: strip(totalsBetween(29)),
        all: strip(totalsBetween(1e9)),
      },
      days: daySeries(30),
      models: byModel,
      sessions: bySession,
    }
  }

  function strip(t) {
    return {
      requests: t.requests,
      input: t.input,
      output: t.output,
      cacheRead: t.cacheRead,
      cacheWrite: t.cacheWrite,
      total: t.total,
      estimated: t.estimated,
    }
  }

  /**
   * Self-check: replay the on-disk ledger into a scratch index and compare
   * against the in-memory state. Replay applies the same last-line-wins-per-key
   * semantics as the loader, so a healthy plugin shows exact equality — any
   * mismatch is a real bug.
   */
  function verify() {
    const disk = { files: 0, lines: 0, badLines: 0, byKey: new Map() }
    let files = []
    try {
      files = fs.existsSync(ledgerDir)
        ? fs.readdirSync(ledgerDir).filter((f) => dateOfFile(f) !== null).sort()
        : []
    } catch (e) {
      return { ok: false, error: 'ledger dir read failed: ' + String((e && e.message) || e) }
    }
    for (const f of files) {
      disk.files += 1
      let lines = []
      try {
        lines = fs.readFileSync(path.join(ledgerDir, f), 'utf8').split('\n')
      } catch (e) {
        return { ok: false, error: 'read failed: ' + f + ' ' + String((e && e.message) || e) }
      }
      for (const line of lines) {
        if (!line.trim()) continue
        disk.lines += 1
        try {
          const entry = JSON.parse(line)
          if (!entry || typeof entry.key !== 'string' || typeof entry.ts !== 'number') throw new Error('shape')
          disk.byKey.set(entry.key, entry) // last line wins, same as load()
        } catch (e) {
          disk.badLines += 1
        }
      }
    }
    const memoryTotals = strip(sumAll(dayTotals))
    const diskTotals = strip(sumAll(disk.byKey))
    const fields = ['requests', 'input', 'output', 'cacheRead', 'cacheWrite', 'total']
    const mismatches = fields.filter((f) => memoryTotals[f] !== diskTotals[f])
    return {
      ok: true,
      consistent: mismatches.length === 0,
      mismatches,
      memory: memoryTotals,
      disk: diskTotals,
      files: disk.files,
      lines: disk.lines,
      badLines: disk.badLines,
      entries: disk.byKey.size,
      kinds: {
        provider: [...entries.values()].filter((e) => e.kind === 'provider').length,
        estimatedOutput: [...entries.values()].filter((e) => e.kind === 'estimated-output').length,
      },
      sample: recent.slice(0, 3),
    }
  }

  /** Sum a Map of entries (keyed) or day buckets into one totals object. */
  function sumAll(m) {
    const t = emptyTotals()
    for (const value of m.values()) {
      if (value && typeof value === 'object' && 'requests' in value) addTotals(t, value)
      else addTotals(t, entryTotals(value))
    }
    return t
  }

  const handler = async (req, res) => {
    let url
    try {
      url = new URL(req.url ?? '/', 'http://x')
    } catch (e) {
      url = null
    }
    const pathname = url ? url.pathname : ''
    let body
    if (pathname === '/token-ledger/summary') {
      body = JSON.stringify(summarize())
    } else if (pathname === '/token-ledger/entries') {
      const limit = Math.min(2000, Math.max(1, Number(url.searchParams.get('limit')) || 200))
      body = JSON.stringify({ ok: true, entries: recent.slice(0, limit) })
    } else if (pathname === '/token-ledger/session') {
      body = JSON.stringify(sessionReport(url.searchParams.get('sessionId') || ''))
    } else if (pathname === '/token-ledger/backfill' && req.method === 'POST') {
      const id = url.searchParams.get('sessionId') || ''
      body = JSON.stringify(await backfillSession(id))
    } else if (pathname === '/token-ledger/verify-fold') {
      const id = url.searchParams.get('sessionId') || ''
      const maxSeq = url.searchParams.get('maxSeq')
      body = JSON.stringify(await verifyFold(id, maxSeq == null ? null : Number(maxSeq)))
    } else if (pathname === '/token-ledger/verify') {
      body = JSON.stringify(verify())
    } else {
      res.writeHead(404)
      res.end()
      return
    }
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    res.end(body)
  }

  /**
   * Per-session report for the 用量 view: aggregate totals plus a per-request
   * series (stacked-bar source) for one session id.
   */
  function sessionReport(sessionId) {
    if (!sessionId) return { ok: false, error: 'sessionId required' }
    const rows = [...entries.values()]
      .filter((e) => e.session === sessionId)
      .sort((a, b) => a.ts - b.ts)
    const totals = emptyTotals()
    const series = []
    for (const e of rows) {
      addTotals(totals, entryTotals(e))
      // key = "<sessionId>:<turn>:<step>" (session ids contain no colons)
      const parts = e.key.split(':')
      const turn = parts.length >= 3 ? Number(parts[parts.length - 2]) : null
      const step = parts.length >= 3 ? Number(parts[parts.length - 1]) : null
      series.push({
        ts: e.ts,
        turn: Number.isFinite(turn) ? turn : null,
        step: Number.isFinite(step) ? step : null,
        input: e.input,
        output: e.output,
        cacheRead: e.cacheRead,
        cacheWrite: e.cacheWrite,
        kind: e.kind,
        model: e.model,
      })
    }
    const meta = sessionTotals.get(sessionId)
    return {
      ok: true,
      sessionId,
      cwd: (meta && meta.cwd) || null,
      lastTs: (meta && meta.lastTs) || null,
      requests: totals.requests,
      totals: strip(totals),
      series,
    }
  }

  /**
   * On-demand history backfill: load one persisted session through the
   * session-persistence service's inspect() (reads the on-disk log without
   * mounting the session) and fold its full event log into the ledger.
   * Idempotent — ledger keys are session:turn:step and the last write wins.
   */
  async function backfillSession(sessionId) {
    if (!sessionId) return { ok: false, error: 'sessionId required' }
    let inspection
    try {
      inspection = await ctx.sessionPersistence.inspect(sessionId)
    } catch (e) {
      return { ok: false, error: 'inspect failed: ' + String((e && e.message) || e) }
    }
    if (!inspection || !Array.isArray(inspection.events)) {
      return { ok: false, error: 'unexpected inspection shape' }
    }
    const routes = new Map()
    const fake = {
      id: sessionId,
      header: inspection.meta || { cwd: undefined },
      requestContext: undefined,
    }
    let folded = 0
    for (const event of inspection.events) {
      foldEvent(fake, event, routes)
      folded += 1
    }
    const report = sessionReport(sessionId)
    return {
      ok: true,
      sessionId,
      eventsFolded: folded,
      requests: report.requests,
      totals: report.totals,
    }
  }

  /**
   * Read-only verification fold: fold usage from one persisted session's
   * events (optionally up to a max seq) WITHOUT writing the ledger, returning
   * the totals. Used to cross-check the ledger against the harness's own
   * tokenUsage projection (same events, same buckets).
   */
  async function verifyFold(sessionId, maxSeq) {
    if (!sessionId) return { ok: false, error: 'sessionId required' }
    let inspection
    try {
      inspection = await ctx.sessionPersistence.inspect(sessionId)
    } catch (e) {
      return { ok: false, error: 'inspect failed: ' + String((e && e.message) || e) }
    }
    const byKey = new Map()
    for (const event of inspection.events) {
      if (maxSeq != null && event.seq > maxSeq) break
      let b = null
      if (event.type === 'assistant/chunk' && event.data.chunk && event.data.chunk.type === 'usage') {
        b = bucketsOf(event.data.chunk.usage)
      } else if (event.type === 'assistant/message') {
        if (event.data.usage !== undefined) b = bucketsOf(event.data.usage)
        else {
          const est = estimateOutputTokens(event.data.message)
          if (est !== null) b = { input: null, output: est, cacheRead: null, cacheWrite: null }
        }
      }
      if (!b) continue
      byKey.set(`${event.data.turn}:${event.data.step}`, b)
    }
    const t = emptyTotals()
    for (const b of byKey.values()) {
      addTotals(t, {
        requests: 1,
        input: b.input || 0,
        output: b.output || 0,
        cacheRead: b.cacheRead || 0,
        cacheWrite: b.cacheWrite || 0,
        total: (b.input || 0) + (b.output || 0) + (b.cacheRead || 0) + (b.cacheWrite || 0),
        estimated: 0,
      })
    }
    return { ok: true, sessionId, maxSeq: maxSeq == null ? null : maxSeq, events: inspection.events.length, requests: t.requests, totals: strip(t) }
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/token-ledger',
    handler,
  }), 'dsh-token-ledger: /token-ledger routes')
}
