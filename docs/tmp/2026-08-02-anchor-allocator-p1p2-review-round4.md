# 第四轮定点复验 — `feat/anchor-allocator-p1p2` @ `3d411b05`

- 评审者：独立 reviewer（与第二/三轮同一实例，非实施者）
- 上轮审的是 `761cdd2e`（1 Blocker + 1 Major + 4 Minor + 2 Nit），本轮 4 个 commit
- 变异环境：自建 scratch worktree `review-r4-scratch`（`3d411b05`）；`.worktrees/alloc-p1p2` 生产源码全程未触碰
- 判据轴：长远正确 + 完整

## 基线

| 项 | 结果 |
|---|---|
| `bun run typecheck` | 绿 |
| `FORCE_COLOR=0 bun scripts/parallel-test.ts unit it http` | **6571 · 6571 pass · 0 fail**（与自报一致） |

---

## 复验 1 — 生产形态探针：wire 已恢复 ✅

同一探针（真 `makeReconcilingSink` + 真 `anchorStopFrame`/`remapAnthropicBlockIndex` + 真 hedge harness，anchor 已注入并 open）：

```
anchor {"type":"content_block_start","index":0,...}
anchor {"type":"content_block_stop","index":0}        ← 恢复：anchor 正确闭合
real   {"type":"content_block_start","index":1,...}   ← 恢复：+1 remap
real   {"type":"content_block_delta","index":1,...}
real   {"type":"content_block_stop","index":1}
real   {"type":"message_stop"}
indices: [0,0,1,1,1] | anchorClosed: true
winnerCandidateId: candidate:1                        ← identity 同时保住
```

三轮对照：`2eca9248` = `[0,0,1,1,1]`/`true`（正确）→ `761cdd2e` = `[0,0,0,0]`/`false`（Blocker）→ **`3d411b05` = `[0,0,1,1,1]`/`true`（已修复）**。

且 `winnerCandidateId` 非空，证明「身份记账与字节投递拆分」**两个属性同时成立**——上轮我指出的取舍已被正确消解，不是把问题换个地方。

## 复验 2 — 新 HTTP oracle 的反向 mutation：确实转红，且红在对的地方 ✅

把 winner frames 改回 owner-direct write（`commitWinnerBlock` / `writeWinnerFrame`，保持 typecheck 绿）后：

```
Expected length: 1
Received length: 2
(fail) C0 golden (a) ... > hedge winner still traverses live reconcile after an anchor opens
 1 pass · 1 fail
```

- 红的是**新增的专用 oracle**，断言正是 `message_start` 恰好 1 个；
- 同文件的**字节 golden 那条仍然绿**（`1 pass`），所以不是「golden 字节顺带变了」的连带失败。

该 oracle 的质量我逐行核过，确实是生产驱动而非重建接线：写真实 `PATHS.CONFIG_YAML`（经 `tests/helpers/sandbox-paths.ts` 的 `XDG_DATA_HOME` 沙箱重定向，实测真实 `~/.local/share/copilot-api/config.yaml` mtime 仍是 Jul 27，未被污染）打开 `hedge.enabled` + `stream_keepalive_mode: empty_text`，`createFullTestApp` + `app.request("/v1/messages")`，两条真实上游流（primary 停在半个块上、hedge 后手完成），断言落在**真实响应字节**上：`message_start` × 1、`content_block_{start,stop,delta}` indices 全为 `[0,1]`、`PRIMARY-MUST-NOT-LEAK` 不出现、ledger `openBlocks = []`。

## 复验 3 — `wireTorn`：三个属性同时成立 ✅（上轮互斥的两件事已解耦）

探针（首帧 `writeAnchor` 抛非 client 的 `TypeError`，即一次撕裂事务）：

```
[T1] first allocation  -> threw:DeliveryOwnerError committed=true | state = open        ← session 不再被硬关
[T2] SECOND allocation -> {"ok":false,"reason":"wire-torn","committed":false} | frontier = 1   ← 毒化生效，frontier 不再推进
[T3] beginLeg after torn -> {"ok":false,"reason":"wire-torn","committed":false}          ← 五入口一致毒化
[T4] after terminate: finalize = 1 | log = ["synthetic:{\"type\":\"error\"}","close","finalize#1"] | state = closed
```

对照上轮：`761cdd2e` 是 `{"ok":true,"value":1}` + frontier 推到 2 + wire 在 index 0 留洞。现在：

- **index 0 永久消费但不再产生第二个洞**（frontier 停在 1，符合 C9 ②「永久消费绝不复用」）；
- **`terminate()` 仍送出终局 error 帧**（log 中的 `synthetic:{"type":"error"}`）；
- **finalize 恰好一次**。

