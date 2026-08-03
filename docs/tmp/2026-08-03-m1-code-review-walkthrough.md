# M1 代码评审——执行方第一人称走查

对象：commit `6333d800`（分支 `feat/inter-block-anchor-allocator`）
依据：`docs/plan/2026-07-27-inter-block-anchor-allocator/plan-3-remap-sites.md` M1 调查结论 ①–⑧ + README C1–C11

（本文件逐条追加，最终结论见文末。）

## 总体 verdict

**修复 major 后可进入下一阶段**。blocker 数 = **0**；major = **3**；minor = **9**；nit = **2**。

实现的**生产形状基本是对的**（状态转移表逐格核对通过、bridge 三种情形等价、heartbeat 时钟补齐、wire-torn close 例外成立），问题集中在两处：**六个终局站点丢弃了 owner 的失败决定**（终态分类会错），以及**M1 自己列的「13 站点关闭回归」门只落实了 6/13**（实测：删掉另外 7 处关闭，全后端 6828 测试仍全绿）。

## 双视角覆盖证据

**机械核对（扫描 / 对账 / 查证）**

- 逐字读完 `src/lib/pipeline/delivery/session.ts` 全文、`delivery/owner-failure.ts` 全文、`live-reconcile.ts` 改动段、`keepalive-anchor.ts` 两个 injector、`handler-v4.ts:640-760 / 1080-1230 / 1380-1900`、`driver.ts:880-960 / 1140-1340 / 1415-1455 / 1590-1625`。
- 逐格对照 plan「迁移期双写的精确状态转移表」9 行 × 4 列（结论见 §C）。
- 对账 plan ① 的 13 行站点表 → 当前代码调用点：`rg closeAnchorViaOwner` 得 handler 8 处（702/1474/1592/1619/1673/1782/1820/1864）+ driver 4 处（1235/1313/1435/1607）+ live-reconcile 1 处（157），**数量与归属与 ① 完全一致**。
- 查证 bridge 等价性的 `enveloped_ping` 分支：`makeSyntheticEnvelopeInjector`（`keepalive-anchor.ts:351-386`）全程不碰 allocator → `anchorsOpened()===0`，与旧门 `anchorBlockOpen===false` 同给 +0 ✓。
- 全量测试：`FORCE_COLOR=0 bun scripts/parallel-test.ts unit it http` = **6828 pass / 0 fail / 33.0s**；`bun run typecheck` 退出码 0。
- `bunx eslint` 单点扫改动文件 = **10 errors**；同 4 个源文件在 `6333d800^` 上 **0 errors** → 新引入（见发现 7）。
- 类型级穷尽性实测：往 `OwnerFailureReason` 加第四个 `"quota-exhausted"` → `owner-failure.ts:39` TS1360 + `:45` TS7053，**加 reason 必编译红成立** ✓。

**第一人称执行 / 下游消费方走查（在 scratch worktree `.worktrees/m1-review-probe` 上实跑，已清理）**

- **13 站点逐个删除 mutation**（每次只删一处关闭调用，跑全后端档）：见发现 3 的红绿表。
- **PROBE-A**（连续两轮 open/close，plan 门里点名但仓库没测）：`anchor@0 → close → real@1 → anchor@2 → close@2`，实测输出 `second anchor {"ok":true,"value":2} mirror.anchorClosed=false openAnchorIndex=2`、`second close {"ok":true,"value":"closed"}`、wire 序列 `anchor@0,anchor@0,real@1,anchor@2,anchor@2` → **实现正确，但无回归锁**。
- **PROBE-B**（live 腿客户端断开撞上 anchor 关闭）：装饰器抛 `[delivery] live anchor close rejected: client-gone`，`classifyStreamError(...)` 实测 = **`other`** → driver 走 `stream-error` 而非 `settled-abort`（发现 2）。
- **反向 mutation**（plan 点名要求）：把 `closeUnavailable` 改回在 `wireTorn` 时拒绝 → `wire-torn blocks frontier progress but still closes the already allocated anchor exactly once` 转红 ✓。
- **守卫正样本对照**（plan 要求但测试里没有，我手工补跑）：driver 里加一行 `anchorState.anchorClosed = ...` → 架构守卫转红 ✓；handler 里写 `sink.writeAnchor?.(anchorHooks.stopFrame(0))` → 同一守卫转红 ✓。
- **真实 HTTP 入口的闭合性**（B 项）：`live-post-commit-anchor-closeoff.http.test.ts` / `live-pump-terminal-anchor-closeoff.http.test.ts` 走 `createFullTestApp` + `app.request`，断言「`content_block_stop@0` 出现在 `event: error` 之前」，当前全绿；且我用站点 702 / 1619 / driver 1607 的删除 mutation 证明这三条 oracle **确实咬得住**（分别列出转红用例名，见发现 3）。

