/**
 * @dsh-external/dsh-sandbox-monitor — host half.
 *
 * 纯采样器：观察 DSH 的工具/沙箱调用面（tools/pre-execute、tools/execute、
 * tools/result、agent/error、session/event），聚合成延迟 / 丢包 / 报错 / 消耗
 * 等指标，并通过 /sandbox-monitor/api 前缀路由把快照交给右侧栏面板。
 *
 * 设计约束（对齐 dsh-super-injector 的插件规范）：
 *  - 所有资源注册挂在 ctx.effect 上，热重载可完整清理重建；
 *  - 不注册 LLM 工具，不进 system prompt / tools schema（零 token 常驻成本）；
 *  - 采样本身不改变调用语义：waterfall 一律原样 next() 并原样返回。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const name = '@dsh-external/dsh-sandbox-monitor'

/** 硬依赖：timer（路由/健康检查）、webServer（HTTP 面）、tools（事件面已由 loader 提供）。 */
export const inject = ['timer', 'webServer']

const API_PREFIX = '/sandbox-monitor/api'
const VERSION = '0.1.0'

/** 指标目录：面板按此顺序渲染，用户可增减。`card: 'list'` 是明细卡（整宽）。 */
const CATALOG = [
  { id: 'latency', label: '调用延迟', unit: 'ms', group: '核心', hint: '工具调用分发耗时：均值 / P95 / 峰值' },
  { id: 'loss', label: '丢包率', unit: '%', group: '核心', hint: '被策略拦截、取消或超时未返回的调用占比' },
  { id: 'errors', label: '报错次数', unit: '次', group: '核心', hint: '工具失败 + Agent 级异常总数' },
  { id: 'inflight', label: '并发调用', unit: '个', group: '核心', hint: '当前仍在执行的沙箱调用' },
  { id: 'ops', label: '调用频次', unit: '/分', group: '核心', hint: '最近一分钟的沙箱调用次数' },
  { id: 'tokens', label: 'Token 消耗', unit: 'tok', group: '消耗', hint: '本进程内模型输入 / 输出 token 累计' },
  { id: 'throughput', label: '数据吞吐', unit: 'B/s', group: '消耗', hint: '入参 + 结果内容的字节吞吐（最近窗口）' },
  { id: 'exec', label: '累计执行', unit: 's', group: '消耗', hint: '沙箱调用累计耗时与单次均值' },
  { id: 'cpu', label: 'CPU 占用', unit: '%', group: '资源', hint: 'DSH 宿主进程 CPU 占用（跨核累加）' },
  { id: 'memory', label: '内存占用', unit: 'MB', group: '资源', hint: '宿主进程 RSS 常驻内存' },
  { id: 'blocked', label: '拦截次数', unit: '次', group: '安全', hint: '策略拒绝 / 取消 / 审批拒绝的调用' },
  { id: 'tools', label: '工具分布', unit: '', group: '明细', card: 'list', hint: '按调用次数排序的工具明细' },
  { id: 'errorcodes', label: '错误码', unit: '', group: '明细', card: 'list', hint: '失败调用的错误码聚合' },
  { id: 'events', label: '实时事件', unit: '', group: '明细', card: 'list', hint: '最近的沙箱调用流水' },
]

const DEFAULT_ENABLED = [
  'latency', 'loss', 'errors', 'inflight', 'tokens', 'cpu', 'tools', 'events',
]

const stateDir = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'sandbox-monitor')
const configPath = join(stateDir, 'config.json')

function loadConfig() {
  const cfg = {
    enabled: DEFAULT_ENABLED.slice(),
    windowSec: 60,
    refreshMs: 1500,
    maxEvents: 40,
  }
  try {
    const raw = JSON.parse(readFileSync(configPath, 'utf8'))
    if (Array.isArray(raw.enabled)) {
      const known = new Set(CATALOG.map((m) => m.id))
      cfg.enabled = raw.enabled.filter((id) => known.has(id))
    }
    if (Number.isFinite(raw.windowSec)) cfg.windowSec = clamp(Math.round(raw.windowSec), 15, 600)
    if (Number.isFinite(raw.refreshMs)) cfg.refreshMs = clamp(Math.round(raw.refreshMs), 500, 30000)
    if (Number.isFinite(raw.maxEvents)) cfg.maxEvents = clamp(Math.round(raw.maxEvents), 10, 200)
  } catch { /* 首次运行无配置 */ }
  return cfg
}

