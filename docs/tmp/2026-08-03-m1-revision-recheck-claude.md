# M1 修订稿复核（未卷入的第三方，Claude）

- 日期：2026-08-03
- 被审对象：`docs/plan/2026-07-27-inter-block-anchor-allocator/plan-3-remap-sites.md` 修订后的「M1 调查结论」①–⑧ 及被波及段落
- 任务：对上一轮 claude 评审 18 条发现逐条裁决「已解决 / 未解决 / 部分解决」，附改后 file:line
- 裁判轴：长远正确 + 完整；架构健康 > 回归风险。不采用 ROI/YAGNI。
- 工作树只读，未修改任何被审文件。

（正文分段追加中）

## 总体 verdict

**存在 blocker（1 个，全部是修复本身新引入的）。** 上一轮 18 条发现：**已解决 16 条、部分解决 2 条、未解决 0 条**。
但 B1 的修法 (c) 在落地时**新增了一条自相矛盾、按字面不可满足的门**（N-1），并在 M-6 的按-reason 短路上**引入一处未记录的客户端可见行为变化**（N-2）。

- 上一轮 18 条：blocker 3 全部已解决；major 8 中 7 条已解决、M-2 部分解决；minor 5 全部已解决；nit 2 全部已解决。
- 新发现：blocker 1、major 2、minor 4、nit 1。

## 双视角覆盖证据

### 机械核对（扫描 / 对账 / 查证）

- **全仓 anchor-stop 写出点穷尽扫描**（`rg 'writeAnchor|anchorClosed|closeAnchorIfOpen|closeAnchorBeforeReal|stopFrame'` 全 `src/`）：物理写点恰好 5 处——`keepalive-anchor.ts:263`、`driver.ts:1188`、`driver.ts:1242`、`driver.ts:1319`、`live-reconcile.ts:173`；13 个调用者全部落在这 5 处之内。**① 的 13 行清单穷尽为真，没有第 14 个**。
- **owner 侧行号逐条实测**：`closeOpenAnchor` 定义 `session.ts:394`、`openAnchorIndex === undefined → "none"` 在 `:399`、`mode === "terminal"` 才 `closeHeartbeat()` 在 `:400`、成功清空在 `:407`、client-gone 返回 `committed:true` 在 `:411-413`、非 client `throw DeliveryOwnerError` 在 `:415`。② 引用的 `session.ts:400` 精确命中。
- **serializer FIFO 主张查证**：`write()`（`session.ts:120-134`）与五个 owner 入口共用同一个 `createDeliverySerializer()`（`:97`），故 ② 的「关闭与相邻 real write 的排序由同一 serializer FIFO 保证」**成立**，且在 M1–M3（相邻 real write 仍走 legacy `sink.write`）也成立——因为 legacy write 也进同一队列。
- **`PipelineInfo` 持久性查证（B-D 的支撑事实）**：`recordMaxTokensTruncation` → `_maxTokensContinuationInfo`（`request.ts:1079-1082`）→ `mergedPipelineInfo()` 合并（`request.ts:331/339`）→ `HistoryEntryData.pipelineInfo`（`context/types.ts:344`）→ `PipelineInfo` 定义在 `history/types.ts:211-231`，并有既有消费者 `telemetry-dimensions.ts:154` 读 `entry.pipelineInfo?.maxTokensContinuation`。**⑦ 换载体后的支撑事实为真**，与上一轮 `recordFeature` 的假事实形成对照。
- **mint 守卫查证**：`tests/architecture/package-boundaries.unit.test.ts:590` describe、`:708` `MINT_HELPER = "streamErrorOutcome"`；⑤ 改名 `"fail-loud"` 确实绕开该 AST 判据。
- **driver 分类判据查证**：`OWNER_FAILURE_OUTCOME_FACTORIES`（`driver.ts:931-935`）+ `ownerFailureOutcome`（`:937-942`，`settled` 判据在 `:938-940`）；5 个调用点 `:878/1022/1109/1523/1581` 全部是 `if (!leg.ok) return ownerFailureOutcome(...)`，**确实不是 `beginLeg` 自身**（m-3 修正正确）。
- **C9 原文对账**：`README.md:58` 逐字含「禁止后续分配但不关闭 session，因此 terminal error / close / finalize 仍可完成」。
- **两侧不对称核对（M-3）**：`keepalive-anchor.ts:262` 的 `sink.close?.()` 在 `if` **内**（条件性）、`driver.ts:1182` 在 `if` **外**（无条件）——⑤ 第 213 行的表述逐字为真。
- **陈旧行号复核（m-2）**：`types.ts:536` 确为 `anchorBlockOpen ... stays TRUE` 注释，第 299 行已改对。