这三件事在第二轮是互斥的（硬关 session 才能禁分配，但会吞掉终局帧和 finalize），现在同时成立 —— **协调者点名要验的那一条，成立。**

## 复验 7 — finalize race：三条链全部恰好一次 ✅

| 链 | finalize |
|---|---|
| R7-a：非 client error 保 open → 客户端随后断开 → `terminate()` | **1** |
| R7-b：client-gone 撞在途 `terminate()`（携终局帧）= 上轮 Minor-1 的原案例 | **1**（上轮是 2） |
| R7-c：连续两次 client-gone → `terminate()` | **1** |

`finalizeSinkOnce()` 的 promise latch（`session.ts:274-281`）被 `finalizeAfterClientGone` 与 `terminate()` 共用，**没有把 finalize 吞成 0 次**。上轮 Minor-1 闭合。

## 复验 5 — 穷尽 Record 是真穷尽（实验，非推理）✅

在 `OwnerFailureReason` 上加第四个成员 `"quota-exhausted"` 后：

```
src/lib/pipeline/driver.ts(924,7): error TS2741:
  Property '"quota-exhausted"' is missing in type '...' but required in type 'Readonly<Record<OwnerFailureReason, ResponseOutcome>>'.
```

类型系统**确实**逼出表项。上轮 Minor-2（五处三元式模板会把新 reason 静默归入 `delivery-finished`）闭合，且 `wire-torn → stream-error`（loud）而非静默终态，方向正确。

## 复验 6 — `no-mapping` 改 throw：实现与 README C10 逐字一致 ✅

- 实现：`session.ts` 的 `if (!mapping) throw new Error(...)`；类型收窄为 `Promise<OwnerResult<"written">>`；`OwnerFailureReason` 已不含 `no-mapping`。
- README C10 现文：「missing mapping 是确定的接线错误，**直接 throw，绝不进入生命周期 failure 通道、绝不原样透传**」——与实现一致。

**爆炸半径（我方核实，非采信）**：该 throw 位于 try 之外，**不会置 `wireTorn`**（此时确实一个字节都没写），所以不会连带毒化整个 generation。它会沿 `serializer.enqueue` 冒泡到 M2–M4 的调用点，再被 pump 的外层 catch 接住 → 合成 `event: error` 帧 + `ctx.fail`。因为 SSE 流此时已经 200 开着，**结果是流内 error 帧而不是 HTTP 500** —— 「任何一次 mapping 缺失都会变成 500」的担心不成立，是「响亮失败但保留已发字节」，符合本项目的 never-swallow-errors 取向。

## 复验 4 — `wire-torn → stream-error` 的下游：不会记成完全失败 ✅（留一条 Minor 残余）

Anthropic pump 的 `stream-error` 分支（`handler-v4.ts:1361-1405`）会：`closeAnchorIfOpen` → `writeSynthetic` 合成 error 帧 → `recordForwarded()` → `env.ctx.fail(model, error, { usage, stop_reason, content: partial.content })`，其中 `partial = buildAnthropicResponseData(acc, model)` —— **已积累的部分内容被保留进 History**，不会把「已提交部分字节」的流记成完全失败。客户端看到的是流内 `event: error`，与既有 H3 路径同形。

**残余（Minor-1，见下）**：`wire-torn` 只在**下一次 owner 调用**时才变响；撕裂事件本身（`DeliveryOwnerError`）在生产上由 heartbeat tick 的 `.catch()` 吞掉，若该 generation 没有后续 leg，就仍然静默。

## 复验 8 — 三个新引入物的边界：**未发现新的 Blocker/Major**，4 条 Minor / Nit

这是连续第四轮，前三轮每轮的修复都带进一个全套件抓不到的回归。我把 `noteWinner` / `wireTorn` / `finalizeSinkOnce` 三个新引入物逐个走了边界，结论：**本轮没有再引入 Blocker 或 Major 级回归**，但有四条需要记账的东西。

### [minor-1] 撕裂事件本身在生产上仍被静默吞掉 —— C9 ②「忠实记录」尚未落地

`wireTorn` 正确毒化了 **allocation**，但**没有毒化 legacy 写出路径**（`clientSink.write` 只判 `state !== "open"`，而 session 现在刻意保持 `open`）。过渡态下真实块仍走 legacy 路径，于是一次**瞬时**的非 client 写失败会产生这样的客户端流（实测）：