function saveConfig(cfg) {
  try {
    mkdirSync(stateDir, { recursive: true })
    writeFileSync(configPath, JSON.stringify(cfg, null, 2), 'utf8')
  } catch { /* 配置落盘失败不影响采样 */ }
}

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n))
const now = () => Date.now()

function safeArgBytes(args) {
  try {
    if (args === undefined) return 0
    const text = JSON.stringify(args)
    return typeof text === 'string' ? text.length : 0
  } catch {
    return 0
  }
}

function contentBytes(content) {
  if (!Array.isArray(content)) return 0
  let n = 0
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    if (typeof block.text === 'string') n += block.text.length
    else if (block.attachment && Number.isFinite(block.attachment.bytes)) n += block.attachment.bytes
    else n += 16
  }
  return n
}

/** 一行沙箱操作摘要：命令 / 路径 / 模式，用于预览与事件流。 */
function summarizeArgs(toolName, args) {
  if (!args || typeof args !== 'object') return ''
  const one = (value) => String(value).replace(/\s+/g, ' ').trim().slice(0, 72)
  const text = (value) => (typeof value === 'string' ? value : '')
  const name = String(toolName || '')
  if (name === 'pwsh' || name === 'bash') {
    const command = text(args.command) || text(args.script) || text(args.code)
    return command ? one(command) : ''
  }
  if (name === 'read' || name === 'write' || name === 'edit' || name === 'read_image') {
    const target = text(args.path) || text(args.file_path) || text(args.url)
    return one(target + (args.offset ? ' @' + args.offset : ''))
  }
  if (name === 'grep' || name === 'glob') return one(text(args.pattern) + (args.path ? '  ' + text(args.path) : ''))
  if (name === 'web_fetch') return one(text(args.url))
  if (name === 'web_search') return one(Array.isArray(args.queries) ? args.queries.join(' · ') : text(args.query))
  if (name === 'skill') return one(text(args.name))
  for (const value of Object.values(args)) {
    if (typeof value === 'string' && value.trim()) return one(value)
  }
  return ''
}

function createStats() {
  return {
    startedAt: now(),
    attempts: 0,
    allowed: 0,
    blocked: 0,
    denied: 0,
    cancelled: 0,
    dropped: 0,
    results: 0,
    errors: 0,
    agentErrors: 0,
    bytesIn: 0,
    bytesOut: 0,
    tokens: { input: 0, output: 0, total: 0 },
    durations: [],
    timings: new Map(),
    inflight: new Map(),
    tools: new Map(),
    errorCodes: new Map(),
    blockCodes: new Map(),
    events: [],
    buckets: new Map(),
  }
}