### 第一人称执行视角（模拟走查的流程 / 分支）

- **走查 A（B1 的 live 场景重放）**：injector 开 anchor（owner `openAnchorIndex=0`）→ `reconcileLiveFrame` 判定要关（`live-reconcile.ts:129-139`）→ **M1 后装饰器改调 owner close** → `openAnchorIndex` 被清 → 上游截断 → 站点 4（`handler-v4.ts:1553`）调 owner → `:399` 见 undefined → `"none"`、零帧。**双写不再发生**。
- **走查 B（B1 的 buffered 场景重放）**：站点 11（`driver.ts:1239-1244`）M1 后走 owner → 站点 10（`driver.ts:1609`）再 close 得 `"none"`。**双写不再发生**。前提是 13 处**同一 commit 原子迁完**，这一条已被第 280 行红线写死。
- **走查 C（新 oracle 的可满足性）**：按第 278 行字面构造——先 legacy 关一次（M1 后生产已无此路径，只能测试内直接 `sink.writeAnchor(stopFrame(0))`），再调 owner close。owner 只认 `openAnchorIndex`（`session.ts:399`），legacy 写不碰它 → owner 返回 `"closed"` 并写**第二个 `stop@0`**。→ **该 oracle 在正确实现下必红**，见 N-1。
- **走查 D（site 12 的 port 可达性）**：`makeReconcilingSink`（`live-reconcile.ts:163`）返回**新对象**，而 `getDownstreamDeliverySession` 走 `deliveryBySink` WeakMap（`session.ts:83-85`）→ **装饰后的 sink 查不到 owner**。装饰器内必须用 `inner`。⑤ 第 207 行又规定「无 owner 时 no-op」→ 传错 sink 会**静默不关 anchor**。见 N-4。
- **走查 E（wire-torn 臂的客户端可见结果）**：post-commit 瞬时非 client 撕裂置 `wireTorn` → 站点调 owner close → `ownerUnavailable()`（`session.ts:289-292`）返回 wire-torn → 按新性质 4 **跳过关闭、照常写 error 帧**（`write()` 不检查 `wireTorn`，只检查 `state`，故 error 帧**真的写得出去**）→ 客户端收到 **未闭合的 `content_block_start@0` + error**。今天 legacy `closeAnchorIfOpen` 不看 `wireTorn`、会补上 `stop@0`。**行为变了且未记录**，见 N-2。
- **走查 F（M-6 读法与 C9 是否自洽）**：`write()`（`session.ts:120-134`）只在 `state !== "open"` 时丢帧，**不看 `wireTorn`**；`writeSynthetic` 走同一条 `write()`。所以 C9 的「terminal error 仍可完成」在代码层是**成立的事实**，不只是措辞。**主会话的读法经代码验证为正确**。
- **走查 G（session-terminating 短路臂的自洽）**：分类给 `fail-loud`（`kind`），而短路与否按 `reason` 分（⑤ 第 206 行）→ `session-terminating` 走短路 + loud settle。此时 `state !== "open"`，`write()` 本就会丢帧，**短路与不短路在 wire 上等价**，短路更诚实。**无矛盾**。
- **走查 H（站点 1 的 `finally` 倒置）**：`writeTerminalThenSettle`（`handler-v4.ts:691-702`）今天就是 `finally { setForwardedResponse; settle }`（snapshot 先、settle 后）。⑤ 第 206 行已明令「必须移出 `finally` 辖域或让 `finally` 识别已 settle；不得依赖 `finally` 再次 settle，也不得形成 settle→snapshot」→ **M-2 的倒置已被堵住**。但同句给的统一形状里的 `recordForwarded()` 在站点 1 **不存在**（只定义于 `handler-v4.ts:1300` 与 `:1666` 两个 pump 内），见 N-5。
- **走查 I（⑦ 的接线可行性）**：`makeAnchoredSseSink`（`handler-v4.ts:1086-1100`）当前 args **不含 ctx**，但两个调用点 `:567`（`env.ctx`）与 `:650`（`commitCtx`/`codec.getContext()`）都够得到 ctx → 加一个窄 recorder 参数可行。**⑦ 的 composition root 主张成立**。

