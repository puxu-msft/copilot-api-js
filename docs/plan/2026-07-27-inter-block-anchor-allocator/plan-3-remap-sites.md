# P3M（合并相位）—— 三腿分配 + remap × continuation frontier × anchor 生命周期

> **前置**：P1（allocator 归位）、**P2**（owner API + commit-point 语义）。**产出**：frontier 成为全链唯一权威，且 gap anchor 特性开门。
> **本文件是本合并相位的权威**：执行顺序、commit 序列与门由此规定；任务细节分列于 [plan-4-continuation-frontier.md](plan-4-continuation-frontier.md)（continuation）与 [plan-5-gap-anchor-lifecycle.md](plan-5-gap-anchor-lifecycle.md)（anchor 生命周期）。**三份文件属同一个相位**。
> **承重项 1 + 3 + 5 + 6**。live 腿必接（冻结设计 §4.2 列了 `live-reconcile.ts`，审查 F8 亦确认）。

## 为什么合并（round-3 blocker，用户 2026-07-27 拍板）

两轮尝试都证明「remap 记账」与「anchor 生命周期」在**测试可满足性**上不可分：

- **第一轮**：要求「真实 gap 静默驱动多 anchor」，但 gap anchor 在后一相位 → 造不出 offset>1，把 remap 改回硬编码 `1` 结果完全相同，mutation 不会红。
- **第二轮**：改用生产 owner API 落第二个 anchor，解决了「谁触发」，但**没解决「谁关闭」**——可重复的 `openAnchorIndex` 状态机仍在后一相位，第一个 anchor 关闭后旧的 `anchorClosed` 永久为 true，第二个 anchor 无法由生产 close-before-real 关掉 → **O-2 会先于 remap 失败**，拿不到可归因的红绿门；测试若手工写 stop，又替后一相位的承重实现干活，重新引入假绿。

**裁决：合并为一个相位。** 硬拆只会让红绿门失真。

**同时并入原 P4（continuation frontier）**——planner 判断，非范围变更：P4 撞车 oracle 的分支二（`anchor@0 → real@1 → gap-anchor@2 → real@3` + 续写腿）同样需要多-anchor 能力，与上述两项属同一条依赖链；留在链外会重蹈「门不可满足」。分支一（零 anchor 续写腿）不需要多 anchor，仍可在序列早期完成。

## 测试如何取得多-anchor 前置状态（沿用第二轮的分层，已被 reviewer 确认成立）

测试**不等 heartbeat**，直接调 **P2 的生产** owner API `allocateAndWriteAnchor` 落 anchor——那正是 M6 之后 heartbeat 要调的同一入口，经同一 serializer、真写到 sink。**真实块的分配与 remap 一律由生产代码完成，测试一行不碰**。

```text
anchor@0（测试经 owner API 落）→ real@1（上游0，生产分配）
anchor@2（测试经 owner API 落）→ real@3（上游1，生产分配）→ offset = 2
```

| 关注点 | 处置 |
|---|---|
| 是否像「手工推进 allocator」那样替实现干活？ | **不是**。被测动作 = 真实块的**分配 + remap**，100% 生产路径；测试只提供 anchor 这个前置 wire 状态。driver 漏调分配或 remap 读错 mapping，照红。 |
| 算不算测试后门？ | **不算**。它是生产 owner API，heartbeat 走的就是它；差别只在**谁触发**，不在**走哪条路径**。既有架构守卫已足够。 |
| 「谁触发 anchor」谁证明？ | **M6 的 O-3**：heartbeat 在真实 gap 静默下确实调同一 owner。M2–M4 证「给定 anchor 在 wire 上，三腿记账正确」，M6 证「anchor 会在该出现时出现」，合起来无缺口。 |
| anchor 绕 buffer 会不会与 driver buffer 冲突？ | **不会**（reviewer 独立确认）：owner operation 与 driver flush 共享 serializer，调用发生在 boundary flush 之后、下一块到来之前时 buffer 为空。 |
| 第二个 anchor 谁关闭？ | **M1 已把可重复的 open/close 状态机前移进 owner**——这正是第二轮缺的那块。生产 close-before-real 因此能正确关闭每一个 anchor。 |

## 原子 commit 序列（**每个 commit 的终态不变量与可满足的门**）

> ### 半坏窗口为空的证明（承重论证）
>
> 本相位内「某腿已迁 frontier」与「某腿仍算 +1」两种状态**在生产上数值等价**，只要生产**尚未开出第二个 anchor**：
>
> - 开门前，同一 generation 至多一个 pre-content anchor，故任一真实块的 `mapping.wireIndex − mapping.upstreamIndex ∈ {0, 1}`；
> - 未迁移腿走 **M1 引入的 bridge 判据**（`anchorsOpened() > 0 ? +1 : +0`），已迁移腿走 frontier mapping；
> - 两者**逐块相等**（bridge 的等价性证明见下方「M1 的迁移 bridge」，含 `enveloped_ping` 分支）。差异**只在 ≥2 个 anchor 时显现**，而生产开出第二个 anchor 的唯一途径是 **M6 打开心跳门**。
>
> 故 M2–M5 期间即便三腿迁移进度不一，生产 wire 逐字节不变（O-6 每个 commit 都跑作为实证）。多-anchor 状态只存在于测试进程内，不是可交付的生产行为。M1 对 wire-torn 后关闭 的行为也已按 README C9 定稿为“close 例外可写”，因此行为等价不再有开放门控。
>
> **本序列唯一的硬序约束：M6 必须晚于 M2–M4 全部完成。** 违反它才会产生真正的半坏窗口（生产已开多 anchor 而某腿仍算 +1）。

| # | commit | 内容 | 终态不变量 | 可满足的门 |
|---|---|---|---|---|
| **M1** | `feat(delivery): repeatable anchor lifecycle and close authority in the wire owner` | **已完成（实现待独立 code review）**。① `openAnchorIndex` 状态机 + `closeOpenAnchor` API 落在 owner；② **13 个关闭者全部迁到 owner close**，其中三个 close-before-real 只迁关闭、各腿的分配 + remap 仍归 M2/M3/M4；③ legacy 字段保留到 M5，owner 镜像 `anchorClosed`，injector 维持开侧同步发布，live 层零 `anchorClosed` 读写；④ `closeOpenAnchor` / `writeBlockFrame` 补 heartbeat 时钟；⑤ `wireTorn` 只封锁四个 frontier 入口，close 例外仍可写；⑥ 未迁移腿用 bridge 判据；⑦纯 owner-failure 翻译、`PipelineInfo` partial-delivery 诊断与 `OwnerResult` 收紧在同一 commit 落地 | **可编译、行为等价、关闭权威唯一**：同一 anchor 不跨 legacy / owner 双轨；生产仍至多开一个 anchor；handler／driver 原有 settle、snapshot、heartbeat 时钟与 wire-torn 终局块平衡语义保留 | owner 单元测试（连续两轮 open/close、close 幂等、终局 exactly-once）+ **13 站点关闭回归** + owner→owner 组合 oracle（第二个关闭者得 `"none"`、wire 仅一个 `stop@0`）+ 任一关闭者改回 legacy 即转红的 mutation control + wire-torn 后 close 仍写 stop 的 oracle／反向 mutation + 两个 owner 写入口 heartbeat 时钟 oracle + live per-frame serializer 接线／O-6 wire 等价 + 四格可达／两格非法组合分层 oracle + `PipelineInfo` History round-trip + 类型级正负测 + owner-failure 边界守卫。**O-6 只证无-anchor 主腿；有-anchor 零变化由站点回归、exactly-once 与 wire-torn 后关闭 oracle 证明**（m-1、T-A、T-B） |
| **M2** | `refactor(driver): allocate and remap buffered-flush blocks via the frontier owner` | S1（`driver.ts:1185`）分配 + remap | S1 走 frontier；S2/S3 走 bridge（数值等价，见上方证明）；**S1 的 bridge 已删**；winner 一致性由同一 selected source 依次驱动 `beginLeg` + `noteWinner`，winner 帧继续走装饰 sink，旧 `commitWinnerBlock` / `writeWinnerFrame` API 不得复活 | Task 3.1 的 offset≥2 测试（M1 已使第二 anchor 能被生产正确关闭）；S1 两维 mutation 均红；O-1/O-2/O-6；**承接 P2 C11 移入项：History generation 轨断言 buffered-flush real frame 使用该 primary/recovery leg 的真实 candidateId/dispatchId，非 `"legacy"`** |
| **M3** | `refactor(driver): allocate and remap retreat write-through blocks via the frontier owner` | S2（`driver.ts:1242`） | S2 走 frontier；**S2 的 bridge 已删**；S3 仍走 bridge | Task 3.2 + S2 两维 mutation；O-1/O-2/O-6；**承接 P2 C11 移入项：History generation 轨断言 retreat real frame 沿用原 leg 的真实 candidateId/dispatchId，非 `"legacy"`** |
| **M4** | `refactor(live-reconcile): allocate, close off and remap live blocks in one wire transaction` | S3 分配 + remap；把 M1 已迁入 owner 的 close-before-real 与 real allocation/write **融合**进一个 transaction（不是到 M4 才迁关闭权威） | **三腿全部走 frontier**；bridge 判据零命中；legacy 字段 allowlist 仍是 M1 已达成的 owner + injector 两处；`tests/architecture/anchor-remap-single-authority.unit.test.ts` 的 AST `REMAP_CALL_ALLOWLIST` 中 `legacy:*` 条目清零 | Task 3.3 + S3 两维 mutation + “transaction 内不可插入”断言；O-1/O-2/O-6；legacy remap allowlist 清零后 ratchet 仍绿，临时新增 literal／变量 offset／直调 primitive 任一 remap 必红；承接 P2 C11 live 腿断言，并做 merged-state 三腿统一 oracle：primary/recovery/continuation real frame 各带真实 candidateId/dispatchId、均非 `"legacy"`、主腿 ≠ 续写腿。M4 未完成此统一断言即视为未完成 |
| **M5** | `fix(continuation): retire the dual offsets and the legacy anchor state fields` | plan-4 Task 4.1/4.2/4.3：退役双偏移、接 `beginLeg(kind, source)`；**并删除 M1 保留的 `anchorBlockOpen`/`anchorClosed`**（此时已无消费者） | `continuationOffset`/`wireDeliveredBlocks`/`anchorBlockOpen`/`anchorClosed` **全部零残留** | 4.1 **两条**撞车 oracle（分支二此时可满足）+ 两个 positive control + `beginLeg` 两格 mutation |
| **M6** | `feat(keepalive): allow gap anchors after the first committed block` | plan-5 Task 5.1/5.3：per-gap latch + gap injector + **删 `semanticBlockCount===0` 门**（特性开门）；**承接 P2.2b 因该门而不可达的后半：P6 boundary 恢复后的 tick 必须真实调用 `allocateAndWriteAnchor`** | 生产可开多 anchor——**此时三腿已全部走 frontier**，故无半坏 | O-3 精确形状 + **P2.2b 移入部分 red→green**：删门前只见 ping/不分配，删门后同一恢复 tick 进入 owner 分配；加回门 mutation 必红 + 架构守卫 mutation（裸 `allocateAnchor` 必红） |
| **M7** | `test(anchor): cover the continuation-leg × gap-anchor integration seam` | plan-5 Task 5.4 交叉缝 | 交叉行为被锁 | O-9 交叉 mutation 矩阵（同一测试对两侧 mutation 以**不同可辨识原因**失败）+ 两条单侧 control |
| **M8** | `test(anchor): multi-gap coverage and shipped-default byte equivalence` | plan-5 Task 5.5/5.6 | 默认配置零 anchor、字节等价 | 多 gap × 混合块类型（含 tool_use 不被推迟）；O-6 |