## A. 13 个关闭者逐个走查

| # | 站点（当前位置） | ① owner / legacy | ② port 取法 | ③ 失败收尾 | 删除 mutation 是否转红 |
|---|---|---|---|---|---|
| 1 | `handler-v4.ts:702`（`writeTerminalThenSettle` 内） | owner | `getDownstreamDeliverySession(sink)`（sink = `makeDeliverySseSink` 原件） | 完整：client-gone→`abort`+snapshot 后 return；session-terminating 未 settle→`fail`；wire-torn→继续写终局帧；`finally` 再 settle 靠 ctx `settled` 去重（`request.ts:1723`） | **红** ✓（`HTTPError branch…` / `reaper-cancel…`） |
| 2 | `handler-v4.ts:1474` | owner | 同上 | 完整：唯一使用 `settleFromOwnerFailure` 的站点 | **红** ✓ |
| 3 | `handler-v4.ts:1592`（不可修复 tool_use） | owner | 同上 | **丢弃 decision**（发现 1） | **绿** ✗ |
| 4 | `handler-v4.ts:1619`（direct 截断） | owner | 同上 | **丢弃 decision**（发现 1） | **红** ✓（`truncation branch…`） |
| 5 | `handler-v4.ts:1673`（direct 兜底 catch） | owner | 同上 | throw 已由 `closeAnchorViaOwner` 内层 `catch (error) { if (!(error instanceof DeliveryOwnerError)) throw error … }`（`:1129-1132`）吞掉并转成 wire-torn decision → **⚠️ 项已满足**；但 decision 本身被丢弃 | **绿** ✗ |
| 6 | `handler-v4.ts:1782`（translate stream-error） | owner | 同上 | **丢弃 decision** | **绿** ✗ |
| 7 | `handler-v4.ts:1820`（translate 截断） | owner | 同上 | **丢弃 decision** | **绿** ✗ |
| 8 | `handler-v4.ts:1864`（translate 兜底 catch） | owner | 同上 | 同站点 5：内层保护已具备；decision 丢弃 | **绿** ✗ |
| 9 | `driver.ts:1435`（post-retreat 截断终局） | owner | `opts.wireAllocationPort ?? getDownstreamDeliverySession(sink)`（`:1096`） | `settled-abort`/`delivery-finished` 正确导出；`stream-error` 覆盖掉真实 `thrown`（发现 5） | **绿** ✗ |
| 10 | `driver.ts:1607`（终端穷尽） | owner | 同上 | 同站点 9 | **红** ✓ |
| 11 | `driver.ts:1235`（flush 内 close-before-real） | owner | 同上 | `settled-abort`→抛 `StreamClientAbortError`、`stream-error`→抛 `.error`，均落进 `flushBufferedFrames` 的 `catch` 映射为 `client-abort`/`write-error` ✓；`delivery-finished` 静默继续（可接受） | **红** ✓ |
| 12 | `live-reconcile.ts:157`（装饰器） | owner | `getDownstreamDeliverySession(inner)`，`inner` = raw delivery sink（`handler-v4.ts` 把 `makeAnchoredSseSink` 的返回件直接传进 `liveReconcilingSink`）→ **没踩 wrapper 查 session 的坑** ✓；stop index 取 owner 的 `openAnchorIndex`、未硬编码 0 ✓ | 一律转成裸 `Error` 抛出（发现 2） | **红** ✓（7 条） |
| 13 | `driver.ts:1313`（retreat live 写穿 close-before-real） | owner | 同站点 9 | 直接 `return closeOutcome`（settled-abort / stream-error） | **绿** ✗ |

**②（port 取法）13 个站点全部正确**：handler 8 处与 driver 4 处都从原 delivery sink / 显式传入的 `wireAllocationPort` 取，live 装饰器从 raw `inner` 取。项目踩过一次的「对 wrapper sink 查 session 得 `undefined`」在本 commit 未复现。

