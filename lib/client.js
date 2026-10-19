/**
 * @dsh-external/dsh-sandbox-monitor — client half.
 *
 * 原生右侧栏（@deepseek-ai/dsh-client-ui-sidebar-right）tab：
 *  - `sidebarRightTabs.register` 声明 tab 类型 + guide 胶囊；
 *  - `sidebar.right.pane.tab`（keyed by 类型 id）挂面板主体；
 *  - `sidebar.footer.action` 挂一个入口按钮，随时打开；
 *  - 首次注入自动展开一次（localStorage 记忆）。
 *
 * 数据面：轮询 host 的 /sandbox-monitor/api/snapshot，所有指标卡可增减
 * （host 落盘 enabled 列表，重载/重启后保持）。
 *
 * 视觉：全部走 DSH 主题 token（--dsw-alias-*），玻璃质感 + 圆角卡片，
 * 与当前皮肤/明暗主题自动同步。
 */
window.__ModuleLoader__.load({
  id: '@dsh-external/dsh-sandbox-monitor',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

const React = require('react')
const { useState, useEffect, useMemo, useRef, useCallback } = React
const h = React.createElement

const PLUGIN_ID = '@dsh-external/dsh-sandbox-monitor'
const TAB_TYPE = 'sandbox-monitor'
const API_BASE = 'sandbox-monitor/api/'
const VERSION = '0.1.0'

/* ────────────────────────── 基础工具 ────────────────────────── */

const TONE = { brand: 'var(--sm-brand)', ok: 'var(--sm-ok)', warn: 'var(--sm-warn)', err: 'var(--sm-err)', idle: 'var(--sm-muted)' }

function apiUrl(path) {
  try {
    return new URL(API_BASE + path, document.baseURI).toString()
  } catch {
    return '/' + API_BASE + path
  }
}

async function fetchSnapshot() {
  const res = await fetch(apiUrl('snapshot'), { cache: 'no-store' })
  if (!res.ok) throw new Error('HTTP ' + res.status)
  const data = await res.json()
  if (!data || data.ok !== true) throw new Error((data && data.error) || 'bad payload')
  return data
}

async function postJson(path, body) {
  const res = await fetch(apiUrl(path), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
  })
  if (!res.ok) throw new Error('HTTP ' + res.status)
  return res.json()
}

function compact(n) {
  const v = Number(n) || 0
  if (Math.abs(v) >= 1e9) return (v / 1e9).toFixed(1).replace(/\.0$/, '') + 'B'
  if (Math.abs(v) >= 1e6) return (v / 1e6).toFixed(1).replace(/\.0$/, '') + 'M'
  if (Math.abs(v) >= 1e3) return (v / 1e3).toFixed(1).replace(/\.0$/, '') + 'k'
  return String(Math.round(v))
}

function bytesText(n) {
  const v = Number(n) || 0
  if (v >= 1048576) return (v / 1048576).toFixed(1) + ' MB'
  if (v >= 1024) return (v / 1024).toFixed(1) + ' KB'
  return Math.round(v) + ' B'
}

function durationText(ms) {
  const v = Math.max(0, Number(ms) || 0)
  const s = Math.round(v / 1000)
  if (s < 60) return s + 's'
  const m = Math.floor(s / 60)
  if (m < 60) return m + 'm ' + (s % 60) + 's'
  const hr = Math.floor(m / 60)
  return hr + 'h ' + (m % 60) + 'm'
}

function clockText(ts) {
  try {
    return new Date(ts).toTimeString().slice(0, 8)
  } catch {
    return '--:--:--'
  }
}

const MODE_LABEL = {
  'read-only': '只读',
  'workspace-write': '工作区写入',
  'danger-full-access': '完全权限',
  unknown: '未知',
}

function shortPath(path) {
  if (!path) return '未指定工作区'
  const text = String(path).replace(/\\/g, '/').replace(/\/+$/, '')
  if (text.length <= 40) return text
  const parts = text.split('/').filter(Boolean)
  const three = '…/' + parts.slice(-3).join('/')
  if (three.length <= 44) return three
  return '…/' + parts.slice(-2).join('/')
}

/* ────────────────────────── 快照 store（单轮询器共享） ────────────────────────── */

const store = {
  data: null,
  error: null,
  paused: false,
  loading: false,
  listeners: new Set(),
  timer: null,
  refs: 0,
  interval: 1500,
  lastAt: 0,
  emit() {
    for (const listener of this.listeners) {
      try { listener() } catch { /* 单个订阅者异常不影响其它 */ }
    }
  },
}

async function tick() {
  if (store.loading || store.paused) return
  if (typeof document !== 'undefined' && document.hidden) return
  store.loading = true
  store.lastAt = Date.now()
  try {
    const data = await fetchSnapshot()
    store.data = data
    store.error = null
    if (data.config && Number.isFinite(data.config.refreshMs)) store.interval = data.config.refreshMs
  } catch (error) {
    store.error = String((error && error.message) || error)
  } finally {
    store.loading = false
    store.emit()
  }
}

function startPolling() {
  if (store.timer) return
  store.timer = setInterval(() => {
    if (!store.refs) return
    if (Date.now() - store.lastAt < store.interval) return
    void tick()
  }, 250)
  void tick()
}

function stopPolling() {
  if (store.timer) {
    clearInterval(store.timer)
    store.timer = null
  }
}

function useSnapshot() {
  const [snap, setSnap] = useState(store.data)
  const [error, setError] = useState(store.error)
  const [paused, setPaused] = useState(store.paused)
  useEffect(() => {
    const listener = () => {
      setSnap(store.data)
      setError(store.error)
      setPaused(store.paused)
    }
    store.listeners.add(listener)
    store.refs += 1
    startPolling()
    listener()
    return () => {
      store.listeners.delete(listener)
      store.refs -= 1
      if (store.refs <= 0) stopPolling()
    }
  }, [])
  return [snap, error, paused]
}

/* ────────────────────────── 图标 ────────────────────────── */

const ICONS = {
  pulse: 'M3 12h3.5l2.2-6.5 3.6 13 2.4-6.5H21',
  sliders: 'M4 7h9m4 0h3M4 12h3m4 0h9M4 17h7m4 0h5',
  trash: 'M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13M10 11v5M14 11v5',
  pause: 'M9 5v14M15 5v14',
  play: 'M8 5l11 7-11 7z',
  close: 'M6 6l12 12M18 6L6 18',
  plus: 'M12 5v14M5 12h14',
  check: 'M4 12.5l5 5L20 6.5',
  alert: 'M12 4l9 16H3zM12 10v4M12 17v.6',
  terminal: 'M4 5h16v14H4zM7.5 9.5l2.5 2.5-2.5 2.5M13 15h3.5',
  cpu: 'M7 7h10v10H7zM9.5 2v3M14.5 2v3M9.5 19v3M14.5 19v3M2 9.5h3M2 14.5h3M19 9.5h3M19 14.5h3',
  coin: 'M12 3a9 9 0 100 18 9 9 0 000-18zM9 9.5h6M9 14.5h6M12 7v10',
  layers: 'M12 3l9 5-9 5-9-5 9-5zM3 13l9 5 9-5',
  clock: 'M12 3a9 9 0 100 18 9 9 0 000-18zM12 7.5v5l3 1.8',
  bolt: 'M13 2L4 14h6l-1 8 9-12h-6l1-8z',
  reset: 'M4 12a8 8 0 1014-4.8M18 3v4h-4',
  wave: 'M2 12c2 0 2-5 4-5s2 10 4 10 2-10 4-10 2 5 4 5',
  back: 'M15 5l-7 7 7 7',
  dot: 'M12 12h.01',
}

function Icon({ name, size = 16 }) {
  return h('svg', {
    className: 'sm-i',
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.7,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': 'true',
  }, h('path', { d: ICONS[name] || ICONS.dot }))
}

/* ────────────────────────── 小部件 ────────────────────────── */

function LiveBadge({ paused }) {
  return h('span', { className: 'sm-live' + (paused ? ' off' : '') },
    h('i', null), paused ? 'PAUSED' : 'LIVE')
}

function Sparkline({ data, tone }) {
  const values = Array.isArray(data) && data.length ? data.map((v) => Number(v) || 0) : [0, 0]
  const height = 26
  const width = 100
  const max = Math.max(1, ...values)
  const step = values.length > 1 ? width / (values.length - 1) : width
  const points = values.map((v, i) => (values.length > 1 ? i * step : width / 2) + ',' + (height - 1 - (v / max) * (height - 4)).toFixed(2))
  const color = TONE[tone] || TONE.brand
  return h('svg', {
    className: 'sm-spark',
    viewBox: '0 0 ' + width + ' ' + height,
    preserveAspectRatio: 'none',
    'aria-hidden': 'true',
  },
    h('polygon', { points: '0,' + height + ' ' + points.join(' ') + ' ' + width + ',' + height, fill: color, opacity: 0.13 }),
    h('polyline', {
      points: points.join(' '),
      fill: 'none',
      stroke: color,
      strokeWidth: 1.4,
      strokeLinejoin: 'round',
      strokeLinecap: 'round',
      vectorEffect: 'non-scaling-stroke',
    }))
}

/* ────────────────────────── 指标卡定义 ────────────────────────── */

function msShort(ms) {
  const v = Number(ms) || 0
  if (v >= 10000) return (v / 1000).toFixed(1) + 's'
  if (v >= 1000) return (v / 1000).toFixed(2) + 's'
  return Math.round(v) + 'ms'
}

const METRICS = {
  latency: {
    tone: 'brand',
    icon: 'clock',
    value: (v) => (v.latency.avg >= 1000 ? (v.latency.avg / 1000).toFixed(1) : compact(v.latency.avg)),
    unit: (v) => (v.latency.avg >= 1000 ? 's' : 'ms'),
    sub: (v) => 'P95 ' + msShort(v.latency.p95) + ' · 峰值 ' + msShort(v.latency.max),
    spark: (v) => v.series.map((p) => p.avgMs),
  },
  loss: {
    tone: (v) => (v.loss.rate >= 5 ? 'err' : v.loss.rate > 0 ? 'warn' : 'ok'),
    icon: 'alert',
    value: (v) => (v.loss.rate >= 10 ? Math.round(v.loss.rate) : v.loss.rate.toFixed(1)),
    unit: '%',
    sub: (v) => v.loss.dropped + ' 丢失 / ' + v.loss.attempts + ' 调用',
    spark: (v) => v.series.map((p) => p.dropped),
  },
  errors: {
    tone: (v) => (v.totals.errors > 0 ? 'err' : 'ok'),
    icon: 'alert',
    value: (v) => compact(v.totals.errors),
    unit: '次',
    sub: (v) => '错误率 ' + v.errorRate + '% · agent ' + v.totals.agentErrors,
    spark: (v) => v.series.map((p) => p.errors),
  },
  inflight: {
    tone: 'warn',
    icon: 'bolt',
    value: (v) => String(v.inflight.length),
    unit: '个',
    sub: (v) => (v.inflight.length ? v.inflight.map((x) => x.name).slice(0, 2).join(' · ') : '当前空闲'),
    spark: null,
  },
  ops: {
    tone: 'brand',
    icon: 'wave',
    value: (v) => compact(v.opsPerMin),
    unit: '/分',
    sub: (v) => '窗口内 ' + v.series.reduce((a, b) => a + b.ops, 0) + ' 次调用',
    spark: (v) => v.series.map((p) => p.ops),
  },
  tokens: {
    tone: 'brand',
    icon: 'coin',
    value: (v) => compact(v.tokens.total),
    unit: 'tok',
    sub: (v) => '入 ' + compact(v.tokens.input) + ' · 出 ' + compact(v.tokens.output),
    spark: (v) => v.series.map((p) => p.tokens),
  },
  throughput: {
    tone: 'ok',
    icon: 'layers',
    value: (v) => bytesText(v.bytes.perSec),
    unit: '/s',
    sub: (v) => '入 ' + bytesText(v.bytes.in) + ' · 出 ' + bytesText(v.bytes.out),
    spark: (v) => v.series.map((p) => p.bytes),
  },
  exec: {
    tone: 'idle',
    icon: 'clock',
    value: (v) => (v.totals.execMs / 1000).toFixed(1),
    unit: 's',
    sub: (v) => '单次均值 ' + compact(v.latency.avg) + 'ms',
    spark: (v) => v.series.map((p) => p.avgMs),
  },
  cpu: {
    tone: (v) => (v.cpu.percent >= 70 ? 'err' : v.cpu.percent >= 35 ? 'warn' : 'ok'),
    icon: 'cpu',
    value: (v) => (v.cpu.percent >= 10 ? Math.round(v.cpu.percent) : v.cpu.percent.toFixed(1)),
    unit: '%',
    sub: (v) => (v.cpu.cores ? v.cpu.cores + ' 逻辑核心 · 宿主进程' : '宿主进程'),
    spark: null,
  },
  memory: {
    tone: 'idle',
    icon: 'layers',
    value: (v) => String(v.memory.rss),
    unit: 'MB',
    sub: (v) => '堆 ' + v.memory.heap + ' MB',
    spark: null,
  },
  blocked: {
    tone: (v) => (v.totals.blocked > 0 ? 'warn' : 'ok'),
    icon: 'terminal',
    value: (v) => compact(v.totals.blocked),
    unit: '次',
    sub: (v) => '拒绝 ' + v.totals.denied + ' · 取消 ' + v.totals.cancelled,
    spark: (v) => v.series.map((p) => p.dropped),
  },
}

function KpiCard({ metric, snap, onRemove }) {
  const meta = METRICS[metric.id]
  if (!meta) return null
  const tone = typeof meta.tone === 'function' ? meta.tone(snap) : meta.tone
  let value = '—'
  let unit = metric.unit || ''
  let sub = ''
  let spark = null
  try {
    value = meta.value(snap)
    if (typeof meta.unit === 'function') unit = meta.unit(snap)
    else if (typeof meta.unit === 'string') unit = meta.unit
    sub = meta.sub ? meta.sub(snap) : ''
    if (meta.spark) spark = meta.spark(snap)
  } catch { /* 快照形状异常时保持占位 */ }
  return h('div', { className: 'sm-card', title: metric.hint || '' },
    h('div', { className: 'sm-k' },
      h(Icon, { name: meta.icon, size: 12 }),
      h('span', null, metric.label)),
    h('div', { className: 'sm-v', style: { color: tone === 'brand' ? 'var(--sm-text)' : TONE[tone] || TONE.brand } },
      h('span', null, value),
      unit ? h('em', null, unit) : null),
    sub ? h('div', { className: 'sm-sub' }, sub) : null,
    spark ? h(Sparkline, { data: spark, tone }) : null,
    h('button', {
      className: 'sm-card-x',
      title: '移除这个指标',
      'aria-label': '移除 ' + metric.label,
      onClick: (event) => { event.stopPropagation(); onRemove(metric.id) },
    }, h(Icon, { name: 'close', size: 10 })))
}

function ToolBars({ snap }) {
  const rows = snap.tools.slice(0, 5)
  const max = rows.reduce((a, b) => Math.max(a, b.calls), 1)
  if (!rows.length) return h('div', { className: 'sm-empty-row' }, snap.inflight.length ? '调用进行中，完成后统计' : '暂无已完成的调用')
  return h('div', { className: 'sm-bars' }, rows.map((row) => h('div', { className: 'sm-bar-row', key: row.name, title: row.name + ' · 错误 ' + row.errors + ' · 平均 ' + row.avgMs + 'ms' },
    h('span', { className: 'sm-bar-name' }, row.name),
    h('span', { className: 'sm-bar-track' }, h('span', { className: 'sm-bar-fill', style: { width: Math.max(4, (row.calls / max) * 100) + '%' } })),
    h('span', { className: 'sm-bar-val' }, compact(row.calls)))))
}

function ErrorCodes({ snap }) {
  if (!snap.errorCodes.length) return h('div', { className: 'sm-empty-row' }, '暂无报错，沙箱很干净')
  return h('div', { className: 'sm-chips' }, snap.errorCodes.map((row) => h('span', { className: 'sm-chip err', key: row.code, title: row.code },
    h('b', null, row.code.length > 26 ? row.code.slice(0, 26) + '…' : row.code),
    h('i', null, String(row.count)))))
}

function EventRow({ event }) {
  const cls = event.kind === 'error' || event.kind === 'agent' ? 'err' : event.kind === 'blocked' ? 'blk' : 'ok'
  const glyph = cls === 'err' ? '×' : cls === 'blk' ? '⊘' : '✓'
  return h('div', { className: 'sm-log ' + cls, title: (event.name || '') + ' ' + (event.detail || '') },
    h('span', { className: 't' }, clockText(event.t)),
    h('span', { className: 'n' }, event.name || '—'),
    h('span', { className: 'd' }, event.detail || event.status || ''),
    h('span', { className: 's' }, event.ms ? event.ms + 'ms ' : ''),
    h('span', { className: 'g' }, glyph))
}

function EventList({ snap, limit }) {
  const rows = snap.events.slice(0, limit || 8)
  if (!rows.length) return h('div', { className: 'sm-empty-row' }, '静候第一次沙箱调用…')
  return h('div', { className: 'sm-logs' }, rows.map((event, index) => h(EventRow, { event, key: (event.t || 0) + ':' + index })))
}

function WideCard({ metric, snap, onRemove, children }) {
  return h('div', { className: 'sm-card sm-card-wide' },
    h('div', { className: 'sm-k' }, h('span', null, metric.label),
      h('button', {
        className: 'sm-card-x wide',
        title: '移除这个指标',
        onClick: () => onRemove(metric.id),
      }, h(Icon, { name: 'close', size: 10 }))),
    children)
}

function PreviewPanel({ snap }) {
  const ops = snap.events.filter((event) => event.kind === 'ok' || event.kind === 'error' || event.kind === 'blocked').slice(0, 6)
  return h('div', { className: 'sm-preview' },
    h('div', { className: 'sm-preview-head' },
      h('div', { className: 'sm-preview-title' },
        h(Icon, { name: 'terminal', size: 13 }),
        h('span', null, '沙箱预览'),
        h('span', { className: 'sm-mode' + (snap.mode === 'danger-full-access' ? ' danger' : '') },
          MODE_LABEL[snap.mode] || snap.mode)),
      h('span', { className: 'sm-preview-count' }, snap.inflight.length ? snap.inflight.length + ' 个进行中' : '空闲')),
    h('div', { className: 'sm-preview-path', title: snap.workspaceRoot || '' }, shortPath(snap.workspaceRoot)),
    h('div', { className: 'sm-preview-body' }, ops.length ? ops.map((event, index) => h(EventRow, { event, key: (event.t || 0) + ':' + index })) : h('div', { className: 'sm-empty-row' }, '等待沙箱调用…')),
    h('div', { className: 'sm-preview-foot' },
      h('span', null, '调用 ' + snap.totals.attempts + ' · 放行 ' + snap.totals.allowed + ' · 拦截 ' + snap.totals.blocked),
      h('span', null, '运行 ' + durationText(snap.uptimeMs))))
}

/* ────────────────────────── 监视选项（整页视图） ────────────────────────── */

function OptionsView({ snap, onClose, onToggle, onRefreshChange, onReset, resetArmed }) {
  const enabled = new Set((snap.config && snap.config.enabled) || [])
  const groups = []
  const index = new Map()
  for (const metric of snap.catalog) {
    if (!index.has(metric.group)) {
      index.set(metric.group, [])
      groups.push(metric.group)
    }
    index.get(metric.group).push(metric)
  }
  return h('div', { className: 'sm-options' },
    h('div', { className: 'sm-head sm-options-head' },
      h('button', { className: 'sm-iconbtn', onClick: onClose, title: '返回看板' }, h(Icon, { name: 'back', size: 14 })),
      h('div', { className: 'sm-title' },
        h('span', { className: 'sm-logo' }, h(Icon, { name: 'sliders', size: 14 })),
        h('span', null, '监视选项')),
      h('span', { className: 'sm-count' }, (snap.config && snap.config.enabled ? snap.config.enabled.length : 0) + ' / ' + snap.catalog.length)),
    h('div', { className: 'sm-options-body' },
      h('div', { className: 'sm-note' }, '开启即展示该指标卡；关闭只影响展示，采样器仍保留历史数据。'),
      groups.map((group) => h('div', { className: 'sm-group', key: group },
        h('div', { className: 'sm-group-title' }, group),
        index.get(group).map((metric) => h('div', { className: 'sm-row', key: metric.id },
          h('div', { className: 'sm-row-main' },
            h('div', { className: 'sm-row-title' }, metric.label),
            h('div', { className: 'sm-row-hint' }, metric.hint)),
          h('button', {
            className: 'sm-switch' + (enabled.has(metric.id) ? ' on' : ''),
            onClick: () => onToggle(metric.id),
            'aria-pressed': enabled.has(metric.id),
            title: enabled.has(metric.id) ? '关闭' : '开启',
          }))))),
      h('div', { className: 'sm-group' },
        h('div', { className: 'sm-group-title' }, '采样'),
        h('div', { className: 'sm-row' },
          h('div', { className: 'sm-row-main' },
            h('div', { className: 'sm-row-title' }, '刷新间隔'),
            h('div', { className: 'sm-row-hint' }, '轮询快照的频率')),
          h('select', {
            className: 'sm-select',
            value: String((snap.config && snap.config.refreshMs) || 1500),
            onChange: (event) => onRefreshChange(Number(event.target.value)),
          },
            [[1000, '1 秒'], [1500, '1.5 秒'], [3000, '3 秒'], [5000, '5 秒']].map(([value, label]) =>
              h('option', { value: String(value), key: String(value) }, label)))),
        h('div', { className: 'sm-row' },
          h('div', { className: 'sm-row-main' },
            h('div', { className: 'sm-row-title' }, '清空统计'),
            h('div', { className: 'sm-row-hint' }, '归零当前进程内的全部计数器')),
          h('button', {
            className: 'sm-danger' + (resetArmed ? ' armed' : ''),
            onClick: onReset,
          }, resetArmed ? '再点确认' : '清空')))),
    h('div', { className: 'sm-options-foot' },
      h('span', null, 'v' + VERSION + ' · 快照窗口 ' + ((snap.config && snap.config.windowSec) || 60) + 's'),
      h('button', { className: 'sm-btn', onClick: onClose }, '完成')))
}

/* ────────────────────────── 主面板 ────────────────────────── */

function MonitorTab() {
  const [snap, error, paused] = useSnapshot()
  const [drawer, setDrawer] = useState(false)
  const [resetArmed, setResetArmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const resetTimer = useRef(null)

  useEffect(() => () => { if (resetTimer.current) clearTimeout(resetTimer.current) }, [])

  const patchConfig = useCallback(async (patch) => {
    setBusy(true)
    try {
      const result = await postJson('config', patch)
      if (result && result.ok && store.data) {
        store.data = { ...store.data, config: { ...store.data.config, ...result.config } }
        store.emit()
      }
    } catch { /* 失败保留旧值，下一轮轮询会纠正 */ } finally {
      setBusy(false)
      store.lastAt = 0
      void tick()
    }
  }, [])

  const toggleMetric = useCallback((id) => {
    if (!snap) return
    const current = (snap.config && snap.config.enabled) || []
    const next = current.includes(id) ? current.filter((x) => x !== id) : current.concat(id)
    void patchConfig({ enabled: next })
  }, [snap, patchConfig])

  const removeMetric = useCallback((id) => { toggleMetric(id) }, [toggleMetric])

  const togglePause = useCallback(() => {
    store.paused = !store.paused
    store.emit()
    if (!store.paused) { store.lastAt = 0; void tick() }
  }, [])

  const doReset = useCallback(async () => {
    if (!resetArmed) {
      setResetArmed(true)
      if (resetTimer.current) clearTimeout(resetTimer.current)
      resetTimer.current = setTimeout(() => setResetArmed(false), 3200)
      return
    }
    setResetArmed(false)
    try {
      await postJson('reset', {})
    } catch { /* ignore */ }
    store.lastAt = 0
    void tick()
  }, [resetArmed])

  const enabledIds = (snap && snap.config && snap.config.enabled) || []
  const catalog = (snap && snap.catalog) || []
  const byId = useMemo(() => {
    const map = new Map()
    for (const metric of catalog) map.set(metric.id, metric)
    return map
  }, [catalog])
  const ordered = enabledIds.map((id) => byId.get(id)).filter(Boolean)

  const kpis = ordered.filter((metric) => metric.card !== 'list')
  const wide = ordered.filter((metric) => metric.card === 'list')

  if (drawer && snap) {
    return h('div', { className: 'sm-root' },
      h(OptionsView, {
        snap,
        onClose: () => setDrawer(false),
        onToggle: toggleMetric,
        onRefreshChange: (ms) => void patchConfig({ refreshMs: ms }),
        onReset: doReset,
        resetArmed,
      }))
  }

  return h('div', { className: 'sm-root' },
    h('div', { className: 'sm-head' },
      h('div', { className: 'sm-title' },
        h('span', { className: 'sm-logo' }, h(Icon, { name: 'pulse', size: 15 })),
        h('span', null, '沙箱监视'),
        h(LiveBadge, { paused })),
      h('div', { className: 'sm-actions' },
        h('button', { className: 'sm-iconbtn', title: paused ? '继续采样' : '暂停轮询', onClick: togglePause },
          h(Icon, { name: paused ? 'play' : 'pause', size: 13 })),
        h('button', { className: 'sm-iconbtn' + (drawer ? ' on' : ''), title: '增减监视选项', onClick: () => setDrawer(true) },
          h(Icon, { name: 'sliders', size: 13 })),
        h('button', { className: 'sm-iconbtn' + (resetArmed ? ' danger' : ''), title: resetArmed ? '再次点击清空统计' : '清空统计', onClick: doReset },
          h(Icon, { name: 'reset', size: 13 })))),
    error && !snap
      ? h('div', { className: 'sm-offline' },
        h(Icon, { name: 'alert', size: 16 }),
        h('div', null,
          h('div', { className: 'sm-offline-title' }, '宿主未响应'),
          h('div', { className: 'sm-offline-hint' }, error),
          h('button', { className: 'sm-btn', onClick: () => { store.lastAt = 0; void tick() } }, '重试')))
      : !snap
        ? h('div', { className: 'sm-skeleton' },
          h('div', { className: 'sm-skel-strip' }),
          h('div', { className: 'sm-skel-grid' }, [0, 1, 2, 3, 4, 5].map((i) => h('div', { className: 'sm-skel-card', key: i }))),
          h('div', { className: 'sm-skel-note' }, '连接沙箱采样器…'))
        : h('div', { className: 'sm-scroll' },
          h('div', { className: 'sm-summary' },
            h('div', { className: 'sm-sum-cell' }, h('b', null, compact(snap.opsPerMin)), h('span', null, '调用 / 分')),
            h('div', { className: 'sm-sum-cell' }, h('b', null, String(snap.inflight.length)), h('span', null, '并发')),
            h('div', { className: 'sm-sum-cell' }, h('b', null, durationText(snap.uptimeMs)), h('span', null, '运行')),
            h('div', { className: 'sm-sum-cell' }, h('b', { style: { color: snap.totals.errors ? TONE.err : TONE.ok } }, String(snap.totals.errors)), h('span', null, '报错'))),
          h(PreviewPanel, { snap }),
          ordered.length
            ? h('div', { className: 'sm-grid' },
              kpis.map((metric) => h(KpiCard, { metric, snap, key: metric.id, onRemove: removeMetric })),
              wide.map((metric) => h(WideCard, { metric, snap, key: metric.id, onRemove: removeMetric },
                metric.id === 'tools' ? h(ToolBars, { snap }) : metric.id === 'errorcodes' ? h(ErrorCodes, { snap }) : h(EventList, { snap, limit: 10 }))),
              h('button', { className: 'sm-add', onClick: () => setDrawer(true) },
                h(Icon, { name: 'plus', size: 13 }),
                h('span', null, '添加指标')))
            : h('div', { className: 'sm-blank' },
              h(Icon, { name: 'layers', size: 22 }),
              h('div', null, '还没有选中的指标'),
              h('button', { className: 'sm-btn', onClick: () => setDrawer(true) }, '选择要监视的指标')),
          h('div', { className: 'sm-foot' },
            h('span', null, 'v' + VERSION),
            h('span', null, '每 ' + (((snap.config && snap.config.refreshMs) || 1500) / 1000) + 's 采样'),
            h('span', { className: 'sm-dot' }),
            h('span', null, snap.mode === 'danger-full-access' ? '完全权限' : MODE_LABEL[snap.mode] || snap.mode),
            busy ? h('span', { className: 'sm-busy' }, '同步中…') : null)))
}

/* ────────────────────────── 侧栏入口按钮 ────────────────────────── */

let ctxRef = null

function openMonitorTab() {
  try {
    const face = ctxRef && ctxRef.get('sidebarRight')
    if (face && typeof face.openTab === 'function') {
      face.openTab(TAB_TYPE)
      return true
    }
  } catch { /* ignore */ }
  return false
}

function FooterButton() {
  const [snap] = useSnapshot()
  const alert = !!snap && (snap.totals.errors > 0 || snap.loss.rate >= 5)
  return h('button', {
    className: 'sm-foot-btn',
    title: alert ? '沙箱监视 · 有报错或丢包' : '沙箱监视 · 延迟 / 丢包 / 报错 / 消耗',
    'aria-label': '打开沙箱监视',
    onClick: () => openMonitorTab(),
  },
    h(Icon, { name: 'pulse', size: 16 }),
    alert ? h('span', { className: 'sm-foot-dot' }) : null)
}

/* ────────────────────────── 样式 ────────────────────────── */

const CSS = `
.sm-root{
  --sm-bg: var(--dsw-alias-bg-base, #14161c);
  --sm-layer: var(--dsw-alias-bg-layer-1, #1b1e26);
  --sm-layer2: var(--dsw-alias-bg-layer-2, #232733);
  --sm-border: var(--dsw-alias-border-l1, rgba(128,138,160,.18));
  --sm-border2: var(--dsw-alias-border-l2, rgba(128,138,160,.32));
  --sm-text: var(--dsw-alias-label-primary, #eef1f6);
  --sm-muted: var(--dsw-alias-label-secondary, #98a0b0);
  --sm-brand: var(--dsw-alias-brand-primary, #4d6bfe);
  --sm-ok: var(--dsw-alias-state-success-primary, #37d39b);
  --sm-warn: var(--dsw-alias-state-warn-primary, #f2b03d);
  --sm-err: var(--dsw-alias-state-error-primary, #ff6b6b);
  --sm-sidebar: var(--dsw-specific-sidebar-fill, #171a21);
  position: relative;
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  color: var(--sm-text);
  font-size: 13px;
  line-height: 1.45;
  background: var(--sm-sidebar);
  overflow: hidden;
}
@supports (background: color-mix(in srgb, red 50%, transparent)) {
  .sm-root{ background: color-mix(in srgb, var(--sm-sidebar) 62%, transparent); backdrop-filter: blur(18px) saturate(1.25); }
}
.sm-i{ flex: none; display: block; }
.sm-head{ display: flex; align-items: center; gap: 8px; padding: 11px 12px 8px; }
.sm-title{ display: flex; align-items: center; gap: 7px; min-width: 0; flex: 1; font-weight: 600; font-size: 13px; letter-spacing: .2px; }
.sm-logo{ display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 24px; border-radius: 8px; color: var(--sm-brand);
  background: color-mix(in srgb, var(--sm-brand) 13%, transparent); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--sm-brand) 22%, transparent); }
.sm-live{ display: inline-flex; align-items: center; gap: 5px; font-size: 9px; font-weight: 700; letter-spacing: .1em; color: var(--sm-ok);
  padding: 2px 7px 2px 6px; border-radius: 999px; background: color-mix(in srgb, var(--sm-ok) 12%, transparent); }
.sm-live.off{ color: var(--sm-muted); background: color-mix(in srgb, var(--sm-muted) 12%, transparent); }
.sm-live i{ width: 5px; height: 5px; border-radius: 50%; background: currentColor; animation: sm-pulse 1.9s ease-out infinite; }
.sm-live.off i{ animation: none; }
@keyframes sm-pulse{ 0%{ box-shadow: 0 0 0 0 color-mix(in srgb, var(--sm-ok) 55%, transparent) } 70%{ box-shadow: 0 0 0 5px color-mix(in srgb, var(--sm-ok) 0%, transparent) } 100%{ box-shadow: 0 0 0 0 transparent } }
.sm-actions{ display: flex; align-items: center; gap: 2px; }
.sm-iconbtn{ display: inline-flex; align-items: center; justify-content: center; width: 26px; height: 26px; border-radius: 8px; border: 1px solid transparent;
  background: transparent; color: var(--sm-muted); cursor: pointer; padding: 0; transition: background .14s, color .14s, border-color .14s; }
.sm-iconbtn:hover{ background: color-mix(in srgb, var(--sm-text) 8%, transparent); color: var(--sm-text); }
.sm-iconbtn.on{ color: var(--sm-brand); background: color-mix(in srgb, var(--sm-brand) 12%, transparent); }
.sm-iconbtn.danger{ color: var(--sm-err); border-color: color-mix(in srgb, var(--sm-err) 40%, transparent); }
.sm-scroll{ flex: 1; min-height: 0; overflow-y: auto; overflow-x: hidden; padding-bottom: 4px; scrollbar-width: thin; }
.sm-scroll::-webkit-scrollbar{ width: 6px; }
.sm-scroll::-webkit-scrollbar-thumb{ background: color-mix(in srgb, var(--sm-text) 14%, transparent); border-radius: 3px; }
.sm-summary{ display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 6px; padding: 2px 12px 10px; }
.sm-sum-cell{ display: flex; flex-direction: column; gap: 1px; padding: 6px 8px; border-radius: 10px; border: 1px solid var(--sm-border);
  background: color-mix(in srgb, var(--sm-layer2) 32%, transparent); }
.sm-sum-cell b{ font-size: 14px; font-weight: 650; font-variant-numeric: tabular-nums; letter-spacing: -.01em; }
.sm-sum-cell span{ font-size: 9.5px; color: var(--sm-muted); letter-spacing: .02em; white-space: nowrap; }
.sm-preview{ margin: 0 12px 10px; border: 1px solid var(--sm-border); border-radius: 12px; overflow: hidden;
  background: color-mix(in srgb, var(--sm-layer2) 42%, transparent); }
.sm-preview-head{ display: flex; align-items: center; gap: 8px; padding: 7px 9px 5px; }
.sm-preview-title{ display: flex; align-items: center; gap: 6px; flex: 1; min-width: 0; font-size: 11px; font-weight: 600; color: var(--sm-muted); }
.sm-mode{ font-size: 9.5px; font-weight: 600; color: var(--sm-brand); background: color-mix(in srgb, var(--sm-brand) 12%, transparent);
  padding: 1px 6px; border-radius: 999px; white-space: nowrap; }
.sm-mode.danger{ color: var(--sm-warn); background: color-mix(in srgb, var(--sm-warn) 13%, transparent); }
.sm-preview-count{ font-size: 9.5px; color: var(--sm-muted); white-space: nowrap; }
.sm-preview-path{ padding: 0 10px 5px; font-size: 10px; color: var(--sm-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.sm-preview-body{ min-height: 54px; padding: 3px 0 4px; border-top: 1px solid color-mix(in srgb, var(--sm-border) 70%, transparent); }
.sm-preview-foot{ display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 4px 10px 5px;
  border-top: 1px solid color-mix(in srgb, var(--sm-border) 70%, transparent); font-size: 9.5px; color: var(--sm-muted); }
.sm-logs{ display: flex; flex-direction: column; }
.sm-log{ display: grid; grid-template-columns: 44px 62px minmax(0,1fr) auto 9px; align-items: center; gap: 5px;
  padding: 2px 10px; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 10px; }
.sm-log .t{ color: var(--sm-muted); }
.sm-log .n{ color: var(--sm-brand); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sm-log .d{ color: var(--sm-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sm-log .s{ color: var(--sm-muted); text-align: right; font-variant-numeric: tabular-nums; }
.sm-log .g{ text-align: center; font-weight: 700; }
.sm-log.ok .g{ color: var(--sm-ok); }
.sm-log.err .g{ color: var(--sm-err); }
.sm-log.blk .g{ color: var(--sm-warn); }
.sm-log.err .d{ color: color-mix(in srgb, var(--sm-err) 78%, var(--sm-muted)); }
.sm-grid{ display: grid; grid-template-columns: repeat(2, minmax(0,1fr)); gap: 7px; padding: 0 12px 12px; }
.sm-card{ position: relative; min-width: 0; border: 1px solid var(--sm-border); border-radius: 12px; padding: 8px 9px 7px;
  background: color-mix(in srgb, var(--sm-layer2) 38%, transparent); transition: border-color .14s, background .14s, transform .14s; }
.sm-card:hover{ border-color: var(--sm-border2); background: color-mix(in srgb, var(--sm-layer2) 52%, transparent); }
.sm-card-wide{ grid-column: 1 / -1; }
.sm-k{ display: flex; align-items: center; gap: 5px; font-size: 10.5px; color: var(--sm-muted); min-width: 0; }
.sm-k > span:first-of-type{ overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sm-v{ display: flex; align-items: baseline; gap: 3px; margin-top: 2px; font-size: 20px; font-weight: 650; letter-spacing: -.02em;
  font-variant-numeric: tabular-nums; line-height: 1.15; }
.sm-v em{ font-style: normal; font-size: 10.5px; font-weight: 500; color: var(--sm-muted); letter-spacing: 0; }
.sm-sub{ margin-top: 1px; font-size: 10px; color: var(--sm-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sm-spark{ display: block; width: 100%; height: 24px; margin-top: 4px; }
.sm-card-x{ position: absolute; top: 5px; right: 5px; display: inline-flex; align-items: center; justify-content: center; width: 17px; height: 17px;
  padding: 0; border: none; border-radius: 5px; background: color-mix(in srgb, var(--sm-text) 8%, transparent); color: var(--sm-muted);
  cursor: pointer; opacity: 0; transition: opacity .14s, background .14s, color .14s; }
.sm-card:hover .sm-card-x{ opacity: 1; }
.sm-card-x:hover{ background: color-mix(in srgb, var(--sm-err) 16%, transparent); color: var(--sm-err); }
.sm-card-x.wide{ position: static; margin-left: auto; opacity: 0; flex: none; }
.sm-card-wide:hover .sm-card-x.wide{ opacity: 1; }
.sm-bars{ display: flex; flex-direction: column; gap: 5px; margin-top: 7px; }
.sm-bar-row{ display: grid; grid-template-columns: 66px minmax(0,1fr) 34px; align-items: center; gap: 7px; }
.sm-bar-name{ font-size: 10.5px; color: var(--sm-text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sm-bar-track{ height: 5px; border-radius: 3px; overflow: hidden; background: color-mix(in srgb, var(--sm-text) 8%, transparent); }
.sm-bar-fill{ display: block; height: 100%; border-radius: 3px; background: linear-gradient(90deg, var(--sm-brand), color-mix(in srgb, var(--sm-brand) 45%, #7ee7ff)); }
.sm-bar-val{ font-size: 10px; color: var(--sm-muted); text-align: right; font-variant-numeric: tabular-nums; }
.sm-chips{ display: flex; flex-wrap: wrap; gap: 4px; margin-top: 7px; }
.sm-chip{ display: inline-flex; align-items: center; gap: 4px; max-width: 100%; padding: 2px 6px; border-radius: 7px; font-size: 10px;
  background: color-mix(in srgb, var(--sm-text) 7%, transparent); border: 1px solid var(--sm-border); }
.sm-chip b{ font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sm-chip i{ font-style: normal; font-weight: 650; color: var(--sm-muted); font-variant-numeric: tabular-nums; }
.sm-chip.err{ border-color: color-mix(in srgb, var(--sm-err) 30%, transparent); background: color-mix(in srgb, var(--sm-err) 9%, transparent); }
.sm-chip.err i{ color: var(--sm-err); }
.sm-card-wide .sm-logs{ margin: 6px -3px 0; }
.sm-empty-row{ padding: 10px 4px; font-size: 10.5px; color: var(--sm-muted); text-align: center; }
.sm-add{ grid-column: 1 / -1; display: flex; align-items: center; justify-content: center; gap: 6px; height: 34px; border-radius: 10px;
  border: 1px dashed var(--sm-border2); background: transparent; color: var(--sm-muted); font-size: 11px; cursor: pointer;
  transition: color .14s, border-color .14s, background .14s; }
.sm-add:hover{ color: var(--sm-brand); border-color: color-mix(in srgb, var(--sm-brand) 55%, transparent); background: color-mix(in srgb, var(--sm-brand) 7%, transparent); }
.sm-foot{ display: flex; align-items: center; gap: 7px; padding: 2px 14px 10px; font-size: 9.5px; color: var(--sm-muted); }
.sm-dot{ width: 3px; height: 3px; border-radius: 50%; background: currentColor; opacity: .6; }
.sm-busy{ margin-left: auto; color: var(--sm-brand); }
.sm-blank{ display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 30px 16px; color: var(--sm-muted); font-size: 12px; }
.sm-btn{ padding: 5px 12px; border-radius: 8px; border: 1px solid var(--sm-border2); background: color-mix(in srgb, var(--sm-text) 6%, transparent);
  color: var(--sm-text); font-size: 11px; cursor: pointer; }
.sm-btn:hover{ border-color: var(--sm-brand); color: var(--sm-brand); }
.sm-offline{ margin: 20px 16px; padding: 16px; border-radius: 12px; border: 1px solid color-mix(in srgb, var(--sm-err) 30%, transparent);
  background: color-mix(in srgb, var(--sm-err) 8%, transparent); color: var(--sm-err); display: flex; flex-direction: column; gap: 8px; }
.sm-offline-title{ font-weight: 600; }
.sm-offline-hint{ font-size: 11px; color: var(--sm-muted); word-break: break-all; }
.sm-skeleton{ padding: 4px 12px; }
.sm-skel-strip{ height: 44px; border-radius: 10px; background: color-mix(in srgb, var(--sm-text) 6%, transparent); animation: sm-breathe 1.6s ease-in-out infinite; }
.sm-skel-grid{ display: grid; grid-template-columns: repeat(2, minmax(0,1fr)); gap: 7px; margin-top: 10px; }
.sm-skel-card{ height: 74px; border-radius: 12px; background: color-mix(in srgb, var(--sm-text) 5%, transparent); animation: sm-breathe 1.6s ease-in-out infinite; }
.sm-skel-note{ margin-top: 12px; font-size: 10.5px; color: var(--sm-muted); text-align: center; }
@keyframes sm-breathe{ 0%,100%{ opacity: .55 } 50%{ opacity: 1 } }
.sm-options{ display: flex; flex-direction: column; height: 100%; min-height: 0; }
.sm-options-head{ border-bottom: 1px solid var(--sm-border); padding-bottom: 9px; }
.sm-count{ flex: none; font-size: 10px; color: var(--sm-muted); font-variant-numeric: tabular-nums; }
.sm-options-body{ flex: 1; min-height: 0; overflow-y: auto; padding: 2px 14px 12px; scrollbar-width: thin; }
.sm-options-body::-webkit-scrollbar{ width: 6px; }
.sm-options-body::-webkit-scrollbar-thumb{ background: color-mix(in srgb, var(--sm-text) 14%, transparent); border-radius: 3px; }
.sm-options-foot{ display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 8px 14px 10px;
  border-top: 1px solid var(--sm-border); font-size: 9.5px; color: var(--sm-muted); }
.sm-note{ padding: 7px 0 3px; font-size: 10px; color: var(--sm-muted); }
.sm-group-title{ margin: 10px 0 2px; font-size: 9.5px; font-weight: 700; letter-spacing: .1em; color: var(--sm-muted); text-transform: uppercase; }
.sm-row{ display: flex; align-items: center; gap: 10px; padding: 7px 0; border-bottom: 1px dashed color-mix(in srgb, var(--sm-border) 80%, transparent); }
.sm-row:last-child{ border-bottom: none; }
.sm-row-main{ flex: 1; min-width: 0; }
.sm-row-title{ font-size: 11.5px; }
.sm-row-hint{ font-size: 10px; color: var(--sm-muted); margin-top: 1px; }
.sm-switch{ position: relative; flex: none; width: 34px; height: 20px; border-radius: 999px; border: 1px solid var(--sm-border2);
  background: color-mix(in srgb, var(--sm-text) 8%, transparent); cursor: pointer; padding: 0; transition: background .16s, border-color .16s; }
.sm-switch::after{ content: ''; position: absolute; top: 2px; left: 2px; width: 14px; height: 14px; border-radius: 50%;
  background: var(--sm-muted); box-shadow: 0 1px 2px rgba(0,0,0,.35); transition: transform .16s, background .16s; }
.sm-switch.on{ background: var(--sm-brand); border-color: transparent; }
.sm-switch.on::after{ transform: translateX(14px); background: #fff; }
.sm-select{ padding: 4px 7px; border-radius: 7px; border: 1px solid var(--sm-border2); background: var(--sm-layer2);
  color: var(--sm-text); font-size: 11px; cursor: pointer; }
.sm-danger{ padding: 4px 11px; border-radius: 7px; border: 1px solid color-mix(in srgb, var(--sm-err) 45%, transparent);
  background: color-mix(in srgb, var(--sm-err) 8%, transparent); color: var(--sm-err); font-size: 11px; cursor: pointer; }
.sm-danger.armed{ background: var(--sm-err); color: #fff; border-color: transparent; }
.sm-foot-btn{
  --sm-text: var(--dsw-alias-label-primary, #eef1f6);
  --sm-muted: var(--dsw-alias-label-secondary, #98a0b0);
  --sm-err: var(--dsw-alias-state-error-primary, #ff6b6b);
  --sm-sidebar: var(--dsw-specific-sidebar-fill, #171a21);
  position: relative; display: inline-flex; align-items: center; justify-content: center; width: 30px; height: 30px;
  padding: 0; border: 1px solid transparent; border-radius: 9px; background: transparent; color: var(--sm-muted);
  cursor: pointer; transition: background .14s, color .14s, border-color .14s;
}
.sm-foot-btn:hover{ color: var(--sm-text); background: color-mix(in srgb, var(--sm-text) 8%, transparent); border-color: var(--sm-border, transparent); }
.sm-foot-dot{ position: absolute; top: 4px; right: 5px; width: 6px; height: 6px; border-radius: 50%; background: var(--sm-err);
  box-shadow: 0 0 0 2px var(--sm-sidebar); animation: sm-blink 2s ease-in-out infinite; }
@keyframes sm-blink{ 0%,100%{ opacity: 1 } 50%{ opacity: .35 } }
`

function mountStyles() {
  if (typeof styles !== 'undefined' && styles && typeof styles.insert === 'function') {
    try { return styles.insert(CSS) } catch { /* fall through */ }
  }
  if (typeof document === 'undefined') return () => {}
  const existing = document.querySelector('style[data-plugin-css="' + PLUGIN_ID + '/panel.css"]')
  const el = existing || document.createElement('style')
  el.dataset.plugin = PLUGIN_ID
  el.dataset.pluginCss = PLUGIN_ID + '/panel.css'
  el.textContent = CSS
  if (!existing) (document.head || document.documentElement).appendChild(el)
  return () => { try { el.remove() } catch { /* ignore */ } }
}

/* ────────────────────────── 注册 ────────────────────────── */

const inject = ['slots', 'sidebarRightTabs']

function apply(ctx) {
  ctxRef = ctx
  ctx.effect(() => mountStyles(), 'sandbox-monitor: styles')

  const tabs = ctx.get('sidebarRightTabs')
  if (tabs && typeof tabs.register === 'function') {
    ctx.effect(() => tabs.register({
      id: TAB_TYPE,
      kind: TAB_TYPE,
      title: () => '沙箱监视',
      guide: [{
        order: 30,
        title: () => '沙箱监视',
        description: () => '延迟 / 丢包 / 报错 / 消耗实时看板，可增减指标',
        icon: (props) => h(Icon, { name: 'pulse', size: (props && props.size) || 16 }),
      }],
    }), 'sandbox-monitor: tab type')
  }

  ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({ name: 'sidebar.right.pane.tab', key: TAB_TYPE }, MonitorTab))

  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({ name: 'sidebar.footer.action', id: 'sandbox-monitor', order: 5 }, FooterButton))

  // 首次注入/安装自动展开一次，让人一眼看到面板（之后靠 footer 按钮或右栏 + 菜单）。
  ctx.effect(() => {
    const KEY = 'dsh.sandbox-monitor.opened.v1'
    let seen = false
    try { seen = localStorage.getItem(KEY) === '1' } catch { /* ignore */ }
    if (seen) return () => {}
    const timer = setTimeout(() => {
      if (openMonitorTab()) {
        try { localStorage.setItem(KEY, '1') } catch { /* ignore */ }
      }
    }, 1400)
    return () => clearTimeout(timer)
  }, 'sandbox-monitor: first open')
}

exports.apply = apply
exports.inject = inject

return module.exports
  },
})