```
[RES] inject -> threw:DeliveryOwnerError （生产上被 heartbeat tick 的 .catch() 吞掉）| state = open
[RES] mirror injected/anchorBlockOpen = true true | frontier = 1
[RES] client wire: [
  {"type":"content_block_stop","index":0},                  ← 给一个从未 start 过的块补 stop
  {"type":"content_block_start","index":1,...},             ← 真实内容落在 1，index 0 是洞
  {"type":"content_block_delta","index":1,...},
  {"type":"content_block_stop","index":1},
  {"type":"message_stop"}                                   ← 流正常收尾，被记成成功
]
```

即：客户端收到一个 index 0 的洞 + 一个孤儿 `content_block_stop@0`，而 ctx 从未 fail，History 记成成功。C9 ② 的三条子句里，「永久消费绝不复用」✅、「禁止后续分配」✅、「**忠实记录**」❌。

**为什么只判 Minor**：① 触发条件是**非 client 且瞬时**的 wire 写失败落在 anchor 事务内（若是持续性失败，下一次 `writeAnchor` 会再抛，直接走 pump 的 catch → 响亮失败）；② **它是自愈的过渡态问题** —— M2–M4 把真实块迁到 `writeBlockFrame` 之后，写出路径本身就被 `wireTorn` 覆盖，这条残余自动消失。

**建议**：要么在 M2 之前把 `wireTorn` 也接进 `write()`（撕裂后拒绝一切非终局写），要么在置位 `wireTorn` 的同时打一条 ctx 诊断（`recordAttemptDiagnostic` 之类），让 History 至少留痕。**至少要在 plan-3 的 M2 前置条件里写下这条**，否则它会随过渡态一起被忘掉。

### [minor-2] `OWNER_FAILURE_OUTCOMES` 里塞了一个**模块级共享的 `Error` 实例**

```ts
const OWNER_FAILURE_OUTCOMES: Readonly<Record<OwnerFailureReason, ResponseOutcome>> = Object.freeze({
  ...
  "wire-torn": Object.freeze({ kind: "stream-error", error: new Error("[delivery] wire transaction is torn") }),
})
```

这个 `Error` 在**模块加载时**构造一次，被此后每一个 torn-wire 请求共享：① 它的 `stack` 指向模块加载点，对定位毫无用处；② `Object.freeze` 只冻结外层 outcome，**不冻结 Error 本身**，任何下游给 error 挂请求上下文（本仓库的 `shapeRawStreamErrorFrame` / 诊断链路都有这种做法）都会跨请求泄漏；③ 与紧邻的 `session-terminating` 分支形成不一致 —— 那条是**每次 new**。

**建议**：Record 存工厂（`() => ResponseOutcome`）或只存 `kind`，`Error` 在 `ownerFailureOutcome` 内每次构造；最好把撕裂时捕获的原始 `DeliveryOwnerError` 作为 `cause` 带上，别丢掉真正的失败原因。

### [minor-3] `delivery-finished` outcome 至今仍零覆盖

`grep -rn 'delivery-finished' tests/` 只命中一条**测试名**里的字样（`allocation-begin-leg-after-termination.it.test.ts:47`，它断言的是 owner 的 `{ok:false}`，不是 driver 的 outcome）。新增的 `delivery-finished-outcome.it.test.ts` 覆盖的是 **ctx 未 settled → loud `stream-error`** 那一支，**恰恰不覆盖真正产出 `delivery-finished` 的那一支**（ctx 已 settled）。于是六个 handler 里那六段 `recordForwarded(); return;` 依然没有任何 oracle。

上轮 Minor-3 只闭合了一半：`ownerFailureOutcome` 现在保证「ctx 未 settled 时不会静默 return」，这是实质进步；但「ctx 已 settled 时静默 return 是对的」仍是未验证断言。

**建议**：给同一个测试补一个孪生用例——先 `ctx.complete(...)` 再终结 session，断言 outcome 为 `delivery-finished` 且 handler 不再二次 settle。

### [nit-1] `commitWinnerBlock` / `writeWinnerFrame` 已成生产死代码，且它们承载的 winner 一致性守卫随之消失

`grep -rn "commitWinnerBlock\|\.writeWinnerFrame(" src/ | grep -v delivery/session.ts` **零命中**。这两个方法原本会在 candidate 不一致时 `throw new Error("[delivery] winner is X, not Y")`；`noteWinner` 则是**无条件覆盖** `winnerCandidateId`。功能上今天没人踩（只有 hedge 一处调用），但一条运行时不变量被静默移除了。建议：要么删掉这两个已死方法（连同 `DownstreamDeliverySession` 接口上的声明），要么把一致性校验搬进 `noteWinner`（二次 `noteWinner` 且 candidate 不同 → throw）。

### [nit-2] `finalizeAfterClientGone` 会把已经是 `session-terminating` 的 `finishReason` 覆写成 `client-gone`

