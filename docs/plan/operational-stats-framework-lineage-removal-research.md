# Research: OpenTelemetry vs self-built telemetry for copilot-api-js

> **类型**：研究报告 —— 非独立 plan，实施状态见父 plan [operational-stats-framework-lineage-removal.md](operational-stats-framework-lineage-removal.md)。

Research-only task. Deliverable = findings report below (no code changes proposed).

## Verdict
Extend the existing `request-telemetry.ts`. Do NOT adopt OTel as the source of truth.
Optionally add an OTLP/Prometheus `/metrics` BRIDGE later, opt-in, as a thin read-only projection.

## Evidence (sources)
- Bun #28968 native OTel (draft, Apr 2026); #29586 + #32472 diagnostics_channel gaps break auto-instrumentation; #30669 bun build breaks OTel monkey-patch; #31503 module resolve hook panic.
- Bun nodejs-apis: async_hooks 🟡 (ALS ok, v8 promise hooks not called), perf_hooks 🟡, diagnostics_channel 🟢-claimed but issues above show gaps for http/child_process publishers.
- exporter-prometheus: in-process /metrics :9464, in-memory only, pull-based, needs external Prometheus to persist + Grafana to view.
- OTel metrics concept: no built-in TSDB, no built-in dashboard, always export to external backend.
- sdk-metrics + api + exporter-prometheus: pure JS/TS, browser-compatible → no binding.gyp / native deps.

## Key distinction
Manual Metrics API (Counter/Histogram via api+sdk-metrics) works on Bun (pure JS, no diagnostics_channel).
Auto-instrumentation (sdk-node + instrumentation-*) is what breaks on Bun.
