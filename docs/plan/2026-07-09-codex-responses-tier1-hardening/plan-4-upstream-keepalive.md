# Phase 4 — 上游保活 PoC + idle 余量核验

> REQUIRED SUB-SKILL: `superpowers:subagent-driven-development`。步骤用 `- [ ]` 追踪。
> 隐含遵守 [README.md](./README.md) Global Constraints。**Spec**: [../../spec/2026-07-09-codex-responses-tier1-hardening.md](../../spec/2026-07-09-codex-responses-tier1-hardening.md) R5.1 + R5.3。可与 Phase 2/3 并行（独立）。

**Goal:** 实测确定上游-WS 是否可获等价上游保活（对齐 h2 的 TCP keepalive + h2 PING）；核验 `streamIdleTimeout` 相对最长预期 reasoning 静默的余量。以实测/API 约束为准（`empirical-verification`），不凭推断。

**Architecture / 已知约束（待 PoC 严格确认）：**
- undici 的客户端 WebSocket 是 **WHATWG** 实现：只有 `send()` / `close()` / 事件处理器，**无 `ping()`**（协议级 ping/pong 被浏览器式 API 隐藏），也不暴露底层 socket。⟹ **应用层 WS ping 由 API 约束即不可行**；TCP keepalive 是否可经 undici WS 的连接设置是唯一开放问题。
> **⚠️ PoC 后更正（Task 4.1，2026-07-09）**：上一句「无 `ping()`」是 **runtime-split** 的——`import{WebSocket}from"undici"` 只在 **Node/real-undici** 无 `ping()`；**Bun**（`dev`/`start` 主运行时）解析到原生 WS、**有** `ping()`。但即便 Bun 可发 WS PING 也是 **prevention-only**（控制帧、不产 `ResponsesStreamEvent`、不重置帧-idle guard），承重结论（buffered 重试）不变。下列 Step 的 `has ping(): false` / 「无 `ping()`」`Expected` 是 PoC **前**假设，已被推翻其 flat 形态——权威见 `exp/ws-upstream-keepalive/REPORT.md` + `docs/todo/deferred-backlog.md`「上游 WebSocket 应用层保活」条 + spec R5.1。
- 对比 h2 路径两层（`http2-client.ts`：`socket.setKeepAlive` + `scheduleH2KeepalivePing`）。GHC 对 WS 的收割理由与 h2 同构（长静默 = 真 idle 流被 middlebox/GHC edge 收割）。
- **R5.3 关键洞察**：`state.streamIdleTimeout`（默认 **300s**）是**上游帧静默的硬上限**，对 h2 与 WS **都**适用——TCP/h2-PING keepalive 保连接活但**不产生帧**，故不重置帧-idle guard；下游保活（Phase 2）也**不**重置上游 guard（不同 racer）。即一次 > 300s 的合法 reasoning 静默会被我方 guard 杀掉，两路皆然。
- **预置结论分支（spec R5.1）**：若 WS 两层保活皆不可行，则上游-WS **无法预防收割、只能恢复** → Phase 3 的 buffered 重试成为 WS 的**承重恢复防线**（对 WS 比对 h2 更关键）。

---

## Task 4.1：R5.1 上游-WS 保活可行性 PoC + 结论

**Files:**
- Create: `exp/ws-upstream-keepalive/`（PoC 脚本 + `REPORT.md` 结论，`keep-poc-in-project`）
- Modify（结论落地）: `docs/todo/deferred-backlog.md`（若判不可行，记"WS 上游保活受 WHATWG API 约束不可行 → R4 承重"；若可行，记落地项）+ `src/lib/openai/upstream-ws-connection.ts` 或 `upstream-ws.ts` 注释（记结论,防未来误加）

- [ ] **Step 1：PoC-A —— 严格确认 undici 客户端 WS 无 `ping()` / 无 socket 访问**

`exp/ws-upstream-keepalive/probe-api.mjs`:
```js
import { WebSocket } from "undici"
const p = WebSocket.prototype
const members = []
for (let o = p; o && o !== Object.prototype; o = Object.getPrototypeOf(o)) members.push(...Object.getOwnPropertyNames(o))
const uniq = [...new Set(members)].sort()
console.log("members:", uniq.join(", "))
console.log("has ping():", typeof p.ping === "function")
console.log("exposes a socket accessor:", uniq.some((m) => /socket/i.test(m)))
```
Run: `bun exp/ws-upstream-keepalive/probe-api.mjs`
Expected：确认 `has ping(): false`、无 socket 访问器（成员集是 send/close/事件属性）。这从 API 层锁定"应用层 WS ping 不可行"。

- [ ] **Step 2：PoC-B —— undici WS 是否对 upgrade socket 开 TCP keepalive（`ss` 实测）**

对一个**本地** loopback WS 服务端建立 undici 客户端 WS 连接，用 `ss` 查该 socket 是否带 `timer:(keepalive,...)`（复刻 h2 的实测手法，skill `bun-upstream-transport`）：
```bash
# exp/ws-upstream-keepalive/probe-tcp-keepalive.sh
# 1) start a loopback WS server (Bun.serve websocket) on a port
# 2) open an undici client WebSocket to it, hold it open
# 3) ss -tnope | grep <port> → look for timer:(keepalive,...)
```
判据：
- 若 undici WS **默认或可配置**开 TCP keepalive → 记录"TCP 层可保活"（middlebox 层面有帮助，虽不重置帧-idle guard）。
- 若不开且不可配置（WHATWG 构造器不暴露 dispatcher/socket）→ 记录"TCP keepalive 亦不可达"。
- **不涉及 GHC 真实上游**（`no-auto-server`）；GHC 是否转发/容忍 WS ping 的问题因 undici 无 `ping()` **已然 moot**（发都发不出）——在 REPORT 说明。

