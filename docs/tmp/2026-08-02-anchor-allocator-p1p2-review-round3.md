# 第三轮复审 — `feat/anchor-allocator-p1p2` @ `761cdd2e`（合并态）

- 评审者：独立 reviewer（与第二轮同一实例，非实施者）
- 被审对象：worktree `/home/xp/src/copilot-api-js/.worktrees/alloc-p1p2`，HEAD `761cdd2e`（上轮审的是 `2eca9248`，本轮 7 个 commit）
- 变异环境：自建独立 scratch worktree `review-r3-scratch`（`761cdd2e`）+ `review-r3-prev`（`2eca9248`，回归对照），**两棵均已清理**（`git worktree list` 无残留）；`.worktrees/alloc-p1p2` 的生产源码全程未被触碰
- 判据轴：长远正确 + 完整。有效批评只有「它是错的」或「它没有裁决力」

## 总体 verdict

**不可合并 —— 存在 1 条 Blocker + 1 条 Major。**

上轮的 1 Blocker + 3 Major **实质上都闭合了**，每条有实证。但**本轮修复自身引入了一条新的 Blocker**：为消除 `writeWinnerFrames` 的 wrapper blind spot，hedge winner 的写出路径被改成**绕过 live 装饰器**直接进 delivery session —— 在默认开启 hedge 的 Anthropic live + anchor 配置下产出**两个 index 0 的 content block、anchor 永不闭合**的损坏 wire。这正是整个 plan 存在的理由所要消灭的故障型（C1/C2/R1/R3）。

本轮两条新问题的共同形状：**「顺手把上一轮的 minor 一起修了」**（Blocker）与**「把上一轮的 major 修过头」**（Major）。

| 级别 | 数量 |
|---|---|
| Blocker | 1（本轮新引入） |
| Major | 1（本轮新引入：C9-② 契约条款被静默丢弃） |
| Minor | 4 |
| Nit | 2 |

## 基线与环境事实

| 项 | 结果 |
|---|---|
| `bun run typecheck` | 绿 |
| `FORCE_COLOR=0 bun scripts/parallel-test.ts unit it http` | **6567 tests · 6567 pass · 0 fail**（与实施者自报一致） |
| `tests/pipeline` + `tests/anthropic` 连跑 3 轮 | 2214/2214 全绿，无抖动 |
| 本分支改动文件 eslint | 0 error |
| native history-search 产物 | scratch 建树后从主树复制；否则 14 条 sidecar 测试环境性红（与上轮同因） |
| `stripAnsi` cherry-pick（`3914eda9`） | 已在分支上，计数可信 |

---

## 逐条必查结论

### 必查 1 — 上轮 Blocker（live 腿死接线无裁决力）：**已闭合** ✅

亲手重做上轮那段「从 decorated sink 取 port」的完整变异（`handler-v4.ts:1334`，保持 typecheck 绿）：

```ts
: await driver.runResponseSink(upstream, env, liveReconcilingSink(sink, anchorHooks, anchorState), {
    ...(getDownstreamDeliverySession(liveReconcilingSink(sink, anchorHooks, anchorState))?.allocationPort
      && { wireAllocationPort: getDownstreamDeliverySession(liveReconcilingSink(sink, anchorHooks, anchorState))!.allocationPort }),
  })
```

结果：

```
error: expect(received).toBe(expected)
Expected: "primary"
Received: undefined
(fail) C0 golden (a) — live-anchored keepalive-ON direct stream (byte-for-byte) >
       stall injects the anchor; upstream resumes → commit reconcile remaps real blocks +1 (frozen bytes)
```

- **红的原因确实是 activeLeg 断言，不是 golden 字节**：`expect(text).toBe(expected)`（`c0-...http.test.ts:189`）在 activeLeg 三条断言之**前**，它没有报错；失败信息是 `Expected: "primary"`，正是 `:190` 的 `expect(observedDelivery?.allocationPort.wireState?.activeLeg?.kind).toBe("primary")`。
- 全套件层面确认唯一性：变异下 **6567 tests · 6566 pass · 1 fail**，唯一红的就是这条。
- 该 oracle 走真实 HTTP 入口（`createFullTestApp` + `app.request("/v1/messages")`），经 `setDeliverySessionObserverForTests` 捕获 **handler 实际创建的** session；observer 已进 `tests/helpers/isolated-fixture.ts:153` 的 RESETTERS，不会跨测试泄漏。