**站点 5 / 8 的 ⚠️ 已处理**：两个兜底 `catch` 本身没有内层 try，但 `closeAnchorViaOwner`（`handler-v4.ts:1116-1133`）自带 `try/catch`，`DeliveryOwnerError` 不会逸出 pump；非 `DeliveryOwnerError` 会重抛，但此时已在 catch 块内、只会被外层 `finally { recordForwarded() }` 走一遍后向上传播（这是既有形状）。

## B. 「短路按 reason 分」的实现核对

- `client-gone` / `session-terminating` **零追加字节**：站点 1、2 正确短路；站点 3–8 不短路，但因为 `finalizeAfterClientGone()` 已把 session 置 `closed`，后续 `sink.writeSynthetic` 在 `session.ts:127` 的 `if (state !== "open" …) return` 处被吃掉 → **实际字节仍为 0**。真正的损害是终态分类，不是字节（见发现 1）。
- `wire-torn` **不短路**：`closeUnavailable`（`session.ts:304-308`）在 `wireTorn` 时返回 `undefined`（不拒绝），close 正常写出 stop → 站点随后写自己的终局 error。**owner 层 oracle 实测成立**（`wire-torn blocks frontier progress but still closes the already allocated anchor exactly once`），且反向 mutation 会红。
- **真实 HTTP 入口**：`wire-torn × committed:false` 按 plan「验收分层」本就造不出（只能在 owner 层驱动）；但「闭合的 `block@0` + error」这个**客户端可观测形状**已由两个 `.http` 用例经 `createFullTestApp` + `app.request("/v1/messages")` 覆盖并被 mutation 证明有判别力（见双视角证据）。
  ⚠️ plan 明写「这一层证不到站点接线，**必须在测试名与计划记录里明确写出该限制**」——当前 owner 层测试名没有写这个限制。

## C. 状态转移表逐格对照

逐行核对 `session.ts` 与 plan 表，**9 行全部一致**，两处最易写错的都对：

- **`anchorBlockOpen` close 后保持 `true`** ✓ —— owner 侧唯一能碰 legacy 的通道是 `legacyAnchorMirror?: { anchorClosed: boolean }`（`session.ts:50`），**类型上就够不到 `anchorBlockOpen`**；injector 的 `restoreMirror()` 只在 **pre-commit** 拒绝 / 非 committed throw 时回滚（`keepalive-anchor.ts:314-320`），post-commit 不回滚 ✓。
- **`anchorClosed` 每次开新 anchor 复位 `false`** ✓ —— 写在 `allocateAndWriteAnchor` 的 commit 回调里（`session.ts:373`），与 `openAnchorIndex` 同一回调。既有测试用 `const legacyMirror = { anchorClosed: true }` 起手、断言首次分配后变 `false`，**间接锁住了重新武装**；但「第二个 anchor」的整条路径无测试（发现 4，我已用 PROBE-A 实证实现正确）。
- 其余：post-commit 写失败保留 `openAnchorIndex = reservation.value` 且 `anchorClosed` 仍为 `false` ✓（`writeAllocationFrames` 的 catch 不动 mirror）；`closeOpenAnchor` client-gone 时 `committed:true` 且**不清** `openAnchorIndex` ✓（`:439` 在 `:428` 之前抛出/返回）；`withAllocatedRealBlock` / `beginLeg` / `writeBlockFrame` 四态全不变 ✓。

## D. heartbeat 语义

- **driver 侧无条件 `sink.close?.()` 已显式保留**：`driver.ts:1178` `if (mode === "terminal") sink.close?.()` 位于 `if (!anchor) return undefined` 与 port 检查**之前**，与 `6333d800^` 的 legacy `closeAnchorIfOpen`（先 `sink.close?.()` 再判 anchor）逐行等价 ✓ —— 没有退化成条件性。
- **handler 侧条件性语义也保住**：owner 的 `closeOpenAnchor` 把 `if (mode === "terminal") closeHeartbeat()` 放在 `openAnchorIndex === undefined → "none"` 早返回**之后**（`session.ts:420-421`），等价于 legacy `closeAnchorIfOpen` 的「只有真的关了才 `sink.close?.()`」✓。
- **两个 owner 写入口的时钟已补齐**：`closeOpenAnchor` 成功路径 `:430-432`、`writeBlockFrame` `:461-463`，与 `writeAllocationFrames` `:334-336` 同形（含 `lastContentDeltaAtMonotonic` 分支）✓。既有 oracle 只断言 `lastWriteAtMonotonic`，没断 `lastContentDeltaAtMonotonic`（弱，未单列为发现）。
- **live 腿新增语义**：`error` / `message_delta` / `message_stop` 触发帧现在走 `"terminal"` 模式，会 `closeHeartbeat()`；legacy 的 live close-off 从不停心跳。仅在「确有 open anchor」时发生且紧接终止符，判为无害。