### M2 前置条件：legacy 瞬时撕裂必须随 S1 owner 化一并消失

**现象**：P2 的 `wireTorn` 只封锁四个推进 frontier 的 owner 入口（`allocateAndWriteAnchor` / `withAllocatedRealBlock` / `beginLeg` / `writeBlockFrame`）；`closeOpenAnchor` 例外，仍可平衡已分配 anchor。当前 legacy buffered/live 写出仍可在一次非 client 瞬时 write failure 后，绕 owner 写出孤儿 `content_block_stop@0`，handler 最终把该流记成功。若首个真实 start 尚未 owner 化，owner 看不到 legacy byte write，自然无法把它纳入 C9 commit/tear 裁决。

**为何当前第二次分配不可达、M2 后立即可达**：P2 生产分配调用方只有一次性 anchor injector，其 latch 使同 generation 的第二次 owner 分配不可达；M2 把每个真实 `content_block_start` 接入 `withAllocatedRealBlock` 后，同一 generation 会发生后续热路径分配，若 legacy撕裂未迁走便会把 index洞与孤儿 stop 带入真实流。

**M2 必须消除什么**：S1 的 start 分配、delta/stop mapping 查询、实际 write 与失败裁决必须全部进入同一 owner serializer；非 client post-commit failure 置 `wireTorn`，后续 start分配被拒，terminal error/close/finalize仍由 delivery完成。不得只迁 start分配、仍把 delta/stop或成功 settle留在 legacy write路径。

**若 M2 拆分执行，满足点**：只有在 S1 的 start/delta/stop 三类帧均 owner 化、legacy S1 bridge/write零残留，并且具名 oracle复现“瞬时非 client撕裂 → 无孤儿 stop → 后续 real allocation 被 `wire-torn` 拒绝 → 请求不记成功”后，本前置条件才算满足；此前任何中间commit不得宣称 M2完成或开启 M6。

### M1 的迁移 bridge（**round-4 blocker：原方案「M1 删字段」会让 M2–M4 期间无法编译**）

审查坐实：M1 若立刻删 `anchorBlockOpen`/`anchorClosed`，尚未迁移分配 + remap 的 S1/S2/S3 会当场编译红——它们仍读取 legacy 状态（`driver.ts:1239-1265 / 1317-1321`；`live-reconcile.ts:126-141`）。M1 只把三腿的**关闭写出**迁进 owner，不提前做其分配 + remap；改读 `openAnchorIndex !== undefined` 又数值不等价，因为 anchor 关闭后该值为 undefined，但历史 wire shift 仍是 +1。

**修法：M1 只新增不删 + 未迁移腿用 bridge 判据。**

1. **旧字段保留到 M5**：`anchorBlockOpen`/`anchorClosed` 在 M1 不删；owner 维护 `anchorClosed`，injector 维护开侧镜像。live-reconcile 在 M1 起不再读写 `anchorClosed`，旧的分配 + remap 判据仍可读 → 每步都能编译。
2. **未迁移腿的 bridge 判据**：

   ```ts
   // 迁移期专用（M1 引入，随每腿迁移逐条删除，M4 后全仓零命中）
   const shift = wireState.allocator.anchorsOpened() > 0 ? 1 : 0
   outFrame = shift > 0 ? anchor.remap(frame, shift) : frame
   ```

   **等价性证明**：开门前（M6 之前）同一 generation 至多一个 anchor，故 `anchorsOpened() ∈ {0,1}`。
   - `anchorsOpened()===1` ⟺ 曾开过 pre-content anchor ⟺ 旧门 `injected && anchorBlockOpen` 为真 → 两者都给 `+1`；
   - `anchorsOpened()===0` ⟺ 从未开 anchor → 旧门为假 → 两者都给 `+0`；
   - `enveloped_ping` 模式：只注入 message_start envelope、**不开 anchor 块**，故 `anchorsOpened()===0` 且旧门的 `anchorBlockOpen` 为 false → 两者都给 `+0`（**这条最易漏，已核实**：`keepalive-anchor.ts` 的 envelope injector 置 `injected` 但不置 `anchorBlockOpen`）。

   三种情形逐块相等 → bridge 与旧门在 remap 论域内行为等价，M2–M4 期间相应 wire 字节不变（O-6 每 commit 实证）。wire-torn 后关闭 已按 README C9 定稿为 close 例外可写，不再构成本证明的开放项。
3. **逐腿删除**：每迁完一腿立刻删该腿 bridge；**M4 收口后全仓 bridge 零命中**（`rg -n "anchorsOpened\(\) > 0" src/` 为空），旧字段随 M5 一并退役。
4. **架构守卫**：bridge 判据只允许出现在**尚未迁移**的站点；M4 之后出现任何 bridge 命中即 fail。

#### 迁移期双写的精确状态转移表（**round-5 major：双写是经典分岔源，必须写死**）

下表规定每个 owner 操作**结束后**四个状态的取值；写者分工以“调查结论”④ 的两阶段 allowlist 为准：owner 维护 `anchorClosed`，injector 开侧同步发布／恢复 `injected`、`messageStartForwarded`、`anchorBlockOpen`，live-reconcile 自 M1 起不再读写 `anchorClosed`。任何偏离即 bug，不留解释空间。（M-4、T-B）

**M1 的供给缝已裁决（2026-08-03；权威细节见下方“调查结论”③）**：取混合——开侧留在 injector wrapper，关侧走由 `makeAnchoredSseSink` 唯一供给的窄 `legacyAnchorMirror?: { anchorClosed: boolean }`。纯 (a) 可在 owner 的 `serializer.enqueue` 前同步外壳实现，并非被 C9 禁止；未采纳的理由是保持 delivery 层格式无关，不把 `injected`／`messageStartForwarded`／content-latch 等 Anthropic prelude 语义带进 owner。本节下文凡说“owner 维护 legacy 字段”，一律按“owner 只维护 `anchorClosed`”理解。（Ma-2）

**M1 必须先完成「调查 → 定稿 → 评审 → 合主线」闭环，再迁站点（2026-08-02 第九/十轮两次改判后的定稿）**。

**改判过程记在这里，因为它本身是教训**：我先写“10 个站点各自 narrow `OwnerResult` 后自行处理”→ 评审指出会各自发明；改写成“交给既有映射”→ 评审指出 `ownerFailureOutcome` 是 `driver.ts` **私有**、handler 够不到；再改写成一个自拟 adapter → 评审指出该签名缺 `env.clientFormat`、且统一返回形状不适用于 `Promise<void>` pump。三次都是在没读过调用点两侧的情况下跨缝规定行为。调查现已读完 13 个关闭者及其收尾缝，冻结签名与分层见下方 ⑤；实施者不得退回逐站点自定义。

**本节只冻结必须成立的性质**（实现自由，但违反任一条即 M1 未完成）：