**结论：上轮 Blocker 真闭合，且新 oracle 具备裁决力（经我方独立变异验证，不是采信实施者自报）。**

### 必查 2 — Major 1 新状态机（`terminating` 中间态）：**主体闭合，发现 1 条 Minor** ⚠️

三个场景实测（`session.ts:271-279` `finalizeAfterClientGone`）：

| 场景 | finalize 次数 | 调用顺序 | 结论 |
|---|---|---|---|
| A：post-commit **client-gone** | **1** | `anchor, close, finalize` | ✅ 顺序与 `terminate()` 一致（先 `close()` 后 `finalize()`），符合 raw sink 契约 |
| B：post-commit **非 client** 错误 | **1** | `anchor, write:{"type":"error"}, close, finalize` | ✅ session 保持 `open`，**终局 error 帧成功送达**，finalize 恰好一次 —— 上轮 Major 1 的两个后果全部消失 |
| C2：client-gone 与**在途 `terminate()`**（携终局帧）竞争 | **2** | `anchor, close, finalize#1, close, finalize#2` | ❌ 双 finalize（见 Minor-1） |

双向 mutation：
- 删掉 `finalizeAfterClientGone` 里的 `await sink.finalize?.()` → `allocation-begin-leg-after-termination.it.test.ts` 转红（1 fail）。
- 反向（finalize 计数必须为 1）由现有测试的正断言锁住。

「非 client error 保持 open 后客户端随后才断开」的双路径问题：不会双路径——后续 owner 操作走 `finalizeAfterClientGone`（对 `closed` 幂等），后续 `terminate()` 走 `if (state !== "open") return`。**唯一破口是 C2 那个 `terminating` 窗口**（`finalizeAfterClientGone` 只判 `state === "closed"`，不判 `"terminating"`）。

### 必查 3 — `DeliveryOwnerError.committed` 可信度：**可信** ✅

判定点在 `session.ts:296-301`：

```ts
if (!committed) {
  reservation.commit()
  onCommit?.()
  committed = true          // ← 与 reservation.commit() 同一同步块
}
applyPendingFrame(entry)
await writeToSink(sink, entry)   // ← 第一次外部写在此之后
```

`reservation.commit()` 与 `committed = true` 之间**没有 await**，且两者都在第一次 `writeToSink` **之前**。因此不存在「reservation 已 commit 却报 `committed:false`」或反之的窗口——包括「首帧写失败那一刻」：此刻 `committed === true` 且 reservation 确已 commit。

双向 mutation（全部转红）：

| 变异 | 结果 |
|---|---|
| 失败一律 `committed: true` | 1 red — `a pre-commit owner throw restores every legacy mirror flag` |
| 失败一律 `committed: false` | **8 red** — 含 `a visible first frame is never rolled back when the second frame fails`、`an abort while the first write promise is pending is post-commit` 等 |
| injector 的 catch 去掉 `restoreMirror()` | 1 red — 同上第一条 |
| （上轮遗留）`reservation.commit()` 移到 write 之后 | 8 red（上轮已验，本轮结构未变） |

`closeOpenAnchor` / `writeBlockFrame` 的 catch 一律 `committed: true`——它们不做 reservation，语义上「已尝试外部写」即 committed，与 C9「commit point = 首次外部 write」自洽。`buildStop` 抛出发生在 try 之外，会以原始错误逃逸（非 `DeliveryOwnerError`），injector 的 `if (!(error instanceof DeliveryOwnerError) || !error.committed) restoreMirror()` 对这种情况保守恢复 —— 方向正确。

### 必查 4 — hedge 腿：**`beginLeg` 覆盖完整 ✅，但配套的 `writeWinnerFrames` 改动是 Blocker ❌**