## 一、上一轮 18 条逐条裁决

| # | 原发现 | 裁决 | 改后 file:line 与证据 |
|---|---|---|---|
| **B1** | 站点 11/12/13 留 legacy → 双写 `stop@0` | **已解决**（但新增门有缺陷，见 N-1） | 修法 (c) 落在 `plan-3:123`（两条迁移轴）、`:125-139`（13 行清单）、`:143-152`（② 关闭权威裁决）、`:280`（红线按 anchor + 同一 commit 迁完 13 处 + 删除所有 legacy anchor-stop 写出）、`:51`（M1 行改成「13 个关闭者全部迁到 owner close」）。走查 A/B 证明两条失败场景在原子迁完后**确实不可达**；全仓扫描证明 5 个物理写点全在清单内、无遗漏 |
| **B2** | `kind:"stream-error"` 撞 mint 守卫 | **已解决** | `plan-3:190` 判别式改 `"fail-loud"`；`:199` 写明守卫按对象字面量扫描并给出 `package-boundaries.unit.test.ts:590-624`。核对 `:708 MINT_HELPER="streamErrorOutcome"`，`fail-loud` 不含被扫字面量 → `test:fast` 门可满足 |
| **B3** | `recordFeature` 不落 History，性质 7 未满足 | **已解决** | 载体改 `PipelineInfo`（`plan-3:239-255`）。持久链路实测成立（见机械核对第 4 条）；`:255` 保留 `FeatureKind` 只作实时可见性、明写「不算持久载体」，符合 richest-data-flow 双轨 |
| **M-1** | `closeAnchorViaOwner` 拿不到 ctx | **已解决** | `plan-3:196`（`classifyOwnerFailure(failure, operation, ctx)`）、`:205`（`closeAnchorViaOwner(sink, anchorHooks, anchorState, ctx, mode)`，ctx 允许 undefined）、`:202`（ctx 缺失 → 视为未 settle、loud，不静默吞） |
| **M-2** | 丢 settle 前 `recordForwarded()`；站点 1 被倒置 | **部分解决** | `plan-3:206` 已写死短路臂含 `recordForwarded()`、`delivery-finished` 仍 `recordForwarded()`、站点 1 必须移出 `finally` 辖域。**残留**：统一形状里的 `recordForwarded()` 在站点 1 作用域不存在（N-5），plan 未点名站点 1 的等价物是 `ctx?.setForwardedResponse({sseEvents:[...forwardedSseEvents]})`（`handler-v4.ts:700`） |
| **M-3** | driver 无条件 `sink.close?.()` 退化 | **已解决** | `plan-3:213`（站点 9/10 显式保留无条件 `sink.close?.()`，并写出两侧不对称）+ `:317`（逐站点表同款）。两侧不对称经实测逐字为真 |
| **M-4** | 转移表前言「owner 唯一写者」为假 | **已解决** | `plan-3:96` 已改成写者分工表述并交叉引用 ④；`injected` 一列明确归 injector。④ 在 `:169-177` |
| **M-5** | 4 条真实 HTTP oracle 至少 1 条造不出 | **已解决** | `plan-3:271-276` 三层验收：unit / 真实 HTTP（`client-gone` 两格）/ owner 层（`session-terminating×false`、`wire-torn×false`），并明写「这一层证不到站点接线，必须在测试名与计划记录里写出该限制，绝不记成 HTTP 覆盖」 |
| **M-6** | wire-torn 短路致零终止符，与 C9 张力 | **已解决** | `plan-3:109`（性质 4 改成按 reason 分）、`:203`（显式留痕 + 可被用户否决）、`:206`（wire-torn 不走短路臂）。**读法经代码验证正确**（走查 F）。但该读法的代价未记录，见 N-2 |
| **M-7** | 未定义 `DeliveryOwnerError` 处置 | **已解决** | `plan-3:209-214` 逐站点写明（1–4/6–7、5/8、9/10、11/12/13 四组）。残留一处内部矛盾见 N-6 |
| **M-8** | 8 站点 settle 语义差异未被吸收 | **已解决** | `plan-3:205` 明列 `model` 三来源、`partial` 不同构造来源、可选 `upstreamSucceeded`（站点 3）、站点原始 `cause`、站点 1 自定义 settle 闭包，并裁决「owner failure error 是终态错误，站点原始诊断保留为 `cause`」——上一轮要求的「二选一但必须选」已选 |
| **m-1** | O-6 被给了它证不到的信用 | **已解决** | `plan-3:51` 门内已写「O-6 只证无-anchor 主腿；有-anchor 零变化由站点回归与 exactly-once oracle 证明（m-1）」 |
| **m-2** | `types.ts:444` 陈旧行号 | **已解决** | `plan-3:299` 已改 `types.ts:536-538`，与实测一致 |
| **m-3** | 「5 个 `beginLeg` 调用点」两件事说成一件 | **已解决** | `plan-3:204` 改成「`ownerFailureOutcome` 的 5 个调用点…它们恰好都位于 `beginLeg` 失败分支，不是修改 `beginLeg` 自身」，与实测一致 |
| **m-4** | `delivery-finished` 写「不动」 | **已解决** | `plan-3:206`「`delivery-finished` 不再 settle，但仍先 `recordForwarded()` 再 return」 |
| **m-5** | 转移表缺 `writeBlockFrame` 行 | **已解决** | `plan-3:295` 已补「`writeBlockFrame`（任何结果）→ 四列不变」 |
| **n-1** | `OwnerOperation` 值域未冻结 | **已解决** | `plan-3:257-269` 冻结六值。核对 owner 五个 API × close 两 mode = 恰好六个，**值域穷尽为真** |
| **n-2** | 「纯分类器」名不符实 | **已解决** | 记录副作用按 ⑦ 下沉 owner（`plan-3:253`），`:181` 明写「该模块是真正的纯分类器」 |