1. **唯一翻译点**：owner failure → 终局决定的翻译**只有一处实现**，driver 与各 handler 共用。**不得每个站点一份**。
2. **穷尽**：翻译对 `OwnerFailureReason` 穷尽，**加第四个 reason 必须编译失败**（`OwnerFailureReason` 现有且仅有三个：`client-gone` / `session-terminating` / `wire-torn`，见 `types.ts:295`；用 `Record`/`satisfies`，不用 `default` 兜底）。
3. **保住 provenance-gap 语义**：现行 `streamErrorOutcome` 在 `classifyStreamError === "unknown-cancel"` 时记 gap，且**需要 `env.clientFormat`**。翻译层产出 stream-error 时必须走同一入口（master 有守卫「stream-error minted in exactly one place」），故其入参**必须够得着 clientFormat**。
4. **按 reason 决定是否短路**（M-6）：`client-gone` / `session-terminating` 必须立即结束本站点终局路径、零追加字节；`wire-torn` **不短路**——跳过 anchor 关闭，但照常写本站点自己的终局错误帧、`recordForwarded()`，并按 failed settle。C9 冻结的是“禁止后续分配但不关闭 session，因此 terminal error / close / finalize 仍可完成”；普通 `sink.writeSynthetic` 不经过 owner 分配门。各 pump 返回类型不同，具体 return 形状按站点定。
5. **ctx 侧收尾仍归 pump**：owner 的 `finalizeAfterClientGone()` **只 finalize sink**，`ctx` 的 abort/settle 与 forwarded snapshot **必须由 pump 完成**——翻译层不做、也做不了。
6. **终态分类按 reason 分，不得一律 aborted**：`client-gone` → **aborted**；`wire-torn` → **failed**；`session-terminating` → ctx 未 settle 时 loud `stream-error`、已 settle 时 `delivery-finished`。
7. **partial-delivery 必须落到持久载体**：`client-gone` 的两个来源——preflight（`committed:false`，**零字节已写**）与 write catch（`committed:true`，**stop 可能已部分上线**）——动作相同但**证据不同**。**M1 必须冻结一个 request-scoped diagnostic／History 投影字段来承载它**，不得留给站点各自选择表达方式。
8. **`reason × committed` 共六种组合**：本节只对 `client-gone` 的两种给了差异化处置；**M1 必须对六种组合逐一 disposition 并写进 plan**：**可达的**——各配一条 oracle（不是「每个 reason 一条」，是**每个组合一条**）；**不可达的**——给出机制性证明（哪一行代码使它不可能），**并配两腿 positive control**：**腿一（producer 侧）**——临时破坏该机制（即让 producer 真的产出这个组合），必须有测试转红；**若 producer 边界同样由类型排除该组合**，腿一也允许 compile-red（`@ts-expect-error`），不强求运行时真产出它；**腿二（translator 侧）**——直接构造该非法组合喂给翻译层，它必须 **loud fail**（不得静默走某个相邻分支）。⚠️ **若最终的类型设计已在类型层排除该组合（构造不出来），腿二改为类型级负测**（`@ts-expect-error` 断言该构造不可编译）即可——**不得为了满足「能构造」而把公共入参放宽成更松的类型**，那是用测试倒逼生产接口变差。⚠️ **只做腿一证明的是相邻性质**（「producer 不产它」），证不了「万一产了会被抓住」；两腿都有才算「不可达」被钉住。

**M1 的第一个 task 因此是“读全量关闭站点 + 各 pump 返回类型 → 定翻译层的签名与模块位置 → 停下回报”**，不是直接动手迁站点。**（2026-08-03：该 task 已完成，结论在下方“M1 调查结论”；实际是 13 个关闭者。）** **硬门**：调查结论回填本节后，**必须经独立评审放行、且回填后的 plan 精确 pathspec 提交并合回主线，才能继续迁站点**——新定的签名、模块位置与 partial-delivery 载体字段**本身就是指令文本**（后续每个站点都照它做），适用“指令类文本必须评审”+“docs-merge-before-execute”，不得由实施者自审后径直开工、也不得把定稿滞留在未提交的 worktree 里继续干。

#### M1 调查结论（2026-08-03 回填 —— 本节以下即实施依据，取代上文所有「待 M1 定供给方式」的占位）

> 调查方法：逐个打开缝的**两侧**再落笔（记忆 `methodology-dont-specify-across-a-seam-you-havent-read`）。已通读并逐行核对：`src/lib/pipeline/delivery/session.ts` 全文、`src/lib/pipeline/types.ts:295-322 / 519-544`、`src/lib/anthropic/keepalive-anchor.ts` 全文、`src/lib/anthropic/live-reconcile.ts:104-190`、`src/routes/messages/handler-v4.ts:640-774 / 1086-1265 / 1380-1618 / 1660-1811`、`src/lib/pipeline/driver.ts:860-1010 / 1090-1340 / 1425-1440 / 1600-1620`、`src/lib/pipeline/client-sink.ts:485-515`、`src/lib/context/types.ts:500-540`、`src/lib/history/types.ts:211-231`、`src/lib/context/request.ts` 的 `PipelineInfo` 合并与落 History 路径，以及 mint 守卫 `tests/architecture/package-boundaries.unit.test.ts:590-624`。下方每条断言都附实测位置，实施期若与代码不符**以代码为准并停下回报**。

**① 站点清单（真实行号；编号权威只在本表）**（B-A、B-B、建议 1）

“关闭归属”与“该腿的分配 + remap 归属”是两条独立迁移轴：M1 一次迁完同一 generation 的全部 13 个关闭者；站点 11–13 只把关闭提前到 M1，各自腿的分配 + remap 仍留在 M2–M4。

| # | 站点 | 真实位置 | 所在函数返回类型 | 关闭归属 | 分配 + remap 归属 |
|---|---|---|---|---|---|
| 1 | 延迟提交路径的错误终局 | `handler-v4.ts:693`（在 `writeTerminalThenSettle` 内） | `Promise<void>` | M1 | 不适用 |
| 2 | direct pump `stream-error` | `handler-v4.ts:1416` | `Promise<void>` | M1 | 不适用 |
| 3 | direct pump 不可修复 tool_use | `handler-v4.ts:1526` | `Promise<void>` | M1 | 不适用 |
| 4 | direct pump 截断 | `handler-v4.ts:1553` | `Promise<void>` | M1 | 不适用 |
| 5 | direct pump 兜底 `catch` | `handler-v4.ts:1607` | `Promise<void>` | M1 | 不适用 |
| 6 | translate pump `stream-error` | `handler-v4.ts:1716` | `Promise<void>` | M1 | 不适用 |
| 7 | translate pump 截断 | `handler-v4.ts:1754` | `Promise<void>` | M1 | 不适用 |
| 8 | translate pump 兜底 `catch` | `handler-v4.ts:1798` | `Promise<void>` | M1 | 不适用 |
| 9 | driver retreat 后截断终局 | `driver.ts:1438`（`closeAnchorIfOpen` 定义于 `:1181-1193`） | `Promise<ResponseOutcome>` | M1 | 不适用 |
| 10 | driver 终端 | `driver.ts:1609` | `Promise<ResponseOutcome>` | M1 | 不适用 |
| 11 | driver flush 内 `closeAnchorBeforeReal` | `driver.ts:1239-1244`（调用点 `:1247` 终局 flush、`:1259` 首个真实块前） | `flushBufferedFrames(...): Promise<FlushResult>` | **M1** | **M2（S1）** |
| 12 | live-reconcile 关闭 | `live-reconcile.ts:129-140`（当前 stop 帧由装饰器 `:172-174` 经 `writeAnchor` 写出；M1 改为 owner 写出） | 纯函数 + 装饰器 | **M1** | **M4（S3）** |
| 13 | driver retreat live 写穿的 close-before-real | `driver.ts:1317-1321` | `runResponseBufferedSink(...): Promise<ResponseOutcome>` | **M1** | **M3（S2）** |

站点 1–8 共用 `keepalive-anchor.ts:259-265` 的 `closeAnchorIfOpen`；站点 9–10 用 driver 私有的同名闭包。站点 11–13 是三处 close-before-real；其中站点 13 位于 `if (retreated)` 的后续 live 写穿分支，每个真实 start 都独立判定，不是站点 11 的别名。

**② 关闭权威裁决：M1 按 anchor 原子迁完 13 个关闭者**（B-B）

否决另外两条：

- **(b)“让 legacy 关闭同步清 `openAnchorIndex`”——否决。** 它直接违反 P2 已立的架构守卫“生产代码不得在 owner 外读写 `openAnchorIndex`”（README 承重项 13）。为迁移期方便去松一条刚立的架构守卫，是拿架构健康换迁移便利，方向反了。
- **(a)“`closeAnchorViaOwner` 保留完整 legacy 前置守卫”——否决。** 它等于承认 owner 在 M1–M4 **不是**关闭权威，真正的幂等仍在 legacy 标志上。M1 的整个目标就是“close 权威 + exactly-once by construction”，(a) 把这个目标降级成措辞。

**采纳 (c)**：M1 迁移的是**这个 generation 的全部关闭者**（13 处），而不是“10 个终局站点”。M2/M3/M4 仍然只负责各自腿的**分配 + remap**，与关闭解耦。站点 11 在 `flushBufferedFrames` 内、站点 12 在装饰器内、站点 13 在 retreat 写穿分支内，三者都能调用 `closeOpenAnchor(_, "before-real")`；`"before-real"` 模式不停心跳（`session.ts:400` 只有 `"terminal"` 才 `closeHeartbeat`），不会误伤后续真实块的保活。关闭与相邻 real write 的排序由同一 serializer FIFO 保证。

两侧返回类型仍决定失败后的控制形状：handler 8 个终局站点在 `Promise<void>` 里，由 pump 收尾后 `return`；driver 的 `ResponseOutcome` 路径由 driver 适配器导出 outcome；三个 close-before-real 站点只迁关闭动作，其腿的分配 + remap 仍按 ① 的第二条轴实施。共享翻译层只产出**决定**，不强制统一调用方返回类型。

**③ 供给缝裁决：纯 (a) 技术可行但不采纳；取“开侧留在 injector、关侧走窄 mirror”的混合**（Ma-2）