**`beginLeg` 覆盖面（正确）**：`driver.ts:872-880` 位于 `selectGenerationWinner` 之后、`if (raced.kind === "terminal")` 分支**之前**，因此 `terminal`（缓冲终态）与 live 两条 winner 路径都经过；`raced.kind === "failure"` 在更早处 return（无 winner，本就不该开腿）。`hedged-driver.it.test.ts:168-175` 断言 winner 的 candidate/dispatch 与 `modelOperationSnapshot` 一致，并交叉核对 `delivery.snapshot.winnerCandidateId` —— 这条 oracle 是有裁决力的。

**非 hedge 路径的 provenance 记账未被改坏**：`writeWinnerFrames` / `writeWinnerFrame` 的**唯一调用方**就是 `maybeRunHedgedResponseSink`（`driver.ts:883/889/890`，grep 全文件确认），非 hedge 路径不经过它们。

**但**：详见下方 Blocker-1。

### 必查 5 — C10/C11 文档与实现对照：**已对齐** ✅（留 1 条 Minor）

- README C10 现在写的是「missing mapping 返回 `{ok:false,reason:"no-mapping",committed:false}`，**绝不伪装成功、绝不原样透传**」，与 `session.ts:377` 的 `return ownerFailure("no-mapping", false)` **逐字一致**。上轮的 doc-vs-doc 矛盾已消除。
- README C11 已补记 hedge winner 为**第四类生产腿**（"ordinary primary、hedge winner（同属 primary kind）、continuation、recovery 四类生产腿都调"），与实现一致。
- plan-2:148 诚实作废了上轮那条被我证伪的「production live oracle 锁住」断言，并写明返工后的实际失败信息 —— **记录方式正确**。

**`no-mapping` 是否被某个站点静默吞掉**：今天**没有**。`writeBlockFrame` 在生产上**零调用方**（grep 全仓：只有 `session.ts` 定义、`types.ts:320` 声明、`cross-leg-mapping-isolation.it.test.ts:84` 测试），driver 五个 `if (!leg.ok)` 站点消费的是 `beginLeg`，而 `beginLeg` 的失败原因只可能来自 `refusedOwnerOperation()`（`client-gone` / `session-terminating`），**结构上不可能返回 `no-mapping`**。但见 Minor-2：这五处的写法是一个会被 M2–M4 复制的模板，而模板本身会把 `no-mapping` 归到 `delivery-finished`。

### 必查 6 — `delivery-finished` 新 outcome 的下游：**六处 handler 都处理了，但都不 settle、且零测试覆盖** ⚠️

全部新增分支（`messages/handler-v4.ts:1347`、`:1636`，`chat-completions/handler-v4.ts:560`、`:753`，`responses/handler-v4.ts:397`、`:594`，`gemini/handler-v4.ts:437`、`:647`，`responses/ws.ts:415`），形态一律是：

```ts
if (outcome.kind === "delivery-finished") {
  recordForwarded()
  return
}
```

与紧邻的 `settled-abort` 分支对比，后者是 `recordForwarded()` + `env.ctx.abort(...)` + `sink.finalize?.()`。新分支**既不 settle ctx，也不 finalize**。

- **不会误记为客户端 abort** ✅ —— 这正是新 outcome 的目的，做到了。
- **记录是否丢失**：`delivery-finished` 按构造只在「session 已被别人终结」时出现，那个「别人」通常已 settle 并已在 `terminate()` 内跑过 raw sink 的 finalize；外层 `handler-v4.ts:567` 的 `finally { sink.finalize?.() }` 也会再兜一次（对已 closed 的 session 是 no-op）。**但没有任何代码或测试强制这一点**，我也无法证否 —— 标为**待验证假设**。
- **零测试**：`grep -rn '"delivery-finished"' tests/` 无任何命中。一个新增的、跨 6 个 handler 的终态分支完全没有 oracle（Minor-3）。

### 必查 7 — 合并态四路径走查