## E. M1 commit 表「可满足的门」逐项判定

| 门 | 判定 | 证据 |
|---|---|---|
| owner 单元测试：**连续两轮 open/close** | **未落实** | 全仓无「关掉第一个 anchor 后再开第二个」的用例；PROBE-A 证明实现是对的，但无锁 |
| owner 单元测试：close 幂等 | 已落实 | `anchor-allocation-owner.it.test.ts:147-171`（第二次得 `"none"`、`seen === [0]`、wire 只有一个 stop） |
| owner 单元测试：终局 exactly-once | 已落实 | 同上 + `:172-204`（wire-torn 后两次 terminal close → `closed` / `none`） |
| **13 站点关闭回归** | **未落实（6/13）** | 逐站点删除 mutation：红=1,2,4,10,11,12；绿=3,5,6,7,8,9,13 |
| owner→owner 组合 oracle（第二个得 `"none"`、wire 仅一个 `stop@0`） | 已落实 | `anchor-allocation-owner.it.test.ts:147` |
| **任一关闭者改回 legacy 即转红的 mutation control** | 落实了，但**证不到它声称的东西** | 我实测：写回 `sink.writeAnchor?.(…stopFrame(0))` → 架构守卫红 ✓。但守卫只咬「**写了** legacy stop」，咬不住「**删掉**关闭」——后者 7 处全绿。plan 的红线是「不得先接部分 owner close、让其余继续 legacy 写 stop」，这条守住了；但门里另一半（站点回归）没守住 |
| wire-torn 后 close 仍写 stop 的 oracle ／反向 mutation | 已落实 | oracle `anchor-allocation-owner.it.test.ts:172`；反向 mutation 实跑转红 ✓。⚠️ 测试名未按 plan 要求标注「本层证不到站点接线」 |
| 两个 owner 写入口 heartbeat 时钟 oracle | 已落实 | `anchor-allocation-owner.it.test.ts:206-219`（`closeOpenAnchor` + `writeBlockFrame` 各推进 `lastWriteAtMonotonic`）。只断 write 时钟、未断 content-delta 时钟 |
| live per-frame serializer 接线 | 已落实 | `live-reconcile-collision.it.test.ts` 用 `makeDeliverySseSink` 真实 sink 栈断言 `content_block_stop@0#anchor`；站点 12 mutation → 7 条转红 ✓ |
| **O-6 wire 等价** | **落实了但证不到全部声称** | golden 套件（`buffered-anchor-golden.it.test.ts`、`c0-live-anchored-direct-stream-golden.http.test.ts`）全绿 → 无-anchor 主腿字节不变成立。plan 说「有-anchor 零变化由**站点回归**证明」，而站点回归 7/13 缺失 → 这半边没有支撑 |
| 四格可达 disposition oracle | 已落实（分类层） | `owner-failure.unit.test.ts:29-49` 四格齐全。⚠️ plan 还要求 `client-gone × true` 与其后续 `client-gone × false` 走**真实 HTTP 入口**断言「零追加字节 / settle 恰好一次 / 终态 aborted / snapshot + `PipelineInfo` 从 History 读回」——**这条未落实** |
| 两格非法组合 producer + translator 腿 | 已落实 | `owner-failure.unit.test.ts:51-62` 两条 `@ts-expect-error` + 合法正样本；加第四个 reason 编译红我已实测 ✓ |
| `PipelineInfo` History round-trip | **落实了但证不到接线** | `tests/context/request-buffered-merge-info.unit.test.ts:33-42` 只从 `ctx.recordWirePartialDelivery` 手动起手；从 **owner 真失败** 出发的两条 post-commit 腿（returned client-gone / thrown wire-error）均无 oracle（发现 11） |
| 类型级正负测 | 已落实 | 同上 |
| owner-failure 边界守卫 | 已落实 | `package-boundaries.unit.test.ts:590-609`：断 `owner-failure.ts` 只 import `../types`、不 import driver/routes/context；circular-deps ratchet 在全量档中绿 |

