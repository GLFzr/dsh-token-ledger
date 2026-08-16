// cdp-shot.mjs — drive headless Edge via CDP to open the DSH web GUI,
// click the 用量 tab, wait for the token chart, capture a screenshot.
// Uses Node's built-in fetch + WebSocket (no dependencies).
// Usage: node cdp-shot.mjs [port] [outPng] [url]
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const port = Number(process.argv[2] || 9225)
const outPng = process.argv[3] || path.join(import.meta.dirname, 'shots', 'usage-view.png')
const url = process.argv[4] || 'http://127.0.0.1:3080'
const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const profile = path.join(path.dirname(outPng), 'edge-profile')

fs.mkdirSync(path.dirname(outPng), { recursive: true })

const edgeProc = spawn(edge, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--disable-extensions',
  `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, 'about:blank',
], { stdio: 'ignore', windowsHide: true })
console.log('edge pid:', edgeProc.pid)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function getTarget() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      const t = list.find((x) => x.type === 'page')
      if (t) return t
    } catch {}
    await sleep(500)
  }
  throw new Error('no CDP page target')
}

const target = await getTarget()
console.log('target ws:', target.webSocketDebuggerUrl.slice(0, 48) + '...')

const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  ws.onopen = resolve
  ws.onerror = reject
})

let nextId = 1
const pending = new Map()
let buf = ''

ws.onmessage = (ev) => {
  buf += typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8')
  for (;;) {
    const trimmed = buf.replace(/^\s+/, '')
    if (!trimmed) { buf = ''; break }
    let depth = 0, inStr = false, esc = false, end = -1
    for (let i = 0; i < trimmed.length; i++) {
      const ch = trimmed[i]
      if (inStr) {
        if (esc) esc = false
        else if (ch === '\\') esc = true
        else if (ch === '"') inStr = false
        continue
      }
      if (ch === '"') inStr = true
      else if (ch === '{') depth++
      else if (ch === '}') { depth--; if (depth === 0) { end = i + 1; break } }
    }
    if (end < 0) { buf = trimmed; break }
    const raw = trimmed.slice(0, end)
    buf = trimmed.slice(end)
    let msg
    try { msg = JSON.parse(raw) } catch { continue }
    if (msg.id != null && pending.has(msg.id)) {
      const p = pending.get(msg.id)
      pending.delete(msg.id)
      msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result)
    }
  }
}

function send(method, params) {
  return new Promise((resolve, reject) => {
    const id = nextId++
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
  })
}

const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  return r.result ? r.result.value : undefined
}

try {
  await send('Page.enable')
  await send('Runtime.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: 1560, height: 2200, deviceScaleFactor: 1, mobile: false })
  // Seed the persisted current-session cell BEFORE the app scripts run, so a
  // fresh browser profile restores the target session directly.
  const seedSessionId = process.env.TL_SESSION_ID || 'session-bacb7ee8-accf-41f4-9c91-c2ba662a9fc8'
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `try { localStorage.setItem('dsh.sessions.current', JSON.stringify({ sessionId: '${seedSessionId}' })); } catch (e) {}`,
  })
  await send('Page.navigate', { url })

  // Wait for boot + an open session (view tabs appear).
  let tabs = null
  for (let i = 0; i < 90; i++) {
    await sleep(1000)
    try {
      const st = await evaluate(`({ href: location.href, ready: document.readyState, bodyLen: document.body ? document.body.innerText.length : -1, tabs: [...document.querySelectorAll('[role=tab]')].map(x => x.textContent.trim()) })`)
      if (st && Array.isArray(st.tabs) && st.tabs.length) { tabs = st.tabs; break }
      // Home/workspace page: try "返回对话" to enter the active session.
      if (i % 5 === 4) {
        const clicked = await evaluate(`(() => { const els = [...document.querySelectorAll('button, [role=button], a')]; const b = els.find(x => (x.innerText || '').trim() === '\u8fd4\u56de\u5bf9\u8bdd'); if (b) { b.click(); return true; } return false; })()`)
        if (clicked) console.log('  clicked 返回对话')
      }
      if (i % 10 === 9) console.log(`  wait... href=${st && st.href} ready=${st && st.ready} bodyLen=${st && st.bodyLen}`)
    } catch (e) { console.log('  eval err:', String(e)) }
  }
  console.log('tabs:', tabs ? tabs.join(' / ') : '(none)')
  if (!tabs) {
    const diag = await evaluate(`(() => { const t = document.querySelector('#root') || document.body; return { href: location.href, ready: document.readyState, html: t ? t.innerHTML.slice(0, 600) : '(no root/body)' }; })()`)
    console.log('diag:', JSON.stringify(diag))
    throw new Error('no conversation tabs appeared')
  }

  const clicked = await evaluate(`(() => { const t = [...document.querySelectorAll('[role=tab]')].find(x => x.textContent.trim() === '\u7528\u91cf'); if (!t) return false; t.click(); return true; })()`)
  console.log('usage tab clicked:', clicked)

  let view = null
  for (let i = 0; i < 40; i++) {
    await sleep(500)
    try {
      view = await evaluate(`(() => { const v = document.querySelector('.dsh-tl-view'); if (!v) return null; return { cards: document.querySelectorAll('.dsh-tl-card').length, bars: document.querySelectorAll('.dsh-tl-col').length, segs: document.querySelectorAll('.dsh-tl-seg').length, text: v.innerText.slice(0, 500) }; })()`)
      if (view && view.cards > 0) break
    } catch {}
  }
  console.log('usage view:', JSON.stringify(view))

  // Hover the LAST bar: React synthesizes onMouseEnter from bubbled
  // `mouseover` (mouseenter itself does not bubble), and the tooltip position
  // tracks `mousemove` — dispatch both on the bar element.
  const barPos = await evaluate(`(() => {
    const cols = [...document.querySelectorAll('.dsh-tl-col')];
    const c = cols[cols.length - 1];
    if (!c) return null;
    c.scrollIntoView({ block: 'nearest', inline: 'end' });
    const r = c.getBoundingClientRect();
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    const opts = { bubbles: true, cancelable: true, clientX: x, clientY: y };
    c.dispatchEvent(new MouseEvent('mouseover', opts));
    c.dispatchEvent(new MouseEvent('mousemove', opts));
    return { x: Math.round(x), y: Math.round(y), inView: x > 0 && x < window.innerWidth && y > 0 && y < window.innerHeight };
  })()`)
  console.log('barPos:', JSON.stringify(barPos))
  const tip = await evaluate(`(() => { const t = document.querySelector('.dsh-tl-tip'); return t ? { text: t.innerText.slice(0, 260), cls: t.className } : null; })()`)
  console.log('tooltip:', JSON.stringify(tip))
  // Bar-height sampling: measure the VISIBLE height (sum of segments), not the
  // fixed-height column container.
  const heights = await evaluate(`(() => {
    const cols = [...document.querySelectorAll('.dsh-tl-col')];
    const vis = (c) => [...c.querySelectorAll('.dsh-tl-seg')].reduce((s, x) => s + x.getBoundingClientRect().height, 0);
    const all = cols.map(vis);
    const min = Math.min(...all), max = Math.max(...all);
    const short = all.filter(h => h < max * 0.7).length;
    return { min: Math.round(min), max: Math.round(max), shortCount: short, total: all.length, first8: all.slice(0, 8).map(h => Math.round(h * 10) / 10) };
  })()`)
  console.log('heights:', JSON.stringify(heights))

  // Structural sampling: read the first 6 bars' segment geometry + colors and
  // the chart container rect — hard evidence of the stacked-bar rendering.
  const structure = await evaluate(`(() => {
    const wrap = document.querySelector('.dsh-tl-chart-wrap');
    const chart = document.querySelector('.dsh-tl-chart');
    const cols = [...document.querySelectorAll('.dsh-tl-col')].slice(0, 6).map(col => {
      const segs = [...col.querySelectorAll('.dsh-tl-seg')].map(s => {
        const r = s.getBoundingClientRect(), c = s.getBoundingClientRect();
        return { cls: s.className, h: Math.round(r.height * 10) / 10, color: getComputedStyle(s).backgroundColor };
      });
      const cr = col.getBoundingClientRect();
      return { totalH: Math.round(cr.height * 10) / 10, segs };
    });
    const wrapRect = wrap ? wrap.getBoundingClientRect() : null;
    const chartRect = chart ? chart.getBoundingClientRect() : null;
    return { wrap: wrapRect && { x: Math.round(wrapRect.x), y: Math.round(wrapRect.y), w: Math.round(wrapRect.width), h: Math.round(wrapRect.height) }, chart: chartRect && { x: Math.round(chartRect.x), y: Math.round(chartRect.y), w: Math.round(chartRect.width), h: Math.round(chartRect.height) }, cols };
  })()`)
  console.log('structure:', JSON.stringify(structure))

  await sleep(800)
  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })
  fs.writeFileSync(outPng, Buffer.from(shot.data, 'base64'))
  console.log('screenshot saved:', outPng, Math.round(fs.statSync(outPng).size / 1024) + ' KB')
} finally {
  try { ws.close() } catch {}
  edgeProc.kill()
}