| 路径 | 终结行为 | 结论 |
|---|---|---|
| Anthropic live **默认**（`ping`，无 escalation） | `buildAnthropicAnchorHooks(false)` → `anchorHooks` 为空 → `liveReconcilingSink` 返回 **raw sink 本身**；hedge 走 `explicitPort` 反查同一 session，写出目标与装饰路径重合 | ✅ 无差异 |
| Anthropic live **+ escalation / `empty_text`** | 装饰器是真的；hedge 胜出时 winner 帧**绕过装饰器** | ❌ **Blocker-1** |
| Anthropic **buffered** | `maybeRunHedgedResponseSink` 因 `"retryCap" in outerOpts`（`driver.ts:825`；Anthropic buffered 必传 `retryCap`，`handler-v4.ts:1311`）返回 undefined → 不进 hedge；`allocationPort` 在 `:1072` 提前解析一次，primary/recovery/continuation 三腿共用 | ✅ 上轮 minor（三腿不对称）已闭合 |
| **hedged**（driver 层） | `beginLeg("primary")` 覆盖 terminal / live 两条 winner 路径 | ✅ 腿正确；写出路径见 Blocker-1 |

### 必查 8 — 过渡态自洽性：**今天仍成立，但安全边际变薄，且在 hedge+anchor 下已被打破**

上轮的机制性论证由两条支撑：①frontier 只被 `allocateAndWriteAnchor` 推进（`withAllocatedRealBlock` 生产零调用方 —— 本轮仍然如此）；②每个 generation 至多分配一次 anchor（injector 的 `injected` / `contentAnchorInjected` 一次性 latch）。

- ① **仍成立**。
- ② 今天**仍成立**，但上轮它有**两道**屏障（injector latch + 「写失败即硬关 session」），本轮第二道被移除（这是修 Major-1 的必然代价），只剩 latch 一道 —— 见 Major-1（C9-② 「禁止后续分配」被丢弃）。
- **在 live + anchor + hedge 的组合下，自洽性已被 Blocker-1 直接打破**：实测 wire 上的 content-block index 序列是 `[0, 0, 0, 0]`。

---

## 事实性发现

### BLOCKER

#### [blocker] `src/lib/pipeline/driver.ts:872-890, 926-947` — hedge winner 的帧绕过 live 装饰器，产出两个 index 0 的 block、anchor 永不闭合

本轮为消除 `writeWinnerFrames` 的 wrapper blind spot，改成：

```ts
const explicitPort = outerOpts?.wireAllocationPort
const delivery = explicitPort ? getDeliverySessionForAllocationPort(explicitPort) : getDownstreamDeliverySession(sink)
...
await writeWinnerFrames(sink, delivery, selected.candidate, raced.bufferedFrames)
for await (const frame of raced.liveFrames) await writeWinnerFrame(sink, delivery, selected.candidate, frame)
```

而 `writeWinnerFrames`/`writeWinnerFrame` 的语义是 **`if (delivery) → delivery.commitWinnerBlock(...) / delivery.writeWinnerFrame(...)`，`else → sink.write(frame)`**。

在 Anthropic live 路径上 `sink` 是 `liveReconcilingSink(...)` 的产物（`handler-v4.ts:1224-1226` → `makeReconcilingSink`），`explicitPort` 是真实 port。改动之前 `getDownstreamDeliverySession(装饰器)` 必然 miss → 走 `sink.write` → **经过装饰器**；改动之后 `delivery` 被反查出来 → **直接写进 session，装饰器被完全跳过**。

而 `makeReconcilingSink` 承担的正是三件承重工作（`live-reconcile.ts:107-145`）：① 丢弃重复的真实 `message_start`；② 首个真实 `content_block_start` 前写出 anchor 的 `content_block_stop(0)`；③ 对全部 `content_block_*` 施加 `+1` remap。

**生产形态实证**（用真实 `makeReconcilingSink` + 真实 `anchorStopFrame`/`remapAnthropicBlockIndex` + 真实 hedge harness，anchor 已注入并 open）：