## 事实性发现

**[major] `src/routes/messages/handler-v4.ts:1592, 1619, 1673, 1782, 1820, 1864` —— 六个终局站点丢弃 `closeAnchorViaOwner` 返回的 `OwnerTerminalDecision`**
- 证据：全仓 `settleFromOwnerFailure` 只有 `handler-v4.ts:1476` 一个调用点；上述六行是裸 `await closeAnchorViaOwner(sink, anchorHooks, env.ctx, "terminal")`，返回值未接。plan ⑤「收尾顺序按站点分两种写法」明写站点 2–8 都要走 `if (d) { recordForwarded(); settleFromOwnerFailure(d, …); return }`，性质 6 明写 `client-gone → aborted`、`session-terminating` 已 settle → `delivery-finished`。
- **下游/客户端会看到什么错误的东西**：客户端在 anchor 关闭那一刻断线时，owner 返回 `{ok:false, reason:"client-gone", committed:true}`（`session.ts:436-439`）被无视，站点继续跑自己的失败终局 → History/telemetry 把这次请求记成 **failed**，failureReason 是 `"upstream stream truncated: closed without message_stop"` / `"unrepairable malformed tool_use input"` / `api_error`，而不是 **aborted（客户端主动断开）**。运维查「上游截断率」时会被这批假失败污染；`session-terminating` 且 ctx 已 settle 的情形也不会走 `delivery-finished`，会多打一次 `fail`（虽被 `settled` 去重，但走了本该短路的路径）。
- 修复建议：这六处照站点 2 的形状接上 `settleFromOwnerFailure`（各自传本站点的 `abort` / `fail` 闭包与 partial 数据），`wire-torn` 仍返回 `false` 继续原路径。

**[major] `src/lib/anthropic/live-reconcile.ts:157-158` —— owner close 的任何失败一律转成裸 `Error`，`client-gone` 被降级成通用流错误**
- 证据：`if (!closed.ok) throw new Error(\`[delivery] live anchor close rejected: ${closed.reason}\`)`。scratch 实测（PROBE-B）：抛出 `[delivery] live anchor close rejected: client-gone`，`classifyStreamError(该错误)` = **`other`**。driver 的 `runResponseSink` catch（`driver.ts:900-903`）只在 `client-abort` 时返回 `{kind:"settled-abort"}`，因此返回 `stream-error`。
- **下游/客户端会看到什么错误的东西**：live 腿客户端中途断开且恰好撞上 anchor close-off → 请求被记成 **failed**、错误文本是内部实现细节 `[delivery] live anchor close rejected: client-gone`（会进 History 的 failureReason，也会进 `logUpstreamStreamOutcomeError` 的日志），而正确终态是 aborted。同理 `session-terminating` 已 settle 的场合本该是 `delivery-finished`（静默收尾），现在会走 stream-error 分支再写一次终局帧。
- 修复建议：装饰器改为经 `classifyOwnerFailure` 分类——`client-gone` 抛 `StreamClientAbortError`（或直接 return 让 driver 走 settled-abort），`session-terminating` 已 settle 时静默 return，只有 `wire-torn` / 未 settle 的 session-terminating 才抛 loud error。

