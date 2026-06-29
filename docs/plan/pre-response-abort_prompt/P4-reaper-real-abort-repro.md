# P4 — reaper-真-abort 的 0-unhandled repro（强化 ④）

> 开场先读 [README.md](./README.md) 通用红线 + 必读。**独立、随时可做**（④ 已落地 `d6eacf0`/`4bd6850`/`67b6eca`）。独立小测。

## 背景 + 为什么

④ 给 stale reaper 装了牙齿：`runReaperOnce`（`manager.ts:185` 附近）现调 `ctx.reapInFlight()` abort `lifecycleSignal`，transport 把它折进上游 fetch/guard → **真正取消在飞上游**。

round-C MEDIUM 指出：现有 `exp/stale-abort-unhandled/repro-fullstack.ts` 只测了**改前**行为（reaper 只 `ctx.fail` 不 abort 在飞 → fetch promise 仍有 awaiter → 0 unhandled）。它**没真正执行 ④ 后的 abort 行为**（reaper 调 `reapInFlight()` → 触发 fetch signal）。结论靠对 `runExchange` 串行 await 结构的静态推理外推（reaper-abort 的 fetch 永远有 awaiter，故不孤儿、不崩）——⑤ 的 `withRejectionObserver`（`http2-client.ts:239`）是 belt-and-suspenders 兜底，即便推理有误也不崩。

**但应补一个真正执行 ④ abort 路径的 repro**，把"静态推理 + ⑤ 兜底"升级为"实测确认 0 unhandled"（empirical-verification：reaper-真-abort 的 unhandledRejection 行为不靠推断）。

## 目标

加一个 repro / it-test：reaper 真调 `ctx.reapInFlight()`（或 `_runReaperOnce` 触发它）→ abort 在飞上游 fetch（真实 `node:http2` server 或注入的 transport mock 长 stall）→ 断言 **0 `process.on("unhandledRejection")`**（同 `exp/stale-abort-unhandled/` 的 harness 范式）。覆盖：
- pre-response 阶段 reaper-abort（fetch 在 `await runRequest` 内被 await）。
- （若 P2 已落地）COMMIT 后 `await p` 期间 reaper-abort（③ race 态下的在飞 fetch）——round-C M3 特别点名这个新窗口。
- 幂等：reaper `reapInFlight()` + `ctx.fail()` 双触发被 `settled` guard 兜住，无双 settle（context-manager 测已部分覆盖，可补 race 态）。

## 验收

- [ ] repro 真执行 ④ 的 abort 路径（reaper→reapInFlight→fetch signal），实测 0 unhandledRejection（Bun + Node 双端，若可行）。
- [ ] 放 `exp/reaper-real-abort/`（feedback-experiments-in-repo-exp-dir）+ 一个进套件的 it-test（`tests/context/` 或 `tests/transport/`）。
- [ ] 否定性结论不自证：确认 harness 真装了 `unhandledRejection` 监听、真触发了 reaper-abort（methodology-probe-harness-must-match-prod）。
- [ ] RFC §2 缺陷④ / §5 C4 行的"补 repro"待办标 ✅。