```
--- 761cdd2e（当前 HEAD）---
anchor {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}
real   {"type":"content_block_start","index":0,"content_block":{"type":"text","text":"secondary"}}   ← 第二个 index 0
real   {"type":"content_block_delta","index":0,...}
real   {"type":"content_block_stop","index":0}
real   {"type":"message_stop"}
content-block indices on the wire: [0,0,0,0]
anchorClosed: false          ← anchor 的 stop 从未写出

--- 2eca9248（上一 HEAD，同一探针）---
anchor {"type":"content_block_start","index":0,...}
anchor {"type":"content_block_stop","index":0}        ← 正确闭合
real   {"type":"content_block_start","index":1,...}   ← 正确 +1
real   {"type":"content_block_delta","index":1,...}
real   {"type":"content_block_stop","index":1}
real   {"type":"message_stop"}
content-block indices on the wire: [0,0,1,1,1]
anchorClosed: true
```

同一探针的简化版（用一个只做标记的装饰器）同样二分明确：`761cdd2e` 装饰器看到 **0** 帧、raw sink 收到 4 帧且全部未装饰；`2eca9248` 装饰器看到 **4** 帧、raw 帧全部已装饰。

**为什么是 Blocker**：
- 违反 C1（wire index 单调不复用）、C2（maxOpen === 1），命中风险登记 R1（静默重排客户端内容，SDK 不报错）与 R3（重复 wire index）。
- **默认配置可达**：`generationHedgeEnabled` 默认 `true`（`state-defaults.ts:148`），`runtime-policy.ts:13` 只要 `responseHeaderTimeoutMs > 0` 即 enabled；Anthropic live 分支不传 `retryCap`，`driver.ts:825` 的 buffered 排除项不生效，hedge 对 live 完全开放；anchor 由 `empty_text` 或 `streamKeepaliveEscalateSec > 0` 打开。三者同时成立即触发。
- 即便**没有** anchor，绕过装饰器也会丢掉真实 `message_start` 的 dedup（`live-reconcile.ts:120-123`），可能给客户端两个 `message_start`。
- **全套件 6567/6567 全绿**，没有任何测试覆盖「hedge + 装饰 sink」的组合 —— `hedged-driver.it.test.ts:152` 传的是**未装饰的** `delivery.clientSink`，因此 `explicitPort` 与 `getDownstreamDeliverySession(sink)` 解析到同一对象，**结构上无法暴露本缺陷**。

**这条的来历值得记一笔**：我上轮把它列为 Minor-m5，并明确写了「字节仍经装饰器抵达 delivery（`makeReconcilingSink` 会转发，账本不丢），丢的只是 candidate provenance 记账」。本轮的修复为了拿回 provenance，选择了**改写写出路径**，把一个记账缺口换成了 wire 损坏。

**修复方向**：provenance 与写出路径是两件事，不该耦合。保持 `await sink.write(frame)`（继续过装饰器），把 winner 身份用**不写字节的**方式告知 owner，例如先 `delivery.noteWinner(String(candidate))`（或复用现有 `noteUpstreamRoundStarted`）再走 `sink.write`；`commitWinnerBlock` 的「校验 winner 一致性」职责可以拆成一个纯记账方法。无论选哪种，**必须补一条「hedge + 装饰 sink」的 oracle**，并用上面那个生产形态探针（断言 wire 上出现 `content_block_stop@0` 且真实块落在 index 1）验证它确实转红。

### MAJOR

#### [major] `src/lib/pipeline/delivery/session.ts:305-317` — C9-② 的「禁止后续分配」被静默丢弃：撕裂事务之后仍可继续分配，wire 留洞

README C9 ②（**冻结契约表，标注「实施期不得自行更改；要改回主会话」**）原文：

> **② commit point 之后**（任一帧已尝试或已成功）→ index **永久消费绝不复用**，失败即**终止 delivery** + **禁止后续分配** + 忠实记录。