## 二、修复本身引入的新缺陷（只报这一类，未扩新议题）

### Blocker

**[blocker] N-1 — 「legacy 关过之后 owner 再关必须得 `none`」这条新门，在修法 (c) 下按字面不可满足；照它做只会把实施者推回已被否决的修法 (b)**

- **plan 位置**：`plan-3-remap-sites.md:278`（「先经 legacy 关闭过同一个 anchor，再调用 owner close，owner 必须得到 `{ok:true,value:"none"}`，wire 上只有一个 `stop@0`」）+ `:51` 的 M1 门（「legacy→owner 组合 oracle（后关得 `"none"`、wire 仅一个 `stop@0`）」）。
- **机制性证明**：owner 判「是否已关」的**唯一**依据是 `openAnchorIndex`（`session.ts:399`），而它只在 owner 自己成功关闭时被清（`:407`）。任何 legacy 关闭（无论生产的还是测试手搓的 `sink.writeAnchor(stopFrame(0))`）**都不碰 `openAnchorIndex`**。故在一个**正确**的 M1 实现上，该 oracle 必然拿到 `"closed"` 并观测到**两个** `stop@0` → **测试红**。
- **两条读法都坏**：
  1. 字面读（真 legacy 关闭）→ 门不可满足。而 plan 自己的规矩是「若某 commit 的门实测不可满足…停下回报——不得靠手工补状态硬凑绿」，实施者要么卡死，要么去让 legacy 关闭同步清 `openAnchorIndex`——**那正是 ② 第 147 行明文否决的修法 (b)**（违反「生产代码不得在 owner 外读写 `openAnchorIndex`」）。这条门因此不是中性的，它**主动把人推向被否决的方案**。
  2. 宽容读（「经 legacy *判定* 路径但由 owner 写出」，即 M1 后 live-reconcile 的形态）→ 那就是 owner↔owner，与门里已有的「close 幂等」完全重合，**对 B1 这一类回归零鉴别力**。
