# Changelog

## 0.1.0 — 2026-10-19

First public release.

- Live sandbox preview in the native DSH right sidebar: time, tool, command/path summary,
  duration and status for every sandbox call.
- 14 selectable metrics: latency (avg / P95 / peak / 60s sparkline), loss rate, errors,
  concurrency, call rate, token usage, throughput, cumulative exec time, CPU, memory,
  blocked calls, per-tool distribution, error codes and a live event stream.
- Options page with add/remove metric switches, refresh interval and counter reset.
- Server-side sampler over `tools/pre-execute`, `tools/execute`, `tools/result`,
  `agent/error` and `session/event`; no LLM tool is registered (zero schema cost).
- Config persisted at `~/.dsh/sandbox-monitor/config.json`.
- HTTP API: `GET /sandbox-monitor/api/snapshot|health`, `POST /sandbox-monitor/api/config|reset`.
- Theme-token styling that follows light/dark and glass skins.