上一轮该条由「任何写失败都 `state = "closed"`」实现（虽然副作用过大，是我上轮的 Major-1）。本轮修复把 **非 client 错误** 改成「不关 session、抛 `DeliveryOwnerError`」—— 这个方向是对的，但**没有任何东西接替「禁止后续分配」这一半**：`writeAllocationFrames` 的 catch 里，非 client 分支只做 `consola.error` + `throw`，既不置位任何毒化标志，也不改 state。

**实证**（首帧 `writeAnchor` 抛非 client 的 `TypeError`，即一次撕裂事务）：

```
[PROBE] first allocation  -> threw:DeliveryOwnerError committed=true | session state = open
[PROBE] SECOND allocation after the torn transaction -> {"ok":true,"value":1}
[PROBE] wire after the failure: ["{\"type\":\"content_block_start\",\"index\":1,...}"] | frontier = 2
```

即：index 0 已被永久消费但它的 `content_block_start@0` **从未落到 wire 上**，紧接着第二次分配**照常成功**并写出 `content_block_start@1`。客户端看到的是**从 index 1 开始的块、index 0 是个洞** —— C9 ① 之外的第三种状态，正是这条契约要禁止的。

**现有测试为何全绿**：`allocation-begin-leg-after-termination.it.test.ts:47` 那条「所有 owner 入口在 wire failure 后拒绝」只用 `StreamClientAbortError`（`:50/:53`），**只覆盖 client-gone**。非 client 的「撕裂后仍可分配」没有任何 oracle。

**今天的可达性（诚实标注）**：`allocateAndWriteAnchor` 的唯一生产调用方是 anchor injector，其 latch 保证一个 generation 至多一次分配，所以**今天第二次分配在生产上不可达**；`withAllocatedRealBlock` 生产零调用方。**这条在 M2 迁移真实块的那一刻变为可达**，而且届时正是最热的路径。

**修复方向**：加一个 generation 级的 `wireTorn`（或 `allocationPoisoned`）标志——非 client、post-commit 的写失败置位；五个 owner 入口在置位后一律 `ok:false`（建议新 reason `wire-torn`，与 `session-terminating` 区分，避免把服务端撕裂伪装成正常终结）；同时**保留** session 的 `open` 状态，使终局 error 帧与 finalize 仍可执行（即上轮 Major-1 的收益不回退）。若主会话认为 C9 ② 应当改写（例如「禁止后续分配」降级为「允许但必须记录跳号」），那需要**回主会话改冻结契约表**，而不是在实现里静默省略。

### MINOR

#### [minor-1] `src/lib/pipeline/delivery/session.ts:271-279` — `finalizeAfterClientGone` 的幂等门只判 `closed`，不判 `terminating` → 双 finalize

守卫是 `if (state === "closed") return`。而 `terminate()`（`:481-491`）会**先同步置 `state = "terminating"`**，再 `await` 其终局帧写出（该写出会排在仍在运行的 owner 操作之后）。于是存在这个交错：

1. owner 操作正 parked 在 `writeToSink` 内；
2. `terminate({kind:"complete", frames:[...]})` 被调用 → `state = "terminating"`，其 `write()` 入队等待；
3. owner 操作以 client-abort 失败 → `finalizeAfterClientGone()` 看到 `"terminating"`（≠ `"closed"`）→ 继续执行 → `close()` + `finalize()`；
4. `terminate()` 恢复 → `state = "closed"`；`sink.close?.()`；`await sink.finalize?.()` → **第二次 finalize**。

实测：

```
[C2] finalize count = 2  order = ["anchor","close","finalize#1","close","finalize#2"]  state = closed
```

**生产影响有限**：两个 raw sink 各自带 `deliveryFinalized` 一次性 latch（`client-sink.ts:371-377` 与 `:674-679`），所以 `onDeliveryFinalized` → `ctx.finalizeModelOperationDelivery()` 实际只触发一次，且该方法本身被文档标注为幂等（`observability/middleware.ts:112-115`）。**但 owner 自己的 finalize-exactly-once 契约是破的**，正确性依赖下游对象的自我保护，而不是 owner 的不变量。

