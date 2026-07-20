---
name: undici-websocket-runtime-split-bun-vs-node
description: "Bun 与 Node 下 `import {WebSocket} from \"undici\"` 解析到不同实现（ping/close-code 行为分叉），影响上游 WS 关闭码与保活推理"
metadata: 
  node_type: memory
  type: reference
  originSessionId: c587340c-6fc2-493e-94d8-fee8b472d694
---

`import { WebSocket } from "undici"`（裸 specifier）在本项目**按运行时解析到不同实现**——实测锁定（Task 4.1 PoC，`exp/ws-upstream-keepalive/`）：

- **Bun**（`dev`/`start` 主运行时）：Bun 拦截裸 `"undici"`，返回 **Bun 原生 WebSocket**（`globalThis.WebSocket`）。**有** `.ping()`/`.pong()`/`.terminate()`；`close(1001)` **容忍不抛**。
- **Node**（发布 CLI `dist/main.mjs`）：真 undici 7 的 WHATWG WebSocket。**无** `.ping()`、无 socket 访问器；`close()` 只允许 `1000` / `3000–4999`，对 `1001` 同步抛 `DOMException('invalid code','InvalidAccessError')`（`undici/lib/web/websocket/util.js` `validateCloseCodeAndReason`）。

两个后果（都已在 `feat: codex-responses-tier1-hardening` 落地/更正）：
1. **关闭码 bug 是 runtime-conditional**：§1.1 的 `attempt.error="invalid code"`（before-first-event `connection.close(1001)` 击败 WS→HTTP 降级）只在 **Node 路径**显形；Bun 容忍 1001。fix 用 `close(1000)`——两运行时皆安全（新原语 `closeUpstreamWs`）。
2. **上游 WS 应用层保活**：Bun 有 `.ping()` 但 **prevention-only**（WS PING 是控制帧、不产 `ResponsesStreamEvent`、不重置 `streamIdleTimeout` 帧-idle guard，与 h2 PING 同构）+ 运行时不对称 + 真实 GHC 收益未证 → **判不落地**，buffered 重试是 WS 承重恢复。

**注意对比**：`upstream-fetch.ts` 用 `import ... from "undici/index.js"`（**subpath**）故意绕过 Bun shim 取真 undici 的 fetch（要真 dispatcher/keepalive）；而 `upstream-ws-connection.ts:12` 用裸 `"undici"` 故在 Bun 上是原生 WS。写 WS 相关 close/ping 逻辑前先确认当前 specifier 形态 + 目标运行时。

**权威归属**（本条只是引用层，别在此重复详情）：spec `docs/spec/2026-07-09-codex-responses-tier1-hardening.md` §1.1/§5.1、`docs/DESIGN.md`「活的架构现状」Codex/Responses 行、`exp/ws-upstream-keepalive/REPORT.md`、`docs/todo/deferred-backlog.md`（WS 上游保活条）。属 [[bun-node-runtime-gotchas]] 家族（skill）。