- **同步时点**：`keepalive-anchor.ts:319-335` 的 injector 已在 owner operation 入队**之前同步**发布 `injected` / `messageStartForwarded` / `anchorBlockOpen`，并在 pre-commit 拒绝时由 `restoreMirror()` 复原；driver 的 `flushBufferedFrames` 在 serializer 外快照这些标志（`driver.ts:1223-1224`）。纯 (a) 在技术上**可行**：owner 可在 `allocateAndWriteAnchor` 的同步外壳中、调用 `serializer.enqueue(...)` 之前发布 migration-only mirror，并在未 commit 的拒绝或 throw 上恢复；C9 禁止的是 enqueue 时预留／消费 wire index，不禁止同步镜像发布。这里选择不用纯 (a)，不是因为它做不到。
- **否决纯 (a) 的架构理由**：保持 delivery 层格式无关。现有同步开侧同时承载 `injected`、`messageStartForwarded`、`contentAnchorInjected` 与 content-latch 等 Anthropic prelude 语义；把完整 `AnchorState` 或这些 publish/restore 语义放进 owner，会让 format-agnostic delivery 依赖消息 envelope 与 latch 细节。
- **纯 (b) 也不成立**：13 个关闭者不经过 injector wrapper，若 owner 没有窄关侧 mirror，`anchorClosed` 无法在关闭成功时更新。
- **owner 写出必须维持 heartbeat 时钟语义**（T-A）：M1 同时补齐 `closeOpenAnchor` 成功路径（`session.ts:401-409`）与 `writeBlockFrame` 成功路径（`:430-436`）的 `lastWriteAtMonotonic` 更新，并与 `writeAllocationFrames`（`:317-321`）同形：每次成功写出都更新 last-write；若帧为 content delta，同步更新 `lastContentDeltaAtMonotonic`。legacy close 原本经 `clientSink.writeAnchor` 进入通用 `write()`（`:120-130`）并更新时钟；若 owner 接管写出却不补这两个入口，heartbeat 会按旧时钟过早排队，M1 的行为等价不变量立即为假。
- **裁决**：`CreateDownstreamDeliverySessionOptions` 增加**迁移期专用的窄字段**（M5 随 legacy 字段一并删除）：

  ```ts
  /** Migration-only legacy mirror (M1–M4). The owner writes ONLY `anchorClosed`; deleted at M5. */
  readonly legacyAnchorMirror?: { anchorClosed: boolean }
  ```

  **唯一供给点 = `makeAnchoredSseSink`**（`handler-v4.ts:1086-1176`）——它是唯一同时构造 `anchorState` 与 delivery sink 的地方；经 `SseSinkOptions` 透传，形状照抄现有的 `wireState`（`client-sink.ts:486-491`）。owner 只在**两处**写它：`allocateAndWriteAnchor` 的 commit 回调（`session.ts:351-353`，与 `openAnchorIndex` 同一回调）→ `anchorClosed = false`（**重新武装**，转移表第 2 行）；`closeOpenAnchor` 成功路径（`session.ts:407` 清 `openAnchorIndex` 处）→ `anchorClosed = true`。
- **为何不做成派生 getter**（`anchorsOpened() > 0 && openAnchorIndex === undefined`）：M1 已让 live 层完全不碰 `anchorClosed`，但 driver 的 legacy 分配 + remap 判据在 M2/M3 前仍需要可写字段，故不能在 M1 改成只读 getter；M5 删除字段后该派生形式自然消失。
- **live 关闭形状**（T-B）：对真实 `content_block_start`、error、terminator 等触发帧，装饰器无条件请求 owner `closeOpenAnchor(_, "before-real" | "terminal")`，由 owner 的 `{ok:true,value:"none"}` 分支负责幂等；`reconcileLiveFrame` 自 M1 起不再读也不再写 `anchorClosed`。站点 12 的 stop 必须由 owner 写出，index 取 owner 的 `openAnchorIndex`，不得硬编码 `0`，也不得继续把 `frames[0]` 交给 `inner.writeAnchor`。allocation port 必须从 raw `inner` 取得；对 wrapper sink 查 delivery session 会得到 `undefined`，这是 P1+P2 已踩过的接线陷阱。
- **有意接受的开销**（T-B）：装饰器此后每个触发帧都进入一次 serializer operation，即使没有 open anchor、最终只得到 `"none"`。这是为单一关闭权威有意接受的 per-frame 开销；O-6 必须确认默认路径 client wire 无变化，计划不得把这项成本写成零开销。

**④ legacy 字段 allowlist 的两阶段 ratchet**（B-B、Ma-1、M-4、T-B）

写者分工以本条为权威，并与下方“迁移期双写的精确状态转移表”交叉引用：owner 维护 `anchorClosed`；injector 开侧同步发布／恢复 `injected`、`messageStartForwarded`、`anchorBlockOpen`；`live-reconcile.ts:138` 的 `anchorClosed` 写点在 M1 即删除，live 层此后不读也不写该字段。

- **M1 后**：只允许 delivery owner + `keepalive-anchor.ts` injector 开侧两处。
- **M5 后**：legacy 字段删除，allowlist 归零。

守卫按具名函数／AST owner 匹配，不宽放整个文件；正样本对照保留：临时在 driver 新增一处赋值必须转红。除此之外，M1 后生产代码在 owner 外不得写 anchor stop 帧。

**⑤ 纯翻译层 + driver／pump 侧适配器**（B-C、M-1、M-2、M-7、M-8、mi-2、mi-3、m-3、m-4、n-2）

**纯翻译层位置** = 新建 `src/lib/pipeline/delivery/owner-failure.ts`。它只允许 type-import `../types`，不得 import `driver.ts`、handler、`ResponseOutcome`、`RequestEnvelope` 或 context concrete implementation；新增 package-boundary／AST 守卫并实跑 circular-deps ratchet。记录副作用已按 ⑦ 下沉 owner，因此该模块是真正的纯分类器。

```ts
export type OwnerFailure = Extract<OwnerResult<unknown>, { ok: false }>

/** What the caller must do; each layer maps this to its own terminal shape. */
export type OwnerTerminalDecision =
  | Readonly<{ kind: "client-aborted"; reason: "client-gone"; partialDelivery: boolean }>
  | Readonly<{ kind: "delivery-finished"; reason: "session-terminating" }>
  | Readonly<{ kind: "fail-loud"; reason: "session-terminating" | "wire-torn"; error: Error }>

export interface OwnerFailureContext {
  readonly settled: boolean
}

export function classifyOwnerFailure(failure: OwnerFailure, operation: OwnerOperation, ctx: OwnerFailureContext): OwnerTerminalDecision
```

判别式必须用 `"fail-loud"`，不得用 `"stream-error"`：master 的 mint 守卫按**对象字面量**扫描，`tests/architecture/package-boundaries.unit.test.ts:590-624` 只允许 `streamErrorOutcome` mint `{kind:"stream-error"}`；这里本就不是 `ResponseOutcome`，共用词汇还会误导。（B-C）

- **穷尽性**：内部用 `satisfies Readonly<Record<OwnerFailureReason, …>>`，加第四个 reason 编译失败，不写 `default`。
- **分类规则**：`client-gone` → `client-aborted`；`wire-torn` → `fail-loud`；`session-terminating` → `ctx.settled ? delivery-finished : fail-loud`，沿用 `driver.ts:938-940` 的现行判据。调用方没有 ctx 时传 `{ settled: false }`，即站点 1 的 `ctx === undefined` 必须视为未 settle、loud fail，不得静默吞。（M-1）
### 已裁决：`wireTorn` 只禁止推进 frontier，`closeOpenAnchor` 仍可关闭已分配 anchor

用户 2026-08-03 选择读法 B，并已同步冻结到 README C9：`wireTorn` 后，四个推进 frontier 的入口 `allocateAndWriteAnchor` / `withAllocatedRealBlock` / `beginLeg` / `writeBlockFrame` 返回 `{ok:false,reason:"wire-torn",committed:false}`；`closeOpenAnchor` 是例外，仍照常写出已分配 anchor 的 stop 帧。关闭不推进任何 index；若拒绝关闭，客户端会收到未闭合的 `block@0` 紧跟 error，既违反 §10.5“错误终局前平衡块结构”，也是相对 legacy 行为的回归。

**对 preflight 的具体要求**：通用 `ownerUnavailable()` 不能直接用于 `closeOpenAnchor`，或必须支持 close 专用模式。close preflight 在 `wireTorn` 时不得拒绝，应继续读取既有 `openAnchorIndex` 并尝试 stop；`client-gone` / `session-terminating` 仍拒绝，因为这两种状态下写通道确已不可用。close 成功后按正常路径清 `openAnchorIndex`、置 mirror `anchorClosed = true`、更新时间戳；非 client close write 再失败仍抛 `DeliveryOwnerError`。

该裁决不改变 outcome 映射：四个 frontier 入口返回的 `wire-torn` failure 仍映射为 `fail-loud` / driver `stream-error`；它只改变 `closeOpenAnchor` 的 preflight 是否因 `wireTorn` 拒绝。性质 4 因而落实为：先由 owner 补 `stop@0`，再由站点写终局 error，客户端得到闭合的 block + error。
- **driver 适配器**：私有 `ownerFailureOutcome`（`driver.ts:937-942`）改收 `OwnerFailure + OwnerOperation`，消费 decision 后分别返回 `settled-abort`、`delivery-finished` 或调用既有 `streamErrorOutcome(decision.error, env)`；后者保留 `env.clientFormat` 与 provenance-gap 语义。更新的是 `ownerFailureOutcome` 的 5 个调用点（`driver.ts:878/1022/1109/1523/1581`），它们恰好都位于 `beginLeg` 失败分支，不是修改 `beginLeg` 自身。（m-3）
- **pump 侧助手**：`closeAnchorViaOwner(sink, anchorHooks, anchorState, ctx, mode)` 的 `ctx` 类型允许 `undefined`；成功／`"none"`／无 owner 返回 `undefined`，returned failure 或捕获到的 `DeliveryOwnerError` 返回 decision。`settleFromOwnerFailure` 的 options 必须一次吸收 8 站点差异：`model` 的三种来源、`partial` 的不同构造来源、可选 `upstreamSucceeded`（站点 3 为 `true`）、可选站点原始 `cause` 及站点 1 的自定义 settle 闭包；站点不得在调用处重新发明 reason 分类。owner failure error 是终态错误，站点原始诊断保留为 `cause`，不得丢弃。（M-8）
- **收尾顺序按站点分两种写法**，共同不变量是 snapshot 必须在 settle 前完成（M-2、m-4）：
  - **站点 2–8**：`client-gone` / `session-terminating` 的短路臂使用 `if (d) { recordForwarded(); settleFromOwnerFailure(d, ...); return }`；`delivery-finished` 不再 settle，但仍先 `recordForwarded()` 再 return。
  - **站点 1**：其作用域没有 `recordForwarded` helper，必须使用现有等价原语 `ctx?.setForwardedResponse({ sseEvents: [...forwardedSseEvents] })`，再调用站点 1 的 settle 闭包并 return。decision 处理须移出当前 `finally` 辖域，或让 `finally` 明确识别已 settle；不得依赖 `finally` 再次 settle，也不得形成 settle→snapshot。
  - **`wire-torn`**：不走上述短路，跳过关闭后继续本站点原有错误帧，随后以同站点的 snapshot 原语记录 forwarded track，再 failed settle。（M-6）