**修复方向**：守卫改为 `if (state !== "open") return`，或在 session 内部加一个 `finalizedOnce` latch 供两条路径共用。

#### [minor-2] `src/lib/pipeline/driver.ts:880, 994, 1081, 1495, 1553` — 五处 `if (!leg.ok)` 用的是「非 client-gone 一律 delivery-finished」模板，会把未来的 `no-mapping` 静默吞掉

五处一律写成：

```ts
if (!leg.ok) return { kind: leg.reason === "client-gone" ? "settled-abort" : "delivery-finished" }
```

今天安全（`beginLeg` 结构上只会返回 `client-gone` / `session-terminating`）。但 `OwnerFailureReason` 现在是三值联合，而这个三元式对**第三个值不作区分**——M2–M4 接线 `writeBlockFrame` 时最自然的动作就是复制这段模板，届时一次「mapping 查不到」（一个确定的接线 bug）会被翻译成 `delivery-finished`，handler 再 `recordForwarded(); return;` —— **静默丢帧且无任何信号**。这恰好是本次改动最容易滋生的新滑坡。

**修复方向**：把 reason→outcome 的映射抽成一个**穷尽 `Record<OwnerFailureReason, ...>`**（项目里已有该范式，见记忆 `route-variant-to-existing-outcome-and-exhaustive-record-audit`），让 `no-mapping` 在类型层面被逼着显式处理（应当是 throw 或 `stream-error`，不是静默终态）。

#### [minor-3] 六处 `delivery-finished` 分支零测试覆盖，且都不 settle ctx

`grep -rn '"delivery-finished"' tests/` **无任何命中**。这是一个新增的、跨 5 个文件 6 个站点的终态分支，形态与紧邻的 `settled-abort`（会 `ctx.abort(...)` + `sink.finalize?.()`）**结构性不同**，却没有一条 oracle 说明「不 settle 是对的」。SSE 路径上 `observabilityMiddleware` 明确早返回不兜底（`middleware.ts:93-94`），`handler-v4.ts:667` 的注释也写着「a silent return would leak a dangling entry」——这条分支恰恰就是一个 silent return。

我**无法证否**它会漏记（按构造，终结 session 的那一方通常已 settle），标为**待验证假设**；但「新终态分支零覆盖」本身是确定的缺陷。

**修复方向**：补一条 it 级 oracle —— 令 session 先 `terminate({kind:"complete"})` 再驱动 driver，断言 outcome 为 `delivery-finished` 且 ctx 已 settle（或显式断言「由前一方 settle」这一前提），并配 mutation（把分支改成 `settled-abort` 必须转红）。

#### [minor-4] `src/lib/pipeline/types.ts:295-296` — `OwnerResult` 的失败分支不再区分「预期终态」与「接线错误」的语义层级

`OwnerFailureReason = "client-gone" | "session-terminating" | "no-mapping"` 把两类东西塞进同一个联合：前两个是**预期的生命周期终态**（调用方应当安静收尾），第三个是**确定的接线 bug**（调用方应当喧哗）。plan-2:148 自己的裁决语是「未配置 `wireState`、reservation 重入、无 active leg 写 real 等接线错误**继续 throw**」——`no-mapping` 按 C10 的定性（「绝不伪装成功」）同属接线错误，却被放进了 `ok:false` 的正常返回通道。这是 minor-2 那个滑坡的**类型层根因**。

**修复方向**（与 minor-2 二选一或并用）：要么 `no-mapping` 直接 throw（与其它接线错误一致），要么在类型上把失败分支拆成 `{kind:"finished"; reason:...}` 与 `{kind:"wiring-error"; reason:...}` 两层，使调用方无法用一个三元式囫囵处理。

### NIT

#### [nit-1] `tests/pipeline/allocation-begin-leg-after-termination.it.test.ts:67` — 注释引用了已被删除的函数名

注释写「走 `terminateAfterWireFailure` → state = "closed"」，但该函数本轮已改名为 `finalizeAfterClientGone`，且语义已变（只在 client-gone 时关闭）。