**[major] M1 门「13 站点关闭回归」只落实 6/13；7 处删掉整段关闭后全后端 6828 测试仍全绿**
- 证据（scratch worktree，逐处单独中和该行的关闭调用后跑 `FORCE_COLOR=0 bun scripts/parallel-test.ts unit it http`）：

  | 站点 | 位置 | 结果 |
  |---|---|---|
  | 1 | `handler-v4.ts:702` | 6825/3 fail ✓ |
  | 2 | `handler-v4.ts:1474` | 1 fail ✓ |
  | 3 | `handler-v4.ts:1592` | **6828 pass / 0 fail** ✗ |
  | 4 | `handler-v4.ts:1619` | 1 fail ✓ |
  | 5 | `handler-v4.ts:1673` | **0 fail** ✗ |
  | 6 | `handler-v4.ts:1782` | **0 fail** ✗ |
  | 7 | `handler-v4.ts:1820` | **0 fail** ✗ |
  | 8 | `handler-v4.ts:1864` | **0 fail** ✗ |
  | 9 | `driver.ts:1435` | **0 fail** ✗ |
  | 10 | `driver.ts:1607` | 1 fail ✓ |
  | 11 | `driver.ts:1235` | 13 fail ✓ |
  | 12 | `live-reconcile.ts:157` | 7 fail ✓ |
  | 13 | `driver.ts:1313` | **0 fail** ✗ |

  转红用例（供归档）：站点 1 → `live POST-COMMIT terminal failure … HTTPError branch` / `… reaper-cancel / timeout branch`；站点 4 → `live PUMP terminal failure … truncation branch`；站点 10 → `runResponseBufferedSink — terminal-failure anchor close-off (Task 3.4) …`。
- 缺口里**整条 translate 腿（站点 6/7/8）零覆盖**，而这是生产路径（`/v1/messages` 上 `@cc` / `@responses` 路由）；本 commit 还把 `tests/anthropic/translate-leg-flush-reconcile.unit.test.ts:118` 唯一那条 `expect(stops.map(s => s.index)).toContain(0)` 删掉了（理由「array sink 没有 owner」成立，但没有在别处补等价断言）。
- **下游/客户端会看到什么错误的东西**：这 7 个终局若在 M2–M4 的三腿迁移中被改坏（M4 恰好要重写 live/retreat 这一带），客户端会收到**未闭合的 `content_block@0` 紧跟 `event: error`** —— 正是 §10.5 立法要防的协议不完整流，Anthropic SDK 会在 `finalMessage()` 上抛「stream ended」——而 CI 全绿、没有任何信号。
- 修复建议：至少给 translate 腿补一份对称于 `live-pump-terminal-anchor-closeoff.http.test.ts` 的 `.http` 覆盖（stream-error / 截断 / 兜底 catch 三支），给站点 3（unrepairable tool_use）、站点 9/13（retreat 两支）补 producer 级断言；把「每个站点删除后哪条测试转红」记进 plan（M1 已有 mutation 矩阵的先例）。

**[minor] `src/lib/pipeline/driver.ts:1437, 1618` —— owner 失败的 error 覆盖掉真正的终局病因，且未挂 `cause`**
- 证据：`return closeOutcome ?? streamErrorOutcome(thrown ?? new Error("upstream stream truncated: …"), env, …)` —— 当 `closeOutcome.kind === "stream-error"` 时整个 `thrown` 被丢弃。plan ⑤ 明写「owner failure error 是终态错误，站点原始诊断保留为 `cause`，不得丢弃」。
- **下游会看到什么**：客户端 `event: error` 的 message 变成 `[delivery] close-anchor-terminal cannot advance a torn wire transaction`（或 owner 写失败的原始 message），真实病因（上游截断 / 5xx）在客户端与 History 两处都消失。
- 修复建议：`streamErrorOutcome(new DeliveryOwnerError(...), env)` 改为携带 `{ cause: thrown }`，或先按 `thrown` mint outcome、把 owner 错误降级为诊断字段。

**[minor] `src/routes/messages/handler-v4.ts:1476-1481` —— 站点 2 的 `fail` 闭包丢掉 partial 与原始 error**
- 证据：`fail: (ownerError) => env.ctx.fail(acc.model || model, ownerError)`；同分支下方的正常路径传的是 `{usage, stop_reason, stopDetails, content}`（`:1512-1517`）。
- **下游会看到什么**：owner 失败终局的 History 条目里，抛错前累积的 thinking / text 内容为 null，且原始上游 `error` 不可见 —— 违反 richest-data-flow。
- 修复建议：`settleFromOwnerFailure` 的 `fail` 闭包补 `buildAnthropicResponseData(acc, model)` 的四件套，并把站点原始 `error` 作 `cause`。