- **无 owner 只承诺 wire 字节等价**：`ping` 模式或数组 sink 无 delivery session 时 no-op，只能声称 client wire 与今天同样不写 anchor stop；不声称 legacy state 或 `sink.close` side effect 等价。数组 sink 若要断言 owner close，改用 fake delivery owner。（mi-3）

**`DeliveryOwnerError` 逐站点处置**（M-7）：

- 站点 1–4、6–7：由 `closeAnchorViaOwner` 内层捕获并转成 `wire-torn` 的 `fail-loud` decision；按下方性质 4 不短路，继续写本站点既有终局错误帧，`recordForwarded()` 后 failed settle。
- 站点 5、8：它们本身位于无内层保护的 `catch`，必须显式加同样的内层保护，不能让 owner throw 逸出 pump；随后继续当前 catch 的终局错误帧与 failed settle。
- 站点 9、10：driver 捕获后经既有 `streamErrorOutcome` mint 点导出 `ResponseOutcome`；同时显式保留原本无条件的 `sink.close?.()`，不得把它退化为“有 open anchor 才 close”。handler 侧 legacy primitive 的 `sink.close?.()` 是条件性的，driver 侧则无条件，两侧不得用一句概括。（M-3）
- 站点 11：owner throw 进入 `flushBufferedFrames` 的既有 `write-error` 结果，不写后续 real frame；站点 13：进入 `runResponseBufferedSink` 的非 client 错误路径；站点 12：装饰器向 pump 传播为 stream error。三者最终都汇入对应终局站点，由该终局站点按 `wire-torn` 规则写错误帧并 failed settle。不得在 close-before-real 层自行 mint 第二套 outcome。

**⑥ 六个 `reason × committed` 组合的 disposition**（Ma-3、性质 8）

`ownerFailure(...)` 的构造点全仓恰好 5 处，已逐行确认：`session.ts:290`（wire-torn, false）、`:291`（client-gone｜session-terminating, false）、`:328`（client-gone, 变量 committed）、`:413`（client-gone, true）、`:440`（client-gone, true）。

| reason | `committed:false` | `committed:true` |
|---|---|---|
| `client-gone` | **可达**——preflight（`:291`，`finishReason` 已是 client-gone） | **可达**——三处写失败 catch（`:328/:413/:440`）；`:328` 当前 production path 实践上为 true，但保留 boolean 以容纳未来 pre-write throw |
| `session-terminating` | **可达**——preflight（`:291`） | **不可达**——只由 `ownerUnavailable()` 产出，该函数写死 `committed:false` |
| `wire-torn` | **可达**——上一次撕裂后的后续调用走 preflight（`:290`） | **不可达**——同上；非 client post-commit 写失败 throw `DeliveryOwnerError`（`:332/:417/:444`），不进 `OwnerResult` |

把不可达性编进类型：

```ts
export type OwnerResult<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; reason: "client-gone"; committed: boolean }>
  | Readonly<{ ok: false; reason: "session-terminating" | "wire-torn"; committed: false }>
```

**不能只改类型。** 评审的 scratch typecheck 已实测：只收紧 `OwnerResult` 会在 `session.ts:269` 得 TS2322，因为 `ownerFailure(reason union, committed boolean)` 抹掉相关性；改成 overload 后仍会在 `session.ts:294` 得 TS2769，因为 `finishReason ?? "session-terminating"` 仍是 union。M1 的**同一个 commit**必须同步把 `ownerFailure` 改为接收上述失败对象字面量，并把 `ownerUnavailable` 显式分成 `wire-torn`、`finishReason === "client-gone"`、其余 `session-terminating` 三臂，各臂传对象字面量，使判别联合生效；不得把构造器写法留给实施者临场决定。

两个不可达组合的 producer 腿与 translator 腿均用类型级负测：`@ts-expect-error` 断言非法字面量不可编译，并各有合法组合正样本。四个可达组合的验收层级见下方“验收分两层”。

**⑦ partial-delivery 的持久载体 = `PipelineInfo`**（B-D、Ma-6、mi-1）

在 `PipelineInfo` 增加结构化字段，并在 `RequestContext` 增加专用 `ctx.record*` 方法；照抄既有同形路径 `maxTokensContinuation` ← `ctx.recordMaxTokensTruncation`（`context/types.ts:524`），保持独立槽位，不能被既有 `setPipelineInfo` 全量替换覆盖。否决 `warningMessages`：它是自由文本告警，无法按 operation／cause 聚合查询；性质 7 要的是结构化证据，不是提示。

持久 detail 冻结为：

```ts
readonly wirePartialDelivery?: Readonly<{
  operation: OwnerOperation
  cause: "client-gone" | "wire-error"
  committed: true
}>
```

记录点下沉到 owner 的 commit-aware catch，并同时覆盖 returned `client-gone`（`committed:true`）与 thrown `DeliveryOwnerError` 的非 client post-commit 撕裂；翻译层不记录。`CreateDownstreamDeliverySessionOptions` 增加窄 recorder callback，由 `makeAnchoredSseSink` 的 composition root 接到 `ctx.record*`，owner 不 import context concrete implementation。每次 owner operation 的一次 post-commit failure 只在产生点记录一次，从机制上消除原来“classifier 只调用一次”的拓扑约定。记录必须发生在 pump settle 前，且 `PipelineInfo` round-trip／History oracle 要在请求 settle 后读回完整 detail。

`FeatureKind` 可并存新增 `wire-partial-delivery`，用于 WS／TUI 的实时可见性；但它不算持久载体，不能替代 `PipelineInfo`。（richest-data-flow）

**⑧ 冻结 `OwnerOperation` 值域**（Ma-5、n-1）

```ts
export type OwnerOperation =
  | "allocate-anchor"
  | "allocate-real-block"
  | "begin-leg"
  | "close-anchor-before-real"
  | "close-anchor-terminal"
  | "write-block-frame"
```

公共 classifier 签名、owner 的 partial-delivery 记录与持久 detail 只接受该 union，不接受任意 string。用 `satisfies Readonly<Record<OwnerOperation, ...>>` 或等价穷尽映射测试，保证新增 owner API 或 operation 时编译／测试转红。⑧ 唯一留给实施者的是 handler helper 在 `handler-v4.ts` 内的摆放位置。

**验收分层，别把造不出来写成已覆盖**（M-5）：

- **类型／翻译层 unit**：加第四个 reason 必须编译失败；六格 disposition 全部有 oracle。两个非法 true 组合做 producer + translator 两腿类型级负测，并配合法组合正样本。unit 只证分类和类型，不证站点接线、wire、snapshot 或 settle。
- **真实 HTTP 入口**：能从真实入口造出的 `client-gone × true` 与其后续 preflight `client-gone × false` 必须走真 handler／driver 接线，断言零追加字节、settle 恰好一次、终态 aborted、forwarded snapshot 与 `PipelineInfo` 持久 detail 可从 History 读回。所有正常可达的 terminal／close-before-real 站点回归也走真实入口。
- **owner 层 oracle**：`session-terminating × false` 与 `wire-torn × false` 在当前真实 HTTP 入口造不出来，使用真实 delivery session + 可控 sink 直接驱动；前者断 loud／already-settled 分类，后者断“不再分配但终局普通写仍可完成”。**这一层证不到站点接线**，必须在测试名与计划记录里明确写出该限制，绝不把它记成 HTTP 覆盖。
- **持久性独立 oracle**：returned client-gone 与 thrown wire-error 两条 post-commit 腿都必须在 settle 后从 History 读回 `{ operation, cause, committed:true }`；不能只断实时 FeatureKind。

**M1 新增 exactly-once 组合 oracle**（B-B，第二轮修正）：同一个 anchor 的两个 owner 关闭者依次调用，第二个必须得到 `{ok:true,value:"none"}`，wire 上只有一个 `stop@0`。再加 mutation control：把 13 个关闭者中任意一处改回 legacy stop 写出，该 oracle 必须转红，证明它会咬住“漏迁一处”。原表述“legacy 关过后 owner 再关应得 `none`”是照着采纳 (c) **之前**的问题陈述写 oracle；在 (c) 落地后正确实现里已不存在 legacy 关闭者，而且 legacy 关闭从不清 `openAnchorIndex`，故该旧 oracle 只会逼实现者复活已否决的修法 (b)，必须废弃。现存 `anchor-multiblock-lifecycle.it.test.ts:494` 的 legacy↔legacy 两次关闭也不能冒充本 oracle。

**M1 新增 wire-torn 后关闭 oracle**（用户裁决）：先让非 client post-commit 撕裂置 `wireTorn`，再驱动终局关闭；`closeOpenAnchor` 必须仍写出 `stop@0`，随后站点写 error，客户端观测为“闭合的 `block@0` + error”。mutation control：让 `closeOpenAnchor` 也在 `wireTorn` preflight 返回拒绝，该 oracle 必须因缺 stop／块未闭合而转红。

**原子迁移红线按 anchor 定义**（B-B、建议 2）：同一个 anchor 的所有关闭者不得跨 legacy / owner 两套机制并存；不同站点也可能关闭同一个 anchor，故不能按“单站点内不双写”放行。M1 必须在同一个 commit 内迁完 13 个关闭者，删除所有 legacy anchor-stop 写出，接 owner close，并加入 owner→owner 组合 exactly-once oracle及“任一关闭者改回 legacy 即转红”的 mutation control；不得先接部分 owner close、让其余关闭者继续 legacy 写 stop。`openAnchorIndex` 只写不读的 P2 地基在该原子 commit 后成为唯一关闭权威。