#### [nit-2] `src/routes/messages/handler-v4.ts:1342 + 1348` — `recordForwarded()` 连续调用两次

`:1342` 已经调过一次，`delivery-finished` 分支（`:1348`）又调一次。功能上无害（幂等快照），但暴露该分支是从 `settled-abort` 复制来的，未按所在位置调整。

---

## 变异与探针清单（可复现）

全部在 scratch worktree 执行，`git checkout -- src/` 复位；对照基线 `tests/pipeline tests/anthropic tests/architecture` = 2257 pass / 0 fail。

| # | 变异 / 探针 | 结果 | 用途 |
|---|---|---|---|
| B1 | handler 从 decorated sink 取 port（复现原 bug） | 全套件 6566/1，唯一红 = C0 golden 的 activeLeg 断言 | 必查 1 |
| C1 | 失败一律 `committed: true` | 1 red | 必查 3 |
| C2 | 失败一律 `committed: false` | 8 red | 必查 3 |
| C3 | injector catch 去掉 `restoreMirror()` | 1 red | 必查 3 |
| C4 | `finalizeAfterClientGone` 去掉 `await sink.finalize?.()` | 1 red | 必查 2 |
| P-A/B/C2 | finalize 计数探针（三场景） | 1 / 1 / **2** | 必查 2 → Minor-1 |
| P-hedge-simple | 标记型装饰器 + hedge | `761cdd2e`: 装饰器 0 帧；`2eca9248`: 4 帧 | Blocker-1 |
| P-hedge-prod | 真 `makeReconcilingSink` + open anchor + hedge | `761cdd2e`: indices `[0,0,0,0]`, `anchorClosed:false`；`2eca9248`: `[0,0,1,1,1]`, `anchorClosed:true` | Blocker-1 |
| P-C9 | 首帧非 client 抛错后再次分配 | 第二次分配 `{ok:true,value:1}`，frontier=2，wire 洞在 0 | Major-1 |

## 双视角覆盖证据

**机械核对**：7 个 commit 的 diff 逐文件读；owner 五入口失败分支逐条对照 README C9/C10/C11 与 plan-2:148；`writeWinnerFrames` 调用方 grep 全文件；`delivery-finished` 六站点全部定位；`no-mapping` 生产消费者 grep 全仓（零）；README C10/C11 与实现逐字比对；两个 raw sink 的 finalize latch 逐行核实；`generationHedgeEnabled` 默认值与 `runtime-policy.ts` 的 enabled 条件溯源；全量 6567 与三轮子集 2214 的确定性。

**第一人称执行**：Anthropic live 默认 / live+escalation / buffered / hedged 四条路径各走一遍到字节层；post-commit client-gone、post-commit 非 client、pre-commit throw、client-gone 撞在途 terminate 四条失败路径各走一遍并落成探针；hedge 的 `terminal` 与 `liveFrames` 两条 winner 分支各追一遍；C9 撕裂事务后的「下一次分配」走一遍。

## 可否合并

**不可合并。** 剩余阻塞项：

1. **Blocker-1**（`driver.ts:872-890/926-947`）：hedge winner 绕过 live 装饰器 → 默认配置下的 wire 损坏。必须改回「过装饰器写、身份另行告知」，并补「hedge + 装饰 sink」oracle（用本报告的生产形态探针验证其裁决力）。
2. **Major-1**（`session.ts:305-317`）：C9-② 的「禁止后续分配」无实现且契约表未改。加毒化标志，或回主会话正式修订 C9。

修完这两条后**建议只做定点复验**（不必再全量重审）：① 用 P-hedge-prod 探针确认 wire 恢复 `[0,0,1,1,1]` 且 `anchorClosed:true`；② 用 P-C9 探针确认第二次分配被拒；③ 新增的两条 oracle 各做一次反向 mutation 证明其咬得住；④ 全量 `unit it http` 绿。

Minor-1..4 与两条 Nit 不阻塞合并，但 Minor-2 / Minor-4 建议**在 M2 开工前**处理——它们是模板性缺陷，M2 一旦开始复制就会扩散到每个真实块站点。