`session.ts:283-290`：早退条件是 `if (finishReason === "client-gone" && finalized) return finalized`，所以「先正常 `terminate()`、随后某个在途 owner 操作以 client-abort 失败」这条链上，`finishReason` 会被从 `session-terminating` **改写**为 `client-gone`（同时 `state` 出现 `closed → terminating → closed` 的短暂回退，因为中间没有 await，无观察者，无实际危害）。后果是此后任何 owner 调用会把一次**正常收尾**报告成 `client-gone`，进而映射成 `settled-abort` —— 又是一次「在边界猜中止成因」。建议早退条件改为 `if (finalized) return finalized`。

### 已核实**未**回归的点

- `noteWinner` 只写 identity，**不写任何字节**（`session.ts:499-502`），winner frames 回到 `sink.write` → 经过 `makeReconcilingSink`（复验 1 已实证）。
- `winnerSource` 只影响 `clientSink.write` 的 provenance 标签，不影响 `writeSynthetic`/`writeKeepalive`/`writeAnchor`/`writeSyntheticEnvelope` 四条合成通道（各自仍走 `makeEnvelope`）。
- `finalizeSinkOnce` 把 `sink.close?.()` 挪进了一个微任务，但两个调用点都 `await` 它，`terminate()` 返回时 close+finalize 均已完成 —— 对 raw sink 契约无影响。
- `ownerUnavailable` 把 `wireTorn` 排在 `state !== "open"` **之前**，所以「既撕裂又已关闭」报告最响亮的那个原因，取向正确。
- 全量 `unit it http` = **6571/6571**，改动文件 eslint 0 error，typecheck 绿（均为我方独立复跑）。

## 上轮 6 条发现的闭合状态

| 上轮 | 状态 |
|---|---|
| Blocker：hedge winner 绕过装饰器 | ✅ **已闭合**（复验 1 + 复验 2 双向实证） |
| Major：C9-② 禁止后续分配 | ✅ **已闭合**（复验 3；「忠实记录」子句残余降级为 minor-1） |
| Minor-1：双 finalize | ✅ 已闭合（复验 7，三条链均为 1） |
| Minor-2：三元式模板 | ✅ 已闭合（复验 5，类型系统实验证明穷尽） |
| Minor-3：`delivery-finished` 零覆盖 + 不 settle | ⚠️ **半闭合**（ctx 未 settled 已 loud 化并有 oracle；ctx 已 settled 那一支仍零覆盖 → 本轮 minor-3） |
| Minor-4：`OwnerResult` 混装接线错误 | ✅ 已闭合（`no-mapping` 改 throw，union 只剩三个生命周期终态） |
| Nit-1/2（陈旧注释 / 重复 `recordForwarded`） | 未处理，不阻塞 |

## 可否合并

**可合并。**

据以判断的证据：

1. 上轮两条阻塞项**均由我方独立变异/探针实证闭合**，不是采信自报：
   - hedge wire 恢复 `[0,0,1,1,1]` / `anchorClosed:true` / `winnerCandidateId` 非空（三轮对照：`2eca9248` 正确 → `761cdd2e` 损坏 → `3d411b05` 恢复）；
   - 新 HTTP oracle 的反向 mutation 转红在 `message_start` 断言（`Expected 1 / Received 2`），字节 golden 保持绿，**证明该 oracle 有裁决力**；
   - `wire-torn` 毒化五入口、frontier 不再推进，**且**终局 error 帧仍送出、finalize 恰好一次 —— 第二轮以来互斥的三件事首次同时成立。
2. 穷尽 Record 经**实验**（加第四个 reason → `TS2741`）而非推理确认。
3. 三条 finalize 竞态链实测均为恰好一次。
4. 全量 6571/6571、typecheck 绿、改动文件 eslint 0 error，均由我方复跑。
5. 本轮**没有再引入 Blocker/Major 级回归** —— 这是四轮以来第一次。

**合并前建议（不阻塞，但请在 plan 里落账，否则会随过渡态一起被忘掉）**：

- **minor-1 必须写进 plan-3 的 M2 前置条件**：`wireTorn` 目前不覆盖 legacy 写出路径，撕裂事件在单腿流上仍静默；M2 迁真实块时这条自愈，但在那之前它是一个「客户端拿到 index 洞 + 流记成功」的窗口。
- minor-2（共享 Error 实例）建议顺手改掉，成本极低而诊断价值明确。
- minor-3 建议补孪生用例，把「ctx 已 settled → `delivery-finished` 静默 return 是对的」从断言变成事实。
- nit-1 建议删死代码或把一致性校验搬进 `noteWinner`；nit-2 一行改动。