| owner 操作 | `openAnchorIndex` | `anchorBlockOpen` | `anchorClosed` | `injected` |
|---|---|---|---|---|
| 初始（generation 开始） | `undefined` | `false` | `false` | `false` |
| `allocateAndWriteAnchor` **成功**（pre-content 或 gap） | `= 分配的 index` | `true` | **`false`**（重新武装——旧语义是一次性，多 anchor 下每次开新 anchor 都要复位） | `true` |
| `allocateAndWriteAnchor` **preflight 拒绝**：`ownerUnavailable()` 早返回 `{ok:false,reason:"client-gone"｜"session-terminating"｜"wire-torn",committed:false}`（`session.ts:289-292,340-341`——`finishReason` 可为 `client-gone`，**三种都要处理**） | 不变 | 不变 | 不变 | 不变 |
| `allocateAndWriteAnchor` **build callback 抛错**：`reservation.rollback()` 后**原样重抛**（`session.ts:345-349`，**不是 OwnerResult**——接线错误不进 failure union） | 不变 | 不变 | 不变 | 不变 |
| `allocateAndWriteAnchor` **post-commit 写失败**（⚠️ 右侧 legacy 字段经 ③ 裁决的 `legacyAnchorMirror` 供给：owner 只写 `anchorClosed`，`anchorBlockOpen` 由 injector wrapper 在入队前同步发布） | **`= reservation.value`（例如 `0`），不是 `undefined`**（`session.ts:351-352`：commit 回调在首帧写出前置位，post-commit 失败不回退——**该 anchor 仍可关**） | `true`（历史 shift 已产生，**不得回退**） | **`false`**（2026-08-02 第十三轮更正：`anchorClosed` 的语义是「`stop@0` 是否已发出」（`types.ts:536`），而 `committed` 只表示**首次 write 已尝试**——post-commit 失败时 stop **并未发出**，置 `true` 是伪语义、且会把它当 poison bit 用） | `true` |
| `closeOpenAnchor` 成功关闭，返回 `{ok:true,value:"closed"}`（2026-08-02 补正：不是裸 `"closed"`；调用方须 narrow 后取 `.value`，否则会静默丢掉 failure result） | `undefined` | **`true`**（**关键**：它表示「历史上保留过 wire shift」，**关闭后仍为 true**——这正是 bridge 等价性依赖的那一位） | `true` | 不变 |
| `closeOpenAnchor` 无 open anchor，返回 `{ok:true,value:"none"}`（2026-08-02 补正，同上） | `undefined`（本就是） | 不变 | 不变 | 不变 |
| `closeOpenAnchor` **client-gone**：返回 `{ok:false,reason:"client-gone",**committed:true**}`（2026-08-02 复核 `session.ts:411-413` 实测：**`committed` 为 true**，且 `openAnchorIndex` **不被清空**——清空只发生在成功路径 `:407`） | **不变**（仍指向未关的 anchor） | 不变 | 不变 | 不变 |
| `closeOpenAnchor` **非 client 写失败**：置 `wireTorn` 并 **throw `DeliveryOwnerError`**（`session.ts:415`） | 不变 | 不变 | 不变 | 不变 |
| `closeOpenAnchor` **preflight**：`client-gone` / `session-terminating` 返回 `{ok:false,...,committed:false}`；`wireTorn` **不拒绝**，继续关闭既有 `openAnchorIndex`（通用 `ownerUnavailable()` 须拆出 close 专用判据） | client/session 拒绝时不变；wire-torn 后关闭 成功时变 `undefined` | client/session 拒绝时不变；wire-torn 后关闭 成功后仍 `true` | client/session 拒绝时不变；wire-torn 后关闭 成功后 `true` | 不变 |
| `withAllocatedRealBlock` / `beginLeg`（任何结果） | 不变 | 不变 | 不变 | 不变 |
| `writeBlockFrame`（任何结果） | 不变 | 不变 | 不变 | 不变 |

**三条承重解读**（写出来防实施期误解）：

- **`anchorBlockOpen` 在 close 后保持 `true`**——它的旧语义就是「index 0 已被保留」（`types.ts:536-538` 原注释：*stays TRUE for the whole stream once set*），**不是**「当前有 open block」。若 close 时把它置 false，S2/S3 的旧门会在 pre-content anchor 关闭后突然算 `+0`，与 bridge 的 `+1` 分岔——**这正是「anchor 已关闭但历史 shift 仍为 1」那个窗口**。
- **`anchorClosed` 每次开新 anchor 时复位 `false`**：旧代码用它做一次性守卫，多 anchor 下必须每轮重新武装，否则第二个 anchor 的 close 被短路（这正是 round-3 blocker 的成因）。M1–M4 期间生产只开 ≤1 anchor，故该复位在生产上不可观测，但**测试经 owner API 落第二个 anchor 时会走到**，必须正确。
- **post-commit 失败不回退 `anchorBlockOpen`**：与 C9 档 ② 一致——字节已出，历史 shift 是既成事实。

- [ ] **守卫（B-B / Ma-1 / T-B）**：`legacy 字段 allowlist 写者`按“调查结论”④ 两阶段收缩——M1 后只允许 owner + injector 开侧，M5 后归零；live-reconcile 自 M1 起不得读写 `anchorClosed`。按具名函数／AST owner 判定，临时在 driver 加赋值必须转红。另有 anchor-stop 写出守卫：M1 后 owner 外零生产写点。
- [ ] **转移表 oracle**：逐行驱动 owner 操作，断言四个状态的取值与上表**逐格相同**（含两种失败路径）。这是 bridge 等价性的直接支撑，不能只靠 O-6 间接证明。

> **为何不选「M1+M2–M4 合成一个原子 commit」**（reviewer 给的另一条路）：那会把三腿迁移 + 状态机 + 8 站点 close 迁移压进单个 commit，diff 巨大且**失去逐腿 mutation 的可归因性**（6 格矩阵要能指出是哪一腿漏了）。bridge 方案保住每步可编译 + 每步门可满足 + 逐腿可归因，代价只是一段生命周期明确、有守卫、M4 即清零的迁移期代码。

### M1 的逐站点 close 迁移（**round-4 blocker：owner close API 缺失 + 站点迁移无具名步骤**）

reviewer 核实（planner 复核确认）：**所有 close 调用点都在 sink 构造之后**——两条 stream 路径都先 `makeAnchoredSseSink`，随后闭包/pump 内才调用。故 port 可达性**不是问题**（我上轮的担忧未坐实），真正缺的是 owner 的 close API（已在 P2 冻结 `closeOpenAnchor`）与逐站点迁移步骤。

> **站点编号、真实位置与两条归属轴只在“调查结论”① 维护；本表不再编号，避免进度记录指向两套编号。下表只补充迁移手法。**（建议 1）

| 站点组 | 现状 | M1 改法 |
|---|---|---|
| handler 8 个终局分支 | 共享 `closeAnchorIfOpen`；各分支 settle 参数不同 | 经 delivery session 调 `closeOpenAnchor(buildStop, "terminal")`；逐分支接入 ⑤ 的 pump 侧 helper，不合并前置条件 |
| driver 2 个终局分支 | driver 私有 `closeAnchorIfOpen`，且 `sink.close?.()` 无条件执行 | driver 直接持 port 调 `closeOpenAnchor(_, "terminal")`；显式保留无条件 `sink.close?.()`（M-3） |
| driver flush + retreat live 写穿两处 | close-before-real 直接写 legacy stop | M1 改调 `closeOpenAnchor(_, "before-real")`；M2/M3 才迁各自的分配 + remap |
| live-reconcile | 纯函数决定是否 close，装饰器把 `frames[0]` 直接交 `inner.writeAnchor` | M1 删除 live 层对 `anchorClosed` 的读写；装饰器对触发帧无条件请求 owner close，从 raw `inner` 取 port，stop index 取 owner `openAnchorIndex`，不得硬编码 `0` 或继续写 `frames[0]` |

**要点**：
- `"terminal"` 模式与 **P6 的永久 heartbeat stop 合成一个 owner command**——否则 stop 帧与新 tick 可能交错。
- **exactly-once 由 API 保证**：M1 已按 anchor 原子迁完 13 个关闭者；第二个 owner 调用者见 `openAnchorIndex === undefined` 得 `{ok:true,value:"none"}`。迁移站点必须 narrow `OwnerResult`，不得把 `{ok:false}` 当“已关过”。新增 owner→owner 组合 oracle与任一关闭者改回 legacy 即转红的 mutation control。
- **架构守卫**：生产代码**不得**在 owner 外读写 `openAnchorIndex` 或直接写 anchor stop 帧（带正样本对照）。

**若某 commit 的门实测不可满足**（例如 M2 的 offset≥2 场景仍拿不到红），**停下回报**——那意味着仍有未识别的依赖，**不得**靠手工补状态硬凑绿。

## 三腿的「分配 + remap」矩阵

原方案只枚举 remap、**漏了 allocate**（round-1 major）：`mapping` 只有在开块时被创建才能供后续 delta/stop 查，仅把硬编码 `1` 换成 resolver **不会自动创建 mapping**，S2/S3 会读到缺失或旧 mapping。故每条腿都必须具名回答三个问题：
| 腿 | start 帧谁分配？ | delta / stop 如何查 mapping？ | 如何保证同一块不重复分配？ |
|---|---|---|---|
| **S1** driver buffered flush（`driver.ts:1185`） | flush 循环内 `anchor.isContentBlockStart(frame)` 为真时经 owner API `withAllocatedRealBlock(upstreamIndex, …)` | 非 start 帧**经 owner `writeBlockFrame(leg, upstreamIndex, frame)`**（owner 内按**显式 leg** 查 mapping → remap → 写 → stop 成功后释放）；调用方不碰 registry、也不依赖 owner 记「当前腿」 | 一个 upstream 块只有一个 start 帧；重复分配会被 3.4 维度 B 的 mutation 咬住 |
| **S2** driver retreat（`driver.ts:1242`） | retreat 写穿循环内同样在 start 帧上调 owner API（**原 plan 漏此步**） | 同 S1（**retreat 不换 leg**，故 buffered 阶段登记的 mapping 照常可查 —— C10 ④） | 同 S1；retreat 前已 flush 的块**不得**再分配（buffer 已清空，结构上不会重入——**须有测试**） |
| **S3** live-reconcile（`live-reconcile.ts:141`） | 装饰器 `makeReconcilingSink` 经 `getDownstreamDeliverySession(inner)` 取 port，在**一个 transaction** 内完成「close-off stop + 分配 + remapped start」（见下方 S3 专节） | 同 S1 | live 腿逐帧透传，一个块一个 start |

