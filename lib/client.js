// dsh-token-ledger — Client half (web bundle).
// A "用量" page next to the conversation trajectory tab: per-session token
// stats (uncached input / cache hit / cache write / output) with a stacked
// bar chart. Four view modes — 按请求 / 按小时 / 按天 / 按轮次 — slim bars
// with wide gaps, mouse-following flat tooltip, 15s auto refresh.
// Data comes from the host's /token-ledger/session route — pure local
// accounting, zero model tokens.
window.__ModuleLoader__.load({
  id: 'dsh-token-ledger',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    const React = require('react')

    // Palette: soft / low-saturation tones that read well on dark chrome.
    const C_INPUT = '#8ab8ff'   // 缓存未命中 (soft blue)
    const C_CACHE = '#4ade80'   // 缓存命中 (vivid green)
    const C_OUTPUT = '#c9a8f8'  // 输出 (soft purple)

    const TAG_ID = 'dsh-token-ledger/usage.css'
    const CSS = [
      '.dsh-tl-view { padding: 12px 16px 20px; font-size: 12px; color: var(--dsw-alias-label-primary, #e5e5e5); }',
      '.dsh-tl-head { display: flex; align-items: baseline; gap: 10px; margin-bottom: 12px; flex-wrap: wrap; }',
      '.dsh-tl-title { font-size: 15px; font-weight: 700; }',
      '.dsh-tl-sub { color: var(--dsw-alias-label-tertiary, rgba(128,128,128,.8)); font-size: 11px; }',
      '.dsh-tl-cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 8px; margin-bottom: 12px; }',
      '.dsh-tl-card { border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.3)); border-radius: 10px; padding: 8px 10px; background: var(--dsw-alias-bg-layer-1, rgba(255,255,255,.02)); }',
      '.dsh-tl-card .dsh-tl-card-label { color: var(--dsw-alias-label-secondary, #aaa); font-size: 11px; margin-bottom: 3px; }',
      '.dsh-tl-card .dsh-tl-card-value { font-size: 16px; font-weight: 700; font-variant-numeric: tabular-nums; }',
      '.dsh-tl-card .dsh-tl-card-note { color: var(--dsw-alias-label-tertiary, rgba(128,128,128,.75)); font-size: 10px; margin-top: 2px; }',
      '.dsh-tl-modes { display: inline-flex; gap: 4px; margin-bottom: 10px; }',
      '.dsh-tl-mode { border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.3)); border-radius: 8px; background: transparent; color: var(--dsw-alias-label-secondary, #aaa); font-size: 11px; padding: 3px 10px; cursor: pointer; }',
      '.dsh-tl-mode:hover { color: var(--dsw-alias-label-primary, #eee); }',
      '.dsh-tl-mode.active { background: var(--dsw-alias-bg-layer-2, rgba(128,128,128,.15)); color: var(--dsw-alias-label-primary, #eee); border-color: var(--dsw-alias-border-l2, rgba(128,128,128,.55)); }',
      '.dsh-tl-chart-wrap { position: relative; border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.3)); border-radius: 10px; padding: 10px 10px 6px; background: var(--dsw-alias-bg-layer-1, rgba(255,255,255,.02)); }',
      '.dsh-tl-chart { display: flex; align-items: flex-end; gap: 10px; height: 190px; overflow-x: auto; padding-bottom: 2px; }',
      '.dsh-tl-chart.agg { gap: 10px; }',
      '.dsh-tl-col { display: flex; flex-direction: column; justify-content: flex-end; flex: 0 0 5px; height: 100%; cursor: default; }',
      '.dsh-tl-chart.agg .dsh-tl-col { flex-basis: 14px; }',
      '.dsh-tl-col:hover { outline: 1px solid rgba(255,255,255,.25); }',
      '.dsh-tl-seg { width: 100%; }',
      '.dsh-tl-seg-input { background: ' + C_INPUT + '; }',
      '.dsh-tl-seg-cache { background: ' + C_CACHE + '; }',
      '.dsh-tl-seg-output { background: ' + C_OUTPUT + '; }',
      '.dsh-tl-axis { display: flex; gap: 10px; margin-top: 5px; }',
      '.dsh-tl-axis span { flex: 0 0 15px; text-align: center; font-size: 9px; color: var(--dsw-alias-label-tertiary, rgba(128,128,128,.7)); font-variant-numeric: tabular-nums; white-space: nowrap; overflow: visible; }',
      '.dsh-tl-chart.agg + .dsh-tl-axis span { flex-basis: 24px; }',
      '.dsh-tl-legend { display: flex; gap: 14px; margin-top: 8px; flex-wrap: wrap; color: var(--dsw-alias-label-secondary, #aaa); font-size: 11px; }',
      '.dsh-tl-legend i { display: inline-block; width: 10px; height: 10px; border-radius: 3px; margin-right: 4px; vertical-align: -1px; }',
      '.dsh-tl-tip { position: fixed; z-index: 9999; background: rgba(16,18,24,.96); border: 1px solid rgba(255,255,255,.16); border-radius: 10px; padding: 8px 11px; font-size: 11px; line-height: 1.65; color: var(--dsw-alias-label-primary, #eee); white-space: pre; pointer-events: none; box-shadow: 0 8px 24px rgba(0,0,0,.5); backdrop-filter: blur(8px); }',
      '.dsh-tl-tip .tip-title { font-weight: 700; color: #fff; margin-bottom: 2px; }',
      '.dsh-tl-tip .tip-line { white-space: nowrap; }',
      '.dsh-tl-tip b { font-variant-numeric: tabular-nums; color: #fff; }',
      '.dsh-tl-empty { color: var(--dsw-alias-label-tertiary, rgba(128,128,128,.8)); padding: 30px 0; text-align: center; }',
      '.dsh-tl-err { color: var(--dsw-alias-state-error-primary, #f87171); padding: 12px 0; }',
      '.dsh-tl-note { margin-top: 10px; color: var(--dsw-alias-label-tertiary, rgba(128,128,128,.7)); font-size: 10px; line-height: 1.6; }',
    ].join('\n')
    if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(TAG_ID) + ']') === null) {
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-token-ledger'
      tag.dataset.pluginCss = TAG_ID
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    /** Compact token count: 517 / 1.2K / 12.3K / 1.2M / 1.2B. */
    function fmt(n) {
      if (typeof n !== 'number' || !Number.isFinite(n)) return '\u2013'
      if (n < 1000) return String(Math.round(n))
      if (n < 1e6) return (n / 1000).toFixed(1) + 'K'
      if (n < 1e9) return (n / 1e6).toFixed(1) + 'M'
      return (n / 1e9).toFixed(1) + 'B'
    }

    function fmtTime(ts) {
      const d = new Date(ts)
      const p = (n) => String(n).padStart(2, '0')
      return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
    }

    function fmtDate(ts) {
      const d = new Date(ts)
      const p = (n) => String(n).padStart(2, '0')
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
    }

    function fmtDateShort(ts) {
      const d = new Date(ts)
      const p = (n) => String(n).padStart(2, '0')
      return `${p(d.getMonth() + 1)}-${p(d.getDate())}`
    }

    function loadSession(sessionId) {
      return fetch('/token-ledger/session?sessionId=' + encodeURIComponent(sessionId)).then((r) => r.json())
    }

    /** Chart view modes: per-request or time/turn aggregation. */
    const MODES = [
      { key: 'request', label: '按请求' },
      { key: 'hour', label: '按小时' },
      { key: 'day', label: '按天' },
      { key: 'turn', label: '按轮次' },
    ]
    const MODE_STORE = 'dsh-token-ledger.mode'

    function loadMode() {
      try {
        const m = localStorage.getItem(MODE_STORE)
        if (m && MODES.some((x) => x.key === m)) return m
      } catch (e) {}
      return 'request'
    }

    function saveMode(m) {
      try { localStorage.setItem(MODE_STORE, m) } catch (e) {}
    }

    /** Aggregate the raw request series into time/turn buckets. */
    function aggregate(series, mode) {
      if (mode === 'request') {
        return series.map((r) => ({ ...r, total: (r.input || 0) + (r.output || 0) + (r.cacheRead || 0) + (r.cacheWrite || 0) }))
      }
      const buckets = new Map()
      for (const r of series) {
        let key
        if (mode === 'hour') key = fmtDate(r.ts) + ' ' + String(new Date(r.ts).getHours()).padStart(2, '0') + ':00'
        else if (mode === 'day') key = fmtDate(r.ts)
        else key = 'turn ' + (r.turn != null ? r.turn : '?')
        let b = buckets.get(key)
        if (!b) {
          b = { key, ts: r.ts, turn: r.turn, requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
          buckets.set(key, b)
        }
        b.requests += 1
        b.input += r.input || 0
        b.output += r.output || 0
        b.cacheRead += r.cacheRead || 0
        b.cacheWrite += r.cacheWrite || 0
        b.total += (r.input || 0) + (r.output || 0) + (r.cacheRead || 0) + (r.cacheWrite || 0)
        if (r.ts < b.ts) b.ts = r.ts
      }
      return [...buckets.values()].sort((a, b2) => a.ts - b2.ts)
    }

    function axisLabel(b, mode, i, totalBars) {
      if (mode === 'request') return (i % 10 === 0) ? '#' + (i + 1) : '\u00b7'
      const step = Math.max(1, Math.ceil(totalBars / 18))
      if (i % step !== 0) return '\u00b7'
      if (mode === 'hour') return String(new Date(b.ts).getHours()).padStart(2, '0') + ':00'
      if (mode === 'day') return fmtDateShort(b.ts)
      return 'T' + (b.turn != null ? b.turn : '?')
    }

    /** Tooltip content as [title, ...detail lines]. */
    function tipLines(b, mode, index) {
      if (mode === 'request') {
        return [
          '#' + (index + 1) + ' \u00b7 ' + fmtDate(b.ts) + ' ' + fmtTime(b.ts) + ' \u00b7 turn ' + (b.turn != null ? b.turn : '?') + '.' + (b.step != null ? b.step : '?'),
          '未命中输入 ' + fmt(b.input),
          '缓存命中 ' + fmt(b.cacheRead),
          '缓存写入 ' + fmt(b.cacheWrite),
          '输出 ' + fmt(b.output),
        ]
      }
      const what = mode === 'hour' ? fmtDate(b.ts) + ' ' + String(new Date(b.ts).getHours()).padStart(2, '0') + ':00'
        : mode === 'day' ? fmtDate(b.ts)
          : '轮次 ' + (b.turn != null ? b.turn : '?')
      return [
        what + ' \u00b7 ' + b.requests + ' 次请求',
        '未命中输入 ' + fmt(b.input),
        '缓存命中 ' + fmt(b.cacheRead),
        '缓存写入 ' + fmt(b.cacheWrite),
        '输出 ' + fmt(b.output),
        '合计 ' + fmt(b.total),
      ]
    }

    function Card({ label, value, note, color }) {
      return React.createElement('div', { className: 'dsh-tl-card' },
        React.createElement('div', { className: 'dsh-tl-card-label' }, label),
        React.createElement('div', { className: 'dsh-tl-card-value', style: color ? { color } : undefined }, value),
        note ? React.createElement('div', { className: 'dsh-tl-card-note' }, note) : null,
      )
    }

    function UsageView(props) {
      const sessionId = props.sessionId
      const [state, setState] = React.useState({ data: null, error: null, hover: null, tip: null, mode: loadMode() })
      const aliveRef = React.useRef(true)

      const refresh = () => {
        if (!sessionId) return
        loadSession(sessionId).then((r) => {
          if (!aliveRef.current) return
          if (r && r.ok === true) setState((s) => ({ ...s, data: r, error: null }))
          else setState((s) => ({ ...s, error: (r && r.error) || 'unknown error' }))
        }).catch((e) => {
          if (!aliveRef.current) return
          setState((s) => ({ ...s, error: String((e && e.message) || e) }))
        })
      }

      React.useEffect(() => {
        aliveRef.current = true
        setState({ data: null, error: null, hover: null, tip: null, mode: loadMode() })
        refresh()
        const timer = setInterval(refresh, 15 * 1000)
        const onVis = () => {
          if (typeof document !== 'undefined' && document.visibilityState === 'visible') refresh()
        }
        if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVis)
        return () => {
          aliveRef.current = false
          clearInterval(timer)
          if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVis)
        }
      }, [sessionId])

      const data = state.data
      const totals = data ? data.totals : null
      const series = data ? data.series : []
      const mode = state.mode
      const isAgg = mode !== 'request'

      let bars = aggregate(series, mode)
      let offset = 0 // displayed bar index -> raw series index (request mode)
      if (mode === 'request') {
        offset = Math.max(0, bars.length - 100)
        bars = bars.slice(-100)
      }
      const maxTotal = bars.reduce((m, b) => Math.max(m, b.total), 0)
      // Adaptive scale: when the data spans >20x between the smallest and the
      // largest bar, a linear scale flattens every small bar to the minimum,
      // so switch to log scale; homogeneous data keeps a true linear ratio.
      const nonzero = bars.filter((b) => b.total > 0)
      const minTotal = nonzero.length ? Math.min(...nonzero.map((b) => b.total)) : 0
      const useLog = maxTotal > 0 && minTotal > 0 && maxTotal / minTotal > 20
      const barHeight = (t) => {
        if (maxTotal <= 0) return 2
        if (useLog) return Math.max(2, 100 * Math.log1p(t) / Math.log1p(maxTotal))
        return Math.max(4, (t / maxTotal) * 100)
      }

      const head = []
      if (data && data.cwd) head.push(data.cwd)
      if (sessionId) head.push(sessionId.length > 14 ? sessionId.slice(0, 14) + '\u2026' : sessionId)
      if (data && data.lastTs) head.push('最近请求 ' + fmtDate(data.lastTs) + ' ' + fmtTime(data.lastTs))

      let body
      if (state.error) {
        body = React.createElement('div', { className: 'dsh-tl-err' }, '\u26a0 用量数据不可用：' + state.error)
      } else if (!data) {
        body = React.createElement('div', { className: 'dsh-tl-empty' }, '加载中\u2026')
      } else if (series.length === 0) {
        body = React.createElement('div', { className: 'dsh-tl-empty' }, '本对话还没有记录到请求\u2014\u2014每次模型请求后这里会出现柱状图。')
      } else {
        const miss = (totals.input || 0) + (totals.cacheWrite || 0)
        const total = totals.total || 0
        const hoverBar = state.hover != null && bars[state.hover] ? bars[state.hover] : null
        body = React.createElement(React.Fragment, null,
          React.createElement('div', { className: 'dsh-tl-cards' },
            React.createElement(Card, { label: '总 token', value: fmt(total), note: totals.requests + ' 次请求', color: 'var(--dsw-alias-label-primary)' }),
            React.createElement(Card, { label: '缓存未命中', value: fmt(miss), note: '未命中输入 ' + fmt(totals.input) + (totals.cacheWrite ? ' + 缓存写入 ' + fmt(totals.cacheWrite) : ''), color: C_INPUT }),
            React.createElement(Card, { label: '缓存命中', value: fmt(totals.cacheRead), note: totals.cacheRead > 0 ? '占输入 ' + Math.round((totals.cacheRead / (miss + totals.cacheRead)) * 100) + '%' : '暂无', color: C_CACHE }),
            React.createElement(Card, { label: '输出', value: fmt(totals.output), color: C_OUTPUT }),
          ),
          React.createElement('div', { className: 'dsh-tl-modes' },
            MODES.map((m) => React.createElement('button', {
              key: m.key,
              type: 'button',
              className: 'dsh-tl-mode' + (mode === m.key ? ' active' : ''),
              onClick: () => {
                saveMode(m.key)
                setState((s) => ({ ...s, hover: null, tip: null, mode: m.key }))
              },
            }, m.label)),
          ),
          React.createElement('div', { className: 'dsh-tl-chart-wrap' },
            React.createElement('div', {
              className: 'dsh-tl-chart' + (isAgg ? ' agg' : ''),
              onMouseLeave: () => setState((s) => ({ ...s, hover: null, tip: null })),
              onScroll: () => setState((s) => ({ ...s, tip: null })),
            },
              bars.map((b, i) => {
                const t = b.total
                // Adaptive scale: log for wide-span data, linear otherwise.
                const h = barHeight(t)
                const ih = t > 0 ? (((b.input || 0) + (b.cacheWrite || 0)) / t) * h : 0
                const ch = t > 0 ? ((b.cacheRead || 0) / t) * h : 0
                return React.createElement('div', {
                  key: (mode === 'request' ? b.ts + ':' : b.key + ':') + i,
                  className: 'dsh-tl-col',
                  onMouseEnter: (e) => setState((s) => ({ ...s, hover: i, tip: { x: e.clientX, y: e.clientY } })),
                  onMouseMove: (e) => setState((s) => ({ ...s, tip: { x: e.clientX, y: e.clientY } })),
                },
                  t <= 0 ? React.createElement('div', { className: 'dsh-tl-seg', style: { height: '2%', background: 'rgba(128,128,128,.45)' } }) : null,
                  ih > 0 ? React.createElement('div', { className: 'dsh-tl-seg dsh-tl-seg-input', style: { height: ih + '%' } }) : null,
                  ch > 0 ? React.createElement('div', { className: 'dsh-tl-seg dsh-tl-seg-cache', style: { height: ch + '%' } }) : null,
                  (t > 0 && ih + ch < h) ? React.createElement('div', { className: 'dsh-tl-seg dsh-tl-seg-output', style: { height: Math.max(0, h - ih - ch) + '%' } }) : null,
                )
              }),
            ),
            React.createElement('div', { className: 'dsh-tl-axis' },
              bars.map((b, i) => React.createElement('span', { key: i }, axisLabel(b, mode, i, bars.length))),
            ),
            React.createElement('div', { className: 'dsh-tl-legend' },
              React.createElement('span', null, React.createElement('i', { style: { background: C_INPUT } }), '缓存未命中（输入 + 缓存写入）'),
              React.createElement('span', null, React.createElement('i', { style: { background: C_CACHE } }), '缓存命中'),
              React.createElement('span', null, React.createElement('i', { style: { background: C_OUTPUT } }), '输出'),
              React.createElement('span', { style: { color: 'var(--dsw-alias-label-tertiary, rgba(128,128,128,.7))' } }, useLog ? '柱高按对数刻度（数据跨度大）' : '柱高按线性比例'),
            ),
          ),
          hoverBar && state.tip
            ? React.createElement('div', {
              className: 'dsh-tl-tip',
              style: {
                left: Math.min(state.tip.x + 14, window.innerWidth - 280),
                top: Math.max(8, Math.min(state.tip.y - 12, window.innerHeight - 160)),
              },
            },
              tipLines(hoverBar, mode, offset + state.hover).map((ln, i) => React.createElement('div', { key: i, className: i === 0 ? 'tip-line tip-title' : 'tip-line' }, ln)),
            )
            : null,
          series.length > 100 && mode === 'request'
            ? React.createElement('div', { className: 'dsh-tl-note' }, '\u2139 共 ' + series.length + ' 次请求，按请求视图仅显示最近 100 次；统计卡与聚合视图为全量。')
            : null,
          React.createElement('div', { className: 'dsh-tl-note' },
            '\u2139 数据来源：每次模型请求响应中的 provider usage（kind=provider 为精确上报，kind=estimated-output 为启发式估算）。缓存命中按 DeepSeek 64-token 块对齐。',
          ),
        )
      }

      return React.createElement('div', { className: 'dsh-tl-view' },
        React.createElement('div', { className: 'dsh-tl-head' },
          React.createElement('span', { className: 'dsh-tl-title' }, '用量'),
          React.createElement('span', { className: 'dsh-tl-sub' }, head.join(' \u00b7 ')),
        ),
        body,
      )
    }

    const inject = ['slots']

    function apply(ctx) {
      ctx.effect(() => ctx.slots.inject('conversation.view', () => ctx.slots.register({
        name: 'conversation.view',
        id: 'usage',
        order: 20,
        label: '\u7528\u91cf',
        inject: (sessionId) => ({ sessionId }),
      }, UsageView)), 'dsh-token-ledger: usage view')
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