**[minor] 本 commit 引入 10 条新 lint 错误**
- 证据：`bunx eslint` 逐文件扫描，`6333d800` 有 10 errors、同 4 个源文件在 `6333d800^` 上 0 errors。清单：`delivery/session.ts:25,26`（perfectionist/sort-imports）、`driver.ts:29`（同）、`driver.ts:1437,1618`（prettier）、`handler-v4.ts:153`（sort-imports）、`handler-v4.ts:1478`（prettier）、`tests/pipeline/anchor-allocation-owner.it.test.ts:190,217`（prettier）。
- **下游会看到什么**：本仓库 2026-06-29 起无 pre-commit 门禁、lint 靠手动 + review，这 10 条会沉进 `lint:all` 的既有噪音里，让后续会话更难分辨「我引入的」和「既有的」。
- 修复建议：对这 6 个文件跑 `bunx eslint --fix <精确路径>`（不要宽扫，避免卷入并发会话的既有 dirt）。

**[minor] `src/lib/pipeline/delivery/owner-failure.ts:22-26` —— `"client-gone"` 表项是死代码，且其值自相矛盾**
- 证据：`classifyOwnerFailure`（`:41-46`）在查表前就 `if (failure.reason === "client-gone") return {kind:"client-aborted", …}`，所以表里的 `"client-gone"` 分支永不执行；它返回的却是 `{kind:"fail-loud", reason:"wire-torn", error:"unreachable client-gone fallback"}`。
- **下游会看到什么**：现在无影响，但它是个静默陷阱——将来若有人把 early-return 重构成纯查表（这是最自然的清理动作），编译器不会报错，`client-gone` 会被静默降级成 wire-torn fail-loud，客户端断开被记成 wire 撕裂。
- 修复建议：表项改为 `() => { throw new Error("client-gone is handled before the table") }`，或把 `committed` 一并编进表签名让 `client-gone` 真正由表处理。

**[minor] `tests/architecture/package-boundaries.unit.test.ts:600-609` —— legacy 字段 allowlist 用整文件白名单 + 文本正则，且测试内无正样本对照**
- 证据：`allowedAnchorClosedWriters = new Set(["lib/pipeline/delivery/session.ts"])` + `/anchorClosed\s*=/`；plan ④ 要求「按具名函数／AST owner 判定，**不宽放整个文件**」并「正样本对照保留」。anchor-stop 守卫也是单行正则，`sink.write(anchor.stopFrame(0))` / `writeSynthetic` 形态或跨行写法都绕得过。
- **下游会看到什么**：M5 之前若有人在 `session.ts` 内的**非 owner 函数**里写 `anchorClosed`，守卫不咬；用非 `writeAnchor` 通道写 anchor stop 也不咬 → 第二关闭权威可能悄悄复活，客户端拿到两个 `stop@0`。（我实测该守卫对 driver 赋值与 handler 的 `writeAnchor?.(…stopFrame)` 两种形态都会转红，所以它有判别力，只是形状比冻结的松。）
- 修复建议：改为 AST 匹配「赋值语句所在的具名函数」，并在测试内内联一段正样本源文本（现在的正样本要靠人手工改代码才存在）。

**[minor] `tests/architecture/anchor-remap-single-authority.unit.test.ts:130-136` —— 断言由集合相等弱化成 `.every(...)`，空集恒真**
- 证据：`expect(violations.every((entry) => entry.startsWith("src/lib/pipeline/driver.ts") || entry.startsWith("src/lib/anthropic/live-reconcile.ts"))).toBe(true)`。
- **下游会看到什么**：M4 的收口门是「bridge 判据全仓零命中」；这个形状在 `violations` 为空时 `.every` 返回 `true`，也就是**零命中和三腿都还在 bridge 都同样绿**，M4 那道门会静默通过。它也不检查命中次数，某腿多加一处 bridge 同样不咬。
- 修复建议：改成期望**精确集合**（文件 → 命中数），M2/M3/M4 每迁一腿就同步收缩这张表。