### S3 专节（**round-2 major：原方案站不住，已重做**）

原方案写「`reconcileLiveFrame` 是纯函数 → 分配归装饰器」，方向对但**与冻结的 owner API 形状不兼容**。planner 复核了三条代码事实：

1. **port 可达**（reviewer 结论成立）：`makeDeliverySseSink` 返回 `delivery.clientSink`，`deliveryBySink` 正以它为 key（`session.ts:262`）；而 `makeReconcilingSink(inner, …)` 的 `inner` **就是**这个原 delivery sink（`handler-v4.ts:1206-1207`）。故装饰器可经 `getDownstreamDeliverySession(inner)` 拿到 session。**不需要**让 wrapped sink 再注册一次。
2. **M1 已先消除 legacy close 写出**：`reconcileLiveFrame` 自 M1 起不再返回 `[stopFrame, remapped]`，装饰器也不得再靠位置把 `frames[0]` 交给 `inner.writeAnchor`。它对触发帧无条件请求 owner close，从 raw `inner` 取得 port；owner 以自己的 `openAnchorIndex` 构造 stop。M4 的 provenance 问题只剩 real start 的信封铸造：调用方提供窄 `WireWriteSpec`，owner 补 sequence／clock／candidate provenance。
3. **拆成两次写会破坏原子性**：若装饰器先单独写 stop 再调 port 写 start，就是**两个 serializer operation**，heartbeat 可插进中间——正是 C5 要消灭的形状。（注：今天的装饰器确实是两次 `await`，但今天没有分配动作，所以只是顺序问题；引入分配后它就成了 TOCTOU。）

**API 形状**（P2「Interfaces」是权威定义，此处摘要其对 S3 的意义）：

```ts
withAllocatedRealBlock(
  upstreamIndex: number,
  build: (ctx: { mapping: WireBlockMapping; envelope: WireEnvelopeFactory }) => ReadonlyArray<WireWriteSpec>,
): Promise<OwnerResult<WireBlockMapping>>
```

> **2026-08-02 补正（P1+P2 落地后的实际契约，以 `src/lib/pipeline/types.ts` 与 README C9/C10 为准）**：返回类型不再是 `WireBlockMapping | undefined`，而是 `OwnerResult<WireBlockMapping> = {ok:true,value} | {ok:false,reason,committed}`，`reason ∈ {"client-gone","session-terminating","wire-torn"}`；接线错误（未配置 wireState、reservation 重入、无 active leg 写 real 帧、**missing mapping**）**照旧 throw、不进这个 union**。**非 start 帧不再由调用方自己 `resolveRemappedFrame` 后普通 write**，而是走 owner 的 `writeBlockFrame(leg, upstreamIndex, frame)`——leg 显式传入、查表与 remap 都在 owner 内（README C10）。下方各处旧措辞**已于同日逐处改写**，不再需要靠本段兜底。

**round-3 major 修正——callback 不返回 `DeliveryFrame`，返回 owner 定义的窄 write spec**：

planner 独立核实：`DeliveryFrame`（= `ClientFrameEnvelope`）必填 `sequence` / `observedAtMonotonic` / `provenance`（`frame-envelope.ts:22-26`）。`createClientFrameEnvelope` 虽是公开导出、**类型上**可构造，但真实构造逻辑 `makeEnvelope` / `asDeliveryFrame` 都是 `delivery/session.ts` **私有**（`:229-247`），且装饰器既没有 candidate/dispatch id，也不持有 delivery 的 `monotonicNow`。若让装饰器自填 `sequence: 0` / `candidateId: "legacy"`，虽能跑通，却把 **provenance 与序号的铸造责任放错层**，违反 richest-data-flow（owner 才拥有时钟与信封路由）。

故 callback 只提供**内容 + 语义分类**，信封由 owner 铸造：

```ts
/** What the caller wants written; the owner mints the envelope (sequence / clock / provenance). */
export type WireWriteSpec =
  | { readonly kind: "real"; readonly frame: ClientFrame }
  | { readonly kind: "anchor"; readonly frame: ClientFrame }        // synthetic close-off / open
  | { readonly kind: "keepalive"; readonly frame: ClientFrame }

/** Optional sugar handed to the callback so call sites read declaratively. */
export interface WireEnvelopeFactory {
  real(frame: ClientFrame): WireWriteSpec
  anchor(frame: ClientFrame): WireWriteSpec
  keepalive(frame: ClientFrame): WireWriteSpec
}
```

owner 按 `kind` 路由到既有的 `write` / `writeAnchor` / `writeKeepalive`（`session.ts:257-278` 的 `writeToSink` 已是这个形状），**并在内部补齐 `sequence`、`observedAtMonotonic`、`provenance`**。于是：

- S1/S2 的 callback 返回 `[envelope.real(remappedStart)]`；
- S3 返回 `[envelope.anchor(stopFrame), envelope.real(remappedStart)]`——**一个 transaction、正确 marker、不靠数组位置猜**；
- gap injector（M6）返回 `[envelope.anchor(start), envelope.keepalive(delta)]`。

**三腿与 injector 共用同一 owner API，无特例分支。** 装饰器不再伪造任何 metadata。

> **S3 已无「拿不到就停」的退路**：port 可达性与信封铸造责任都已定型，S3 是冻结必做范围。

## 三个站点（master 精确行号）

| # | 站点 | 当前代码 | 触发条件 |
|---|---|---|---|
| S1 | driver buffered flush | `driver.ts:1185` `let outFrame = injected && anchor && anchorBlockOpen ? anchor.remap(frame, 1) : frame` | 每次 boundary/terminal flush 的每一帧 |
| S2 | driver retreat 分支 | `driver.ts:1242` `await sink.write(anchorState.injected && anchor && anchorState.anchorBlockOpen ? anchor.remap(toWrite, 1) : toWrite)` | buffer cap 超限后的 live 写穿 |
| S3 | live-reconcile | `live-reconcile.ts:141` `out.push(hooks.remap(frame, 1))` | live 路径（非 buffered）的每一真实帧 |

三处都是硬编码 `1`。C4：这个 `1` 与 `continuationOffset` 两个独立偏移都要被 frontier 取代（continuation 侧在 P4）。

## Files

- Modify: `src/lib/pipeline/driver.ts`（S1 + S2）
- Modify: `src/lib/anthropic/live-reconcile.ts`（S3）
- Modify: `src/lib/pipeline/types.ts`（2026-08-02 补正：**`ReconcileHooks` 不需要携 allocator**——分配与 remap 都在 owner 内，装饰器只经 port 调 `withAllocatedRealBlock` / `writeBlockFrame`）
- Test: 改写 `tests/pipeline/retreat-anchor-collision.it.test.ts`、`tests/pipeline/live-reconcile-collision.it.test.ts`、`tests/pipeline/anchor-multiblock-lifecycle.it.test.ts` 的 index 断言；新 `tests/pipeline/remap-sites-mutation.it.test.ts`

---

## Task 3.1：S1 driver buffered flush（分配 + remap）

> **测试纪律（两轮 review 综合）**：被测动作 = **真实块的分配 + remap**，必须 100% 由生产路径完成——**禁止**手工推进 allocator（那会让测试准备替实现干活，生产漏分配照样绿）。但 anchor 这个**前置 wire 状态**由测试经 **P2 的生产 owner API** `allocateAndWriteAnchor` 落下（理由与防假绿论证见本文件头部「round-2 blocker」小节）——**不是**等 heartbeat，因为 gap anchor 要到 P5 才开放，等它会造成红绿门不可满足。

- [ ] **Step 1: 写失败测试** —— offset >= 2 的场景，真实块全由生产路径分配 + remap

```ts
// tests/pipeline/remap-sites-mutation.it.test.ts
test("S1 buffered flush allocates and remaps real blocks itself at frontier offset >= 2", async () => {
  // 前置（测试经生产 owner API 落 anchor，不碰 allocator 内部）：
  //   await port.allocateAndWriteAnchor(...)         → anchor@0
  //   驱动上游真实块（上游 index 0）                  → 生产分配 wire@1
  //   await port.allocateAndWriteAnchor(...)         → anchor@2
  //   驱动上游真实块（上游 index 1）                  → 生产分配 wire@3   ← offset 2
  assertMonotonicWireIndices(frames)   // 硬编码 +1 会让第二块落已被占用的 wire@2 → 红
  assertBlockProtocolState(frames)
  // 前置断言：两个 anchor 确实在 wire 上（证明场景真的建立起来了）
})
```

- [ ] **Step 2**：跑，红。
- [ ] **Step 3**：实现——start 帧经 owner API `withAllocatedRealBlock`（返回 `OwnerResult<WireBlockMapping>`，须 narrow 后取 `.value`）；**非 start 帧走 owner 的 `writeBlockFrame(leg, upstreamIndex, frame)`**，leg 显式传入、查表与 remap 都在 owner 内（2026-08-02 补正：旧文写「走 `resolveRemappedFrame`」是 P1 期的形状）。
- [ ] **Step 4**：跑，绿；`anchor-multiblock-lifecycle.it.test.ts` 预期仍绿（pre-content-only 场景 offset 仍是 1）。
- [ ] **Step 5: 提交** → `refactor(driver): allocate and remap buffered-flush blocks via the frontier owner`