- **根因**：这条 oracle 是修法 (a)/(b) 家族的遗留物——只有在「legacy 与 owner 并存」时它才有意义；采纳 (c)（并存被消灭）之后它失去了论域。处置表把「评审给的 oracle」和「评审给的修法」分别采纳，但没有检查两者是否还相容。
- **修复方向**（必须改，不是可选）：把它换成 M1 后**真实可达**且真咬得住 B1 回归类的组合——**同一个 anchor 的两个不同关闭者依次调用 owner**，例如「live-reconcile 的 close-before-real 关掉 anchor（站点 12）→ 上游截断 → 终局站点（站点 4 / 站点 10）再关」，断言：第二次得 `{ok:true,value:"none"}`、wire 上恰好一个 `stop@0`、且该 oracle 走**真实 HTTP 入口**。再补一条 mutation control：把任一关闭者改回直接 `sink.writeAnchor(stopFrame(0))`（即模拟「漏迁一处」），该 oracle **必须转红**——这才是它要防的那个错误实现，也正好把上一轮「现存套件没覆盖这个组合」的缺口补上（`anchor-multiblock-lifecycle.it.test.ts:494` 的两次关闭仍是 legacy↔legacy，确认为真）。

### Major

**[major] N-2 — wire-torn 不短路的代价（anchor 永不关闭 → 客户端收到未闭合 `content_block_start@0` + error）未被记录，且与 M1 自己的「行为等价」不变量冲突**

- **证据链**：① 新性质 4（`plan-3:109`）规定 wire-torn「跳过 anchor 关闭，但照常写本站点自己的终局错误帧」；② owner 的 `closeOpenAnchor` 在 `wireTorn` 时于 `session.ts:290` 直接返回失败，**永远走不到写 stop**；③ 而终局 error 帧走 `sink.writeSynthetic` → `write()`（`session.ts:120-134`），该函数**不检查 `wireTorn`** → error 帧写得出去；④ 今天的 legacy `closeAnchorIfOpen`（`keepalive-anchor.ts:259-264`）同样不看 `wireTorn`，**会补上 `stop@0`**。
- **失败场景**：post-commit 一次瞬时非 client 写失败置 `wireTorn`（plan 自己在 `:62-68` 承认这是真实场景，并称今天会「绕 owner 写出孤儿 `content_block_stop@0`」），随后终局站点写 error 帧 → 客户端收到 `content_block_start@0` 开着、后面直接 `error`。今天客户端收到的是 balanced 的 `stop@0` + error。
- **为什么必须写进 plan**：这与 `handler-v4.ts:664-672` 逐字写下的 §10.5 理由（「the client is otherwise left with an OPEN content_block@0 — a protocol-incomplete stream」）**方向相反**；同时 M1 的终态不变量（`plan-3:51`）写着「行为等价…handler／driver 原有 settle、snapshot 与 heartbeat close 语义保留」，而这是一处**客户端可见的字节变化**。取舍本身可能是对的（`:62-68` 的立场是「撕裂后的孤儿 stop 该消失」），但**没有任何一处把这两句话对齐**，实施者读到冲突时会自行选边——正是 M-6 想避免的那种情况。记忆 `reference-exactly-one-terminal-is-not-exactly-one-complete-terminus` 记录过同型代价（合成终止符不完整会让真 SDK 抛错）。
- **修复方向**：在 ⑤ 的 M-6 留痕段（`:203`）补一句显式裁决：「wire-torn 下 anchor 保持未闭合是**有意**的（撕裂后不再向 wire 补结构帧，与 `:62-68` 的孤儿-stop 立场一致），代价是该失败流的 block 结构不平衡」，并同步把 `:51` 的「行为等价」限定为「除 wire-torn 失败路径外」。另建议加一条 owner 层 oracle 断言这个形状，免得日后被当成回归修掉。

**[major] N-3 — 站点 12 的 owner port 只能从**未装饰**的 `inner` 取；而 ⑤ 规定「无 owner 时 no-op」，传错 sink 会让 anchor **静默**不再关闭**

- **证据**：`getDownstreamDeliverySession` 走 `deliveryBySink` WeakMap（`session.ts:83-85`），键是 `createDownstreamDeliverySession` 注册的那个 sink 对象；`makeReconcilingSink`（`live-reconcile.ts:163-190`）返回的是**新对象**，未注册。而 ⑤ 第 207 行写「`ping` 模式或数组 sink 无 delivery session 时 no-op」——一个**接线错误**因此会退化成一个**看起来合法的 inert 分支**，客户端永远收不到 `stop@0`，而 M1 的 O-6（无-anchor 主腿）与多数站点回归都看不见它。
- **为什么这是新风险**：今天的 `closeAnchorIfOpen(sink, ...)` 用 `sink.writeAnchor ?? sink.write`，**对任何 sink 都能写**，传装饰过的 sink 也照样正确。M1 换成 owner 之后，「能不能写」第一次取决于「这个 sink 对象是不是被注册过的那一个」。
- **修复方向**：两条都做——① ⑤ 里点名站点 12 必须用 `inner`（并说明装饰器不在 WeakMap 里）；② 把 no-op 契约收窄为「**只有在 legacy 状态表明本就没有 open anchor 时**才允许静默 no-op；若 `anchorState.injected && anchorBlockOpen && !anchorClosed` 却找不到 owner，是接线缺口，必须 loud（throw 或至少 `consola.error` + 计数）」——符合项目 `never-swallow-errors` 与记忆 `methodology-appliesto-matches-but-chain-never-driven`。