- [ ] **Step 3：写 REPORT.md 结论**

`exp/ws-upstream-keepalive/REPORT.md`：
- PoC-A 结果（无 ping/无 socket → 应用层 ping 不可行）。
- PoC-B 结果（TCP keepalive 可达性）。
- 结论：WS 上游保活的可行层级（无 / 仅 TCP）。
- **承重判定**：若无应用层保活 → Phase 3 buffered 重试是 WS 的承重恢复防线（引 spec R5.1 预置分支）。
- 对比表：h2（TCP + h2 PING）vs WS（结论）。

- [ ] **Step 4：结论落地（doc + 防误加注释）**

- 若判不可行：`docs/todo/deferred-backlog.md` 加条目"上游-WS 应用层保活受 WHATWG API 约束不可行（无 ping()）；TCP keepalive <可达/不可达>；WS 长静默韧性由 Phase 3 buffered 重试承重"（含根因/当前行为/若未来 undici 或换库可做需改什么）。
- 在 `upstream-ws-connection.ts`/`upstream-ws.ts` 顶部加一句注释指向该结论，防未来有人"补一个 WS ping"白费功夫。
- 若判部分可行（TCP keepalive 可配）→ 落地一个最小的 TCP keepalive 启用 + `ss` 固化测试（条件性；仅当 PoC 证可行且有真实收益）。

- [ ] **Step 5：提交**

```bash
git add -- exp/ws-upstream-keepalive/ docs/todo/deferred-backlog.md src/lib/openai/upstream-ws-connection.ts
git commit -m "docs(upstream-ws): PoC + conclusion on WS upstream-keepalive feasibility (R5.1)" -- exp/ws-upstream-keepalive/ docs/todo/deferred-backlog.md src/lib/openai/upstream-ws-connection.ts
```

---

## Task 4.2：R5.3 idle 余量核验 + 关系锁定测试

**Files:**
- Test: `tests/responses/upstream-idle-margin.unit.test.ts`（Create）或就近既有 WS/transport 测试
- 可能 Modify: `docs/DESIGN.md`（「活的架构现状」记 idle guard 关系——留 Phase 5 doc-sync 亦可，但结论此处产出）

**Interfaces:**
- Consumes: `state.streamIdleTimeout`、`guardSseIterable`（`src/lib/stream`）、`raceIteratorNext`（WS）。

- [x] **Step 1：核定 idle guard 的独立性（R5.3 关键不变量）**

用测试/代码核实并锁定三条关系：
1. `state.streamIdleTimeout`（默认 300s）是**上游帧静默上限**，SSE（`guardSseIterable`）与 WS（`raceIteratorNext`）**同一 knob**。
2. **下游保活（Phase 2）不重置上游 idle guard**——二者不同 racer（下游在 sink，上游在 transport guard）。一次 > streamIdleTimeout 的上游帧静默仍被杀，与下游是否发保活无关。
3. h2 的 TCP keepalive / h2 PING 保连接活但**不产帧**，故也不重置帧-idle guard——300s 上限对 h2 与 WS 一致。

- [x] **Step 2：写关系锁定测试**

```ts
// Assert: an upstream that goes frame-silent > streamIdleTimeout is killed by the upstream guard,
// EVEN WHILE the downstream keepalive is firing (the two are independent racers).
test("downstream keepalive does NOT extend the upstream frame-idle guard", async () => {
  // set streamIdleTimeout small; drive an upstream that emits nothing past it while the sink heartbeat ticks;
  // assert the upstream guard fires (idle-timeout error) — downstream pings don't rescue it.
})
```
（用既有 `guardSseIterable` 测试 harness 形态；时序测试连跑 10× 无 flaky。）

- [x] **Step 3：产出 idle 余量结论**

在 REPORT（复用 4.1 的 `exp/ws-upstream-keepalive/REPORT.md` 或 DESIGN 注解）记：
- 300s 是上游静默上限，可配（`streamIdleTimeout`）。
- §1.1 事件是 124s < 300s（故非本 guard 触发，是 close 码 bug——已 Phase 0 修）。
- 长 reasoning 若真静默 > 300s 需调大 `streamIdleTimeout`；下游保活不代偿。
- 判定：300s 默认对 gpt-5.5 是否足够（reasoning 通常有中间帧）——给出运维建议，非强制改默认。

- [x] **Step 4：运行 + typecheck + 提交**

Run: `bun test tests/responses/ && bun run typecheck 2>&1 | tail -2`
```bash
git add -- tests/responses/upstream-idle-margin.unit.test.ts <可能的 REPORT/DESIGN>
git commit -m "test(upstream): lock idle-guard independence from downstream keepalive (R5.3)" -- <files>
```

---

## Phase 4 DoD

- [ ] R5.1 PoC 有实测结论（undici WS 无 ping() 确认；TCP keepalive 可达性；承重判定）（4.1）。
- [ ] 结论落 `exp/` + `deferred-backlog` + 防误加注释（4.1）。
- [x] R5.3 idle guard 独立性锁定测试 + 余量结论（4.2）。
- [ ] `bun run typecheck` + `bun test tests/responses/` 绿；时序测试 10× 无 flaky。
- [ ] 各 task 细粒度 pathspec 提交。

## 交给 Phase 5

上游保活可行性 + idle 余量有结论后，Phase 5 收口：DESIGN.md「活的架构现状」更新 Responses 全貌、deferred-backlog 汇总、L1 守卫补全、最终 whole-branch review、合回 master。