## Task 3.2：S2 driver retreat 分支（分配 + remap）

> retreat 是「buffer cap 超限 → 放弃缓冲 → 剩余帧 live 写穿」。它的 anchor 语义已由 `retreat-anchor-collision.it.test.ts` 锁住（避免双 message_start + index 撞车）。

- [ ] **Step 1: 写失败测试**：retreat 发生在 **gap anchor 已开过一次之后**，断言写穿的真实块 index 走 frontier；**并断言 retreat 前已 flush 的块没有被二次分配**（frontier 无跳号）。
- [ ] **Step 2**：跑，红。
- [ ] **Step 3**：实现——start 帧经 owner API 分配（**原 plan 漏此步**）；其余帧走 **`writeBlockFrame(leg, upstreamIndex, frame)`**（2026-08-02 补正，同 M2）。
- [ ] **Step 4**：跑，绿 + `retreat-anchor-collision.it.test.ts` 回归。若该文件的断言写死了 `+1`，**改写为 frontier 断言（非删除）**。
- [ ] **Step 5: 提交** → `refactor(driver): allocate and remap retreat write-through blocks via the frontier owner`

## Task 3.3：S3 live-reconcile（设计正文漏、审查补）

> **为什么 live 腿仍要接**：块级 buffered 是既定终态，但 ① 迁移期 live 仍是当前生产默认（`protectStreamingGeneration: false`）；② retreat 之后的续流走 live 写穿；③ 留一个算 `+1` 的站点就是 C4 的反例，未来必然被误读。项目「无向后兼容负担 / 不留双轨包袱」。

- [ ] **Step 1: 写失败测试**（**用生产 delivery sink，非 raw sink**）：live 路径下 offset >= 2 的场景（anchor 经 owner API 落，真实块由生产路径分配 + remap），断言：
  - `assertMonotonicWireIndices` + `assertBlockProtocolState`（delta/stop 必须落在同一 wire index，orphan delta 会被咬住）；
  - **close-off stop 带 `synthetic:"anchor"` 标记**，remapped start **不带**标记（C7）；stop index 来自 owner 的 open anchor，不是硬编码 `0`；
  - port 从 raw `inner` 取得，对 wrapper sink 查 session 的 mutation 必须转红；
  - close-off 与 real start **在同一个 serializer transaction 内**——用一个在两帧之间尝试插入 keepalive 的探针证明它插不进去；
  - 无 open anchor 时，每个触发帧仍经 serializer 得到 `"none"`，O-6 证明这项有意接受的 per-frame 开销不改变 wire。
- [ ] **Step 2**：跑，红。
- [ ] **Step 3**：实现——
  - **取 port**：装饰器经 `getDownstreamDeliverySession(inner)` 拿 session 的 allocation port。`inner` 就是原 delivery sink（`handler-v4.ts:1206-1207` → `makeDeliverySseSink` 返回的 `delivery.clientSink`，正是 `deliveryBySink` 的 key，`session.ts:262`），故可达。
  - **一个 transaction 出两帧**：M1 已把 close-before-real 的权威迁入 owner；M4 在此基础上把它与 real allocation/write 融成一个 serializer transaction。装饰器见到真实 `content_block_start` 时调 `withAllocatedRealBlock(upstreamIndex, ({ mapping, envelope }) => [...])`；需要 close-off 时由同一 owner transaction 执行等价于 `closeOpenAnchor(_, "before-real")` 的关闭步骤，再写 remapped start。callback 返回 owner 定义的窄 `WireWriteSpec`，不是 `DeliveryFrame`；信封由 owner 铸造，owner 按 `spec.kind` 路由，不靠数组位置猜，也不由装饰器自填 provenance。不得把本步骤误读为“M4 才把 live close 写出迁进 owner”。
  - **`reconcileLiveFrame` 保持纯函数**：它继续负责「要不要 close-off」的判定，**但 remap 不再由它做**——**start 帧**用 owner transaction callback 里拿到的 reservation `mapping` 做 remap，**非 start 帧**走 `writeBlockFrame(leg, upstreamIndex, frame)` 由 owner 查表并 remap（2026-08-02 补正：此前笼统写成「都在 `writeBlockFrame` 内」不准确）；**副作用（分配 + 写）全在装饰器的 transaction 内**。
  - **非 start 帧**（delta/stop/终止符）走 owner 的 `writeBlockFrame(leg, upstreamIndex, frame)`，**不再由装饰器自己 remap 后普通 write**（2026-08-02 补正）。
- [ ] **Step 4**：跑，绿 + `live-reconcile-collision.it.test.ts` / `live-post-commit-anchor-closeoff.http.test.ts` 回归（结构断言按需改写）。
- [ ] **Step 5**：mutation——把两帧拆成两次独立写（今天的形状），确认「transaction 内不可插入」的断言转红。
- [ ] **Step 6: 提交** → `refactor(live-reconcile): allocate, close off and remap live blocks in one wire transaction`

## Task 3.4：退役 P1 的桥接断言 + **双维** mutation 矩阵

- [ ] **Step 1**：把 P1 的 `anchor-allocator-bridge.it.test.ts` 从「offset 恒等于固定 1」改写为「offset 等于 frontier 记账值」（**改写非删除**，它现在锁的是 C4）。
- [ ] **Step 2**：建 **6 格** mutation 矩阵——三条腿 × 两个维度（plan review major：只 mutate remap 不足以证明分配已接线）：
  - **维度 A（remap）**：把该站点交给 owner 的 `writeBlockFrame` 改回**调用方自算**的硬编码 `anchor.remap(frame, 1)`（S3 是装饰器自算，S1/S2 是 driver 自算）（2026-08-02 补正：mutation 的对照形状随契约一起变了）。
  - **维度 B（allocate）**：**删除**该站点的 `withAllocatedRealBlock` 调用（保留 remap）。这一维专门咬「mapping 从未被创建」的漏接线——原 plan 完全没有它。
  - 每格逐一确认**至少一条测试转红**，并记录是哪条。某格不打红 → 该维度无覆盖，补测试，不得跳过（`plan 红绿预测可能错、执行期真跑验证`）。
- [ ] **Step 3**：把矩阵结果写进本文件下方表。
- [ ] **提交** → `test(anchor): 6-cell mutation matrix over allocation and remap on all three legs`

## Task 3.5：golden 重捕

- [ ] **Step 1**：先跑 O-1/O-2 确认新 wire 结构正确（**顺序不可颠倒**——先证结构对，再改 golden）。
- [ ] **Step 2**：重捕 `tests/pipeline/buffered-anchor-golden.it.test.ts` 与受影响的 `c0-live-anchored-direct-stream-golden.http.test.ts`。
  - **预期**：pre-content-only 场景**不应有字节变化**（allocator 在该场景算出的 offset 就是 1）。**若这两个 golden 意外变红，那是回归信号而非预期重捕**——停下查根因，不要重捕。
- [ ] **Step 3**：重捕（如确有预期变化）单独一个 commit，与实现 commit 分离，让 diff 可审。
- [ ] **提交** → `test(anchor): re-capture goldens for the frontier wire`（仅在确有预期变化时）

## mutation 矩阵（实施期填写；**6 格**）

| 站点 | 维度 A：remap 改回硬编码 `1` | 维度 B：删除 allocate 调用 |
|---|---|---|
| S1 driver flush | _待填：转红的测试_ | _待填_ |
| S2 driver retreat | _待填_ | _待填_ |
| S3 live-reconcile | _待填_ | _待填_ |

## M2–M4 收口（三腿迁移；相位总收口见下）

- [ ] `typecheck` + `test:fast` 绿；anchor 全套件与基线对账（每处差异归因为「预期改写」或「回归已修」）。
- [ ] O-1/O-2 绿；O-6 字节等价**仍等于 P0 捕获的 base 基线**（本相位对无-anchor **主腿**请求应零字节变化）。
- [ ] `rg -n "remap\(.*, 1\)" src/` 零命中。
- [ ] **6 格 mutation 矩阵填满**，无空格（空格 = 该维度无覆盖）。

## P3M 相位总收口

- [ ] M1–M8 **八个 commit 全部落地**，每个终态 typecheck + `test:fast` 绿，且其「可满足的门」实测通过（非推理认定）。
- [ ] O-1 / O-2 / O-3 / O-6 / O-9 绿。
- [ ] **零残留 grep 全绿**：`remap\(.*, 1\)` / `continuationOffset` / `wireDeliveredBlocks` / `anchorBlockOpen` / `anchorClosed` / **迁移期 bridge 判据**（`anchorsOpened\(\) > 0`）在 `src/` 均零命中。
- [ ] **close 权威唯一**：生产代码在 owner 外无任何 anchor stop 写出、无 `openAnchorIndex` 读写（架构守卫 + 正样本对照）。
- [ ] **mapping registry 唯一访问者**：owner 外无任何 mapping 读写；三腿的非-start 帧全部经 `writeBlockFrame`（架构守卫 + 正样本对照）。
- [ ] **provenance 真实**：History generation 轨中 **primary / recovery / continuation** 三腿的真实块各带真实 candidateId/dispatchId（主腿 ≠ 续写腿），`"legacy"` 仅出现在既有兼容 helper 一处；无活跃 leg 时分配/写块被拒绝。
- [ ] **跨腿 mapping 隔离**：`writeBlockFrame` 按**显式 leg** 解析；改回 ambient 当前腿的 mutation 必须转红。
- [ ] **legacy 字段 allowlist 写者**：M1 后只允许 owner + injector 开侧，live-reconcile 零 `anchorClosed` 读写；M5 后归零。转移表逐格 oracle 绿，owner 外 anchor-stop 生产写点自 M1 起归零。
- [ ] 6 格 mutation 矩阵 + 交叉 mutation 矩阵**填满无空格**。
- [ ] anchor 全套件与 P0 基线对账完毕（每处差异归因为「预期改写」或「回归已修」）。
- [ ] **硬序约束已遵守**：M6 的开门 commit 晚于 M2–M4。