### Minor / Nit

**[minor] N-4 — ⑤ 内部矛盾：第 205 行把 `DeliveryOwnerError` 的捕获放进 `closeAnchorViaOwner` 内部，第 212 行又要求站点 5/8「必须显式加同样的内层保护」**。两站点调用的是同一个 helper，helper 已捕获则无需再加；若实施者反读成「helper 对这两站点不捕获」，就会写出不必要的分支或误以为存在逸出路径。建议第 212 行改成「站点 5/8 位于无内层保护的 `catch`，因此**尤其依赖** helper 的内层捕获——不得在这两处绕过 helper 直接调 owner」。

**[minor] N-5 — 统一形状里的 `recordForwarded()` 在站点 1 不存在**。`recordForwarded` 只定义于 `handler-v4.ts:1300`（direct pump）与 `:1666`（translate pump），且都用非空 `env.ctx`；站点 1（`:693`）在 `writeTerminalThenSettle` 内，等价物是 `ctx?.setForwardedResponse({ sseEvents: [...forwardedSseEvents] })`（`:700`），且 `ctx` 可空。⑤ 第 206 行应点名站点 1 的等价物，否则「统一形状」在唯一一个真正棘手的站点上无法照抄。

**[minor] N-6 — 站点 9/10 今天**吞掉** anchor close 的写失败，M1 后转为 loud，这是行为变化但未记录**。`driver.ts:1187-1191` 的 `try { writeAnchor } catch { /* client gone mid-close — best-effort */ }` 今天把失败静默吃掉、原 outcome 不变；⑤ 第 213 行规定 M1 后「driver 捕获后经既有 `streamErrorOutcome` mint 点导出 `ResponseOutcome`」→ 原 outcome 被 stream-error 覆盖。方向是对的（不吞错误），但与 `:51` 的「行为等价」冲突，应与 N-2 一起在 plan 里列成「M1 有意引入的两处行为变化」。

**[minor] N-7 — `OwnerTerminalDecision.client-aborted` 的 `partialDelivery: boolean`（`plan-3:188`）在记录点下沉 owner 之后没有消费者**。⑦（`:253`）已把 partial-delivery 的记录移到 owner 产生点、并明写「翻译层不记录」，decision 上这个字段谁读、读来做什么，plan 未说。要么写明它的消费者（例如站点日志或 settle 的 `cause`），要么删掉——否则它会变成第二条事实源，与 `PipelineInfo` 争夺「谁是 partial-delivery 的真相」。

**[nit] N-8 — `OwnerTerminalDecision` 的另外两个判别值 `"client-aborted"` / `"delivery-finished"` 仍与 `ResponseOutcome.kind` 同名**。B-C 只改了撞守卫的那一个。类型上安全（两者不互相赋值），但 driver 适配器里两种同名 kind 并排出现，读者需要每次确认「这是 decision 还是 outcome」。上一轮建议的整体改名（`settle-aborted` / `already-settled` / `settle-failed`）仍成立，成本一次替换。

## 三、派活方点名的三个重点：直接回答

### 1. B1 / 修法 (c)

- **两条双写失败场景是否真的不可达？** —— **是，条件是 13 处在同一 commit 原子迁完**（`plan-3:280` 已写死）。全仓扫描证明 anchor-stop 的物理写点恰好 5 个、13 个调用者全在清单内，无第 14 处；迁完后 owner 的 `openAnchorIndex`（`session.ts:399/407`）成为唯一关闭权威，第二个关闭者必得 `"none"`。走查 A/B 逐帧重放确认。
- **迁移期的排序会不会坏？** —— 不会。M1–M3 期间站点 11/12/13 相邻的 real write 仍走 legacy `sink.write`，但那条路径也进**同一个** serializer（`session.ts:120-134` 与五个 owner 入口共用 `:97` 的 serializer），且调用点是 `await`，故 FIFO 成立。② 第 150 行的这句主张**经代码验证为真**，不是推理。
- **新加的 oracle 在错误实现下会不会红？** —— **不会；它在正确实现下就是红的**。这是本轮唯一的 blocker（N-1），机制性证明与替代 oracle 设计见上。