export function apply(ctx, config) {
  // 配置：注入时可用 entry config 覆盖，面板可在线改（落盘到 ~/.dsh/sandbox-monitor）。
  const cfg = loadConfig()
  if (config && Array.isArray(config.enabled)) {
    const known = new Set(CATALOG.map((m) => m.id))
    cfg.enabled = config.enabled.filter((id) => known.has(id))
  }
  const s = createStats()
  let prevCpu = process.cpuUsage()
  let prevCpuAt = now()
  let cpuPercent = 0

  const bucketOf = (ts) => {
    const sec = Math.floor(ts / 1000)
    let b = s.buckets.get(sec)
    if (!b) {
      b = { ops: 0, errors: 0, dropped: 0, ms: 0, done: 0, tokens: 0, bytes: 0 }
      s.buckets.set(sec, b)
    }
    return b
  }

  const pushEvent = (event) => {
    s.events.unshift(event)
    const max = cfg.maxEvents
    if (s.events.length > max) s.events.length = max
  }

  const toolOf = (toolName) => {
    const key = String(toolName || 'unknown')
    let t = s.tools.get(key)
    if (!t) {
      t = { name: key, calls: 0, errors: 0, blocked: 0, ms: 0, bytes: 0 }
      s.tools.set(key, t)
    }
    return t
  }

  const bump = (map, key, by = 1) => {
    if (!key) return
    map.set(key, (map.get(key) || 0) + by)
  }

  const sampleCpu = () => {
    try {
      const usage = process.cpuUsage()
      const at = now()
      const elapsedUs = Math.max(1, (at - prevCpuAt) * 1000)
      const deltaUs = (usage.user - prevCpu.user) + (usage.system - prevCpu.system)
      cpuPercent = clamp(Math.round((deltaUs / elapsedUs) * 1000) / 10, 0, 100 * 64)
      prevCpu = usage
      prevCpuAt = at
    } catch { /* ignore */ }
  }

  // ── 采样面 1：策略决策（拦截 / 取消 = 丢包） ────────────────────────────
  ctx.effect(() => ctx.on('tools/pre-execute', async (exec, next) => {
    s.attempts += 1
    const callId = String(exec?.callId ?? '')
    const toolName = exec?.name || 'unknown'
    const t0 = now()
    let decision
    try {
      decision = await next()
    } catch (error) {
      s.errors += 1
      bump(s.errorCodes, 'pre-execute-throw')
      pushEvent({ t: now(), kind: 'error', name: toolName, ms: now() - t0, status: 'pre-error', detail: String(error).slice(0, 120) })
      throw error
    }
    const dt = now() - t0
    const kind = decision && decision.kind
    if (kind === 'deny' || kind === 'cancel') {
      s.blocked += 1
      s.dropped += 1
      if (kind === 'cancel') s.cancelled += 1
      else s.denied += 1
      const code = kind === 'cancel'
        ? 'cancelled'
        : (decision.info && decision.info.code) || 'denied'
      bump(s.blockCodes, code)
      const t = toolOf(toolName)
      t.blocked += 1
      bucketOf(now()).dropped += 1
      pushEvent({
        t: now(), kind: 'blocked', name: toolName, ms: dt, status: code,
        detail: kind === 'deny'
          ? (summarizeArgs(toolName, exec?.arguments) || String(decision.reason || '').slice(0, 120))
          : '调用被取消 · ' + (summarizeArgs(toolName, exec?.arguments) || ''),
      })
    } else {
      s.allowed += 1
    }
    return decision
  }), 'sandbox-monitor: pre-execute')

  // ── 采样面 2：实际分发（延迟） ─────────────────────────────────────────
  ctx.effect(() => ctx.on('tools/execute', async (exec, next) => {
    const callId = String(exec?.callId ?? '')
    const toolName = exec?.name || 'unknown'
    const argsBytes = safeArgBytes(exec?.arguments)
    const t0 = now()
    s.bytesIn += argsBytes
    s.inflight.set(callId, { name: toolName, startedAt: t0, args: exec?.arguments })
    bucketOf(t0).ops += 1
    try {
      return await next()
    } catch (error) {
      s.errors += 1
      s.dropped += 1
      bump(s.errorCodes, 'dispatch-throw')
      bucketOf(now()).errors += 1
      pushEvent({ t: now(), kind: 'error', name: toolName, ms: now() - t0, status: 'throw', detail: summarizeArgs(toolName, exec?.arguments) || String(error).slice(0, 120) })
      throw error
    } finally {
      const ms = now() - t0
      s.inflight.delete(callId)
      s.timings.set(callId, ms)
      if (s.timings.size > 400) {
        const oldest = s.timings.keys().next()
        if (!oldest.done) s.timings.delete(oldest.value)
      }
      s.durations.push({ ms, t: now() })
      if (s.durations.length > 600) s.durations.splice(0, s.durations.length - 600)
      const t = toolOf(toolName)
      t.calls += 1
      t.ms += ms
      t.bytes += argsBytes
      const b = bucketOf(now())
      b.ms += ms
      b.done += 1
      b.bytes += argsBytes
    }
  }), 'sandbox-monitor: execute')

  // ── 采样面 3：终态（报错 / 结果体积） ─────────────────────────────────
  ctx.effect(() => ctx.on('tools/result', (exec, result) => {
    const callId = String(exec?.callId ?? '')
    const toolName = exec?.name || 'unknown'
    const ms = s.timings.get(callId)
    s.timings.delete(callId)
    const latency = Number.isFinite(ms) ? ms : 0
    s.results += 1
    const outBytes = contentBytes(result && result.content)
    s.bytesOut += outBytes
    bucketOf(now()).bytes += outBytes
    if (result && result.isError) {
      const info = result.error && result.error.info
      const code = (info && info.code) || 'tool-error'
      s.errors += 1
      bump(s.errorCodes, code)
      if (/abort|cancel|timeout|deadline/i.test(String(code)) || /abort|cancel|timeout/i.test(String(result?.error?.message || ''))) {
        s.dropped += 1
      }
      const t = toolOf(toolName)
      t.errors += 1
      const b = bucketOf(now())
      b.errors += 1
      pushEvent({
        t: now(), kind: 'error', name: toolName, ms: latency, status: code,
        detail: String((result.error && result.error.message) || summarizeArgs(toolName, exec?.arguments) || '').slice(0, 140),
      })
    } else {
      pushEvent({
        t: now(), kind: 'ok', name: toolName, ms: latency, status: 'ok',
        detail: summarizeArgs(toolName, exec?.arguments),
      })
    }
  }), 'sandbox-monitor: result')

  // ── 采样面 4：Agent 异常 ──────────────────────────────────────────────
  ctx.effect(() => ctx.on('agent/error', (payload) => {
    s.agentErrors += 1
    bump(s.errorCodes, 'agent/error')
    pushEvent({
      t: now(), kind: 'agent', name: 'agent', ms: 0, status: 'agent/error',
      detail: String((payload && payload.error) || '').slice(0, 140),
    })
  }), 'sandbox-monitor: agent-error')

  // ── 采样面 5：token 消耗（assistant 消息 usage） ──────────────────────
  ctx.effect(() => ctx.on('session/event', (session, event) => {
    const ev = (event && typeof event.type === 'string')
      ? event
      : (session && typeof session.type === 'string' ? session : null)
    if (!ev || ev.type !== 'assistant/message') return
    const usage = ev.data && ev.data.usage
    if (!usage) return
    const input = Number(usage.inputTokens) || 0
    const output = Number(usage.outputTokens) || 0
    const total = Number(usage.totalTokens) || input + output
    s.tokens.input += input
    s.tokens.output += output
    s.tokens.total += total
    bucketOf(ev.time || now()).tokens += total
  }), 'sandbox-monitor: token-usage')

  // ── 快照 ─────────────────────────────────────────────────────────────
  const percentiles = (values) => {
    if (!values.length) return { p50: 0, p95: 0 }
    const sorted = values.slice().sort((a, b) => a - b)
    const at = (q) => sorted[clamp(Math.round((sorted.length - 1) * q), 0, sorted.length - 1)]
    return { p50: at(0.5), p95: at(0.95) }
  }

  const policyInfo = () => {
    try {
      const sp = ctx.get('sandboxPolicy')
      if (!sp) return { mode: 'unknown', workspaceRoot: '' }
      return { mode: sp.defaultMode || 'unknown', workspaceRoot: sp.workspaceRoot || '' }
    } catch {
      return { mode: 'unknown', workspaceRoot: '' }
    }
  }

  const buildSnapshot = () => {
    const at = now()
    sampleCpu()
    const windowMs = cfg.windowSec * 1000
    const recent = s.durations.filter((d) => at - d.t <= Math.max(windowMs, 60000))
    const msList = recent.map((d) => d.ms)
    const { p50, p95 } = percentiles(msList)
    const avg = msList.length ? Math.round(msList.reduce((a, b) => a + b, 0) / msList.length) : 0
    const max = msList.length ? Math.max(...msList) : 0
    const totalExecMs = s.durations.reduce((a, b) => a + b.ms, 0)

    // 最近 windowSec 秒的时序（每秒一桶，缺失补零）
    const secNow = Math.floor(at / 1000)
    const series = []
    let opsWindow = 0
    let bytesWindow = 0
    for (let i = cfg.windowSec - 1; i >= 0; i -= 1) {
      const sec = secNow - i
      const b = s.buckets.get(sec)
      const ops = b ? b.ops : 0
      const errors = b ? b.errors : 0
      const dropped = b ? b.dropped : 0
      const done = b ? b.done : 0
      const ms = b ? b.ms : 0
      const tokens = b ? b.tokens : 0
      const bytes = b ? b.bytes : 0
      opsWindow += ops
      bytesWindow += bytes
      series.push({
        t: sec * 1000,
        ops,
        errors,
        dropped,
        tokens,
        bytes,
        avgMs: done ? Math.round(ms / done) : 0,
      })
    }
    // 清理过期桶
    for (const key of s.buckets.keys()) {
      if (key * 1000 < at - 10 * 60 * 1000) s.buckets.delete(key)
    }

    const tools = Array.from(s.tools.values())
      .sort((a, b) => b.calls - a.calls)
      .slice(0, 10)
      .map((t) => ({
        name: t.name,
        calls: t.calls,
        errors: t.errors,
        blocked: t.blocked,
        avgMs: t.calls ? Math.round(t.ms / t.calls) : 0,
        bytes: t.bytes,
      }))
    const errorCodes = Array.from(s.errorCodes.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([code, count]) => ({ code, count }))
    const blockCodes = Array.from(s.blockCodes.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([code, count]) => ({ code, count }))

    const policy = policyInfo()
    const memory = process.memoryUsage()

    return {
      ok: true,
      version: VERSION,
      ts: at,
      uptimeMs: at - s.startedAt,
      mode: policy.mode,
      workspaceRoot: policy.workspaceRoot,
      catalog: CATALOG,
      config: { enabled: cfg.enabled, refreshMs: cfg.refreshMs, windowSec: cfg.windowSec, maxEvents: cfg.maxEvents },
      totals: {
        attempts: s.attempts,
        allowed: s.allowed,
        results: s.results,
        errors: s.errors,
        agentErrors: s.agentErrors,
        blocked: s.blocked,
        denied: s.denied,
        cancelled: s.cancelled,
        dropped: s.dropped,
        execMs: totalExecMs,
        bytesIn: s.bytesIn,
        bytesOut: s.bytesOut,
      },
      latency: { avg, p50, p95, max, samples: msList.slice(-60) },
      loss: {
        rate: s.attempts ? Math.round((s.dropped / s.attempts) * 1000) / 10 : 0,
        dropped: s.dropped,
        blocked: s.blocked,
        attempts: s.attempts,
      },
      errorRate: s.results ? Math.round((s.errors / s.results) * 1000) / 10 : 0,
      opsPerMin: opsWindow,
      tokens: s.tokens,
      bytes: {
        in: s.bytesIn,
        out: s.bytesOut,
        perSec: Math.round(bytesWindow / Math.max(1, cfg.windowSec)),
      },
      cpu: {
        percent: cpuPercent,
        cores: (typeof process.availableParallelism === 'function' ? process.availableParallelism() : undefined) || 0,
      },
      memory: {
        rss: Math.round(memory.rss / 1048576),
        heap: Math.round(memory.heapUsed / 1048576),
      },
      inflight: Array.from(s.inflight.values()).map((x) => ({ name: x.name, ms: at - x.startedAt })),
      tools,
      errorCodes,
      blockCodes,
      series,
      events: s.events.slice(0, 30),
    }
  }

  // ── HTTP 面（客户端轮询） ─────────────────────────────────────────────
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: API_PREFIX,
    handler: async (req, res) => {
      const send = (code, body) => {
        res.writeHead(code, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
        })
        res.end(JSON.stringify(body))
      }
      const readBody = () => new Promise((resolve) => {
        let text = ''
        req.on('data', (chunk) => { text += chunk })
        req.on('end', () => resolve(text))
        req.on('error', () => resolve(''))
      })
      try {
        const pathname = new URL(req.url || '/', 'http://localhost').pathname
        const path = pathname.slice(API_PREFIX.length) || '/'
        if (req.method === 'GET' && (path === '/' || path === '/snapshot')) {
          return send(200, buildSnapshot())
        }
        if (req.method === 'GET' && path === '/health') {
          return send(200, { ok: true, version: VERSION, ts: now() })
        }
        if (req.method === 'POST' && path === '/config') {
          const body = JSON.parse((await readBody()) || '{}')
          if (Array.isArray(body.enabled)) {
            const known = new Set(CATALOG.map((m) => m.id))
            cfg.enabled = body.enabled.filter((id) => known.has(id))
          }
          if (Number.isFinite(body.refreshMs)) cfg.refreshMs = clamp(Math.round(body.refreshMs), 500, 30000)
          if (Number.isFinite(body.windowSec)) cfg.windowSec = clamp(Math.round(body.windowSec), 15, 600)
          saveConfig(cfg)
          return send(200, { ok: true, config: { enabled: cfg.enabled, refreshMs: cfg.refreshMs, windowSec: cfg.windowSec } })
        }
        if (req.method === 'POST' && path === '/reset') {
          const fresh = createStats()
          for (const key of Object.keys(s)) {
            if (key === 'startedAt') continue
            const value = fresh[key]
            s[key] = value && typeof value.clear === 'function' ? value : value
          }
          s.startedAt = now()
          prevCpu = process.cpuUsage()
          prevCpuAt = now()
          cpuPercent = 0
          return send(200, { ok: true, resetAt: s.startedAt })
        }
        return send(404, { ok: false, error: 'not found: ' + path })
      } catch (error) {
        return send(500, { ok: false, error: String(error && error.stack || error) })
      }
    },
  }), 'sandbox-monitor: api route')

  ctx.logger?.info?.('[sandbox-monitor] 采样启动 · ' + CATALOG.length + ' 指标 · 窗口 ' + cfg.windowSec + 's')
}