**[minor] `PipelineInfo.wirePartialDelivery` 的接线只有 ctx 层单测，owner→ctx 这一跳无覆盖**
- 证据：`rg wirePartialDelivery tests/` 只命中 `tests/context/request-buffered-merge-info.unit.test.ts`，那条用例从 `ctx.recordWirePartialDelivery(...)` 手工起手。`makeAnchoredSseSink`（`handler-v4.ts:1206-1212`）→ `SseSinkOptions.recordWirePartialDelivery` → `createDownstreamDeliverySession` → `recordPartialDelivery`（`session.ts:275-278`）整条链没有任何测试驱动。plan ⑦ 要求 returned client-gone 与 thrown wire-error 两条 post-commit 腿都在 settle 后从 History 读回。
- **下游会看到什么**：若 option 名写错或 `ctx` 为 undefined 时的可选传递退化，`wirePartialDelivery` 会恒不落库 —— 而这正是 plan 性质 7 要求的「partial-delivery 必须落到持久载体」，缺了它，「stop 是否已部分上线」在事后不可判定，而测试全绿。
- 修复建议：加一条 owner 层 IT：真实 delivery session + 会在 post-commit 抛 client-abort / 非 client 错误的 sink，断言注入的 recorder 收到 `{operation, cause, committed:true}`；再加一条经真实 HTTP 入口的 History 读回。

**[nit] `src/lib/pipeline/delivery/session.ts:298, 305` —— `wireTorn` 的优先级高于 `client-gone`，转移表未定义该叠加态**
- 证据：`ownerUnavailable` 先判 `wireTorn`，`closeUnavailable` 也先判 `wireTorn` 才判 `state`。于是「已 client-gone **且** 已 wireTorn」时：四个 frontier 入口返回 `wire-torn`（→ fail-loud）而不是 `client-gone`（→ aborted）；`closeOpenAnchor` 则会去写一个已 finalize 的 sink。
- **下游会看到什么**：两种失效叠加的请求终态记成 failed 而非 aborted。属窄边界，但转移表没写 precedence，M5 清理时容易踩。
- 修复建议：在 plan 转移表补一行 precedence（建议 `client-gone` 优先），并按之调整判序。

**[nit] `src/lib/anthropic/live-reconcile.ts:156` —— 装饰器仍以 `state.anchorBlockOpen` 为门，不是 plan ③ T-B 要求的「无条件请求 owner close」**
- 证据：`if (port?.wireState && state.anchorBlockOpen && (isContentBlockStart(frame) || …))`；plan T-B 明写「装饰器**无条件**请求 owner `closeOpenAnchor`，由 owner 的 `{ok:true,value:"none"}` 分支负责幂等」并「有意接受 per-frame 开销」。
- **下游会看到什么**：M1 期两者等价（`anchorBlockOpen` ⟺ 有 owner anchor），但 M5 删 legacy 字段时这里是一个必须同时改的隐藏耦合点；若 M6 的 gap injector 未同步置 `anchorBlockOpen`，gap anchor 在 live 腿将**不会被关闭**，客户端拿到两个并存的 open block（C2 `maxOpen===1` 破裂）。
- 修复建议：现在就去掉 `state.anchorBlockOpen` 这一项，只留 `port?.wireState` + 触发帧判定。

## 主观建议

- **[建议] `docs/tmp/2026-08-03-anchor-m1-progress-impl-1.md` 的「剩余项」第 1 条** —— 该条写「owner→owner exactly-once 与 13 关闭者由同一 owner API、架构零 legacy stop 守卫和现有站点回归联合覆盖」并已勾选 `[x]`。预期影响：这是**会被后继会话当作事实依据**的 wrap-up 断言，而逐站点删除 mutation 实测 7/13 无覆盖；不改的话 M2–M4 的执行者会以为站点回归网已经在，从而放心大改这一带。推荐做法：把上表（哪个站点转红、转的哪条）写进进度文件与 plan 的 M1 行，并把 `[x]` 降回 `[ ]` 直到覆盖补齐。
- **[建议] 给 owner 层的 wire-torn / session-terminating oracle 加显式限制标注** —— plan「验收分层」要求「这一层证不到站点接线，必须在测试名与计划记录里明确写出该限制」。预期影响：避免后续 review 把 owner 层绿当成 HTTP 覆盖（本项目吃过「通过/空/干净结论不自证」的亏）。推荐做法：测试名加 `(owner layer only — proves classification, not site wiring)`。
- **[建议] heartbeat 时钟 oracle 补 `lastContentDeltaAtMonotonic` 维度** —— 预期影响：`closeOpenAnchor` / `writeBlockFrame` 里 `if (isContentDelta(...))` 这一支目前无断言，删掉它测试仍绿，而它直接决定 content-idle 升级的排队时机（P6 的现网缺陷就出在这类时钟上）。