### 2. B3 + M-2 叠加

- **partial-delivery 的证据真能进 History 吗？** —— **能。** `PipelineInfo` 的持久链路逐段实测成立：`ctx.record*` → 独立槽位 → `mergedPipelineInfo()`（`request.ts:331/339`）→ `HistoryEntryData.pipelineInfo`（`context/types.ts:344`）→ `history/types.ts:211-231`，且有既有消费者读它（`telemetry-dimensions.ts:154`）。与上一轮 `recordFeature` 的假事实相比，这次的支撑事实**全部为真**。接线可行性也核过：`makeAnchoredSseSink` 现在没有 ctx 参数，但两个调用点（`handler-v4.ts:567/650`）都够得到 ctx。
- **站点 1 的 `finally` 倒置处理干净了吗？** —— **指令层已堵住**（`plan-3:206` 明令移出 `finally` 辖域 / 或让 `finally` 识别已 settle，且禁止依赖二次 settle、禁止形成 settle→snapshot）。**残留一处**：同句给的统一形状用了站点 1 作用域里并不存在的 `recordForwarded()`（N-5）。这不影响正确性判断，但会让「照抄统一形状」在站点 1 卡住。
- **覆盖面**：⑦ 同时覆盖 returned client-gone（`session.ts:411-413`，`committed:true`）与 thrown `DeliveryOwnerError`（`:415`）两条 post-commit 腿，且要求两条腿各有 History round-trip oracle（`:276`）——这一点比上一轮的建议更完整，记录点下沉产生点也确实把「唯一记录一次」从调用拓扑约定变成了机制保证。

### 3. M-6 的按-reason 短路

**你的读法是对的，而且不只是文本自洽——它有代码支撑。**

- `write()`（`session.ts:120-134`）只在 `state !== "open"` 时丢帧，**从不检查 `wireTorn`**；`writeSynthetic` 走同一条路径。所以 C9 的「禁止后续分配但不关闭 session，因此 terminal error / close / finalize 仍可完成」在实现层是**成立的事实**：撕裂后 handler 的终局 error 帧确实还写得出去。把 `wire-torn` 解释成「只封锁分配、不封锁普通终局写」与代码一致。
- 另一条独立佐证：driver 今天对 `wire-torn` 的现行处置就是 `streamErrorOutcome(...)`（`driver.ts:934`），即**loud 终局**而非静默收场——handler 侧照同一形状不短路，是与既有实现对齐，不是新发明。
- **与性质 4 字面表述打架吗？** —— 不打架，因为你把性质 4 本身改写了（`plan-3:109` 现在就是「按 reason 决定是否短路」）。这是修改了一条冻结性质，但它有留痕（`:203`）、有可否决路径、且改后的表述与 ⑤ 第 206 行、与 C9、与代码三方一致。**判：自洽。**
- **唯一没答的问题是代价**：短路与否之外，wire-torn 下 anchor 永远关不上，客户端拿到未闭合的 block@0 + error（N-2）。这不影响你读法的正确性，但必须在 plan 里显式承认，否则它会与 §10.5 的原始理由和 M1 的「行为等价」不变量互相拆台。

## 四、给调用方的一句话

修订稿对上一轮 18 条的处置**扎实且基本到位**——尤其 ⑦ 换载体、⑤ 的签名与逐站点 throw 处置、④/转移表前言的写者分工，这次都是**读完两侧才落笔**的产物，行号抽查几乎全中。剩下的问题集中在一个模式上：**采纳了 (c) 修法，却把 (a)/(b) 时代写下的 oracle 原样留下**（N-1），以及**采纳了「按 reason 分」，却没结算这条读法在 wire-torn 下的代价**（N-2）。两条都是「处置之间没有互相对账」，不是「没读代码」。修掉 N-1、把 N-2/N-6 的行为变化写进 plan、N-3 的 no-op 契约收窄，这一节即可定稿开工。
