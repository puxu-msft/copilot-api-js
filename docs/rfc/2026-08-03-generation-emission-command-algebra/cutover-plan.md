# Cutover 实施计划 —— generation emission command algebra

> **这是三层结构的第二层**（skill `large-refactor` §5）：`design.md` 回答 WHY + 契约，本文回答 HOW + 锚在哪，`prompts/` 回答实施者照着干。
>
> **本文不冻结任何 RFC 未冻结的签名。** RFC §3 的接口是**草案**（`design.md:146` 逐字写明「本文不伪造这些尚未存在的源码签名」）。凡本文出现形似签名的文字，一律标注「RFC 草案名」或「性质冻结，签名待调查」。写下任何形状前过三问——**它导出了吗 / 调用方拿到什么返回类型 / 那一刻它存在吗**——答不上就只冻结性质 + 列一条调查 task。
>
> **判据细节不在这里。** 「怎么测 / mutation 正控 / false-red 对照」的单一事实源是 `design.md` §10.2 的对应行；归属与可达性的单一事实源是 `traceability.md`。本文每个 commit 的「门」一节**只写 id + 可复跑命令**，两处并存的表必然漂移。

## 0. 使用前必读

### 0.1 两棵树，行号不通用

| 树 | 路径 | HEAD | 状态 |
|---|---|---|---|
| **master**（文档树） | `/home/xp/src/copilot-api-js` | 随时前进 | 本文与 RFC、矩阵都落在这里 |
| **feature**（M1 代码树） | `/home/xp/src/copilot-api-js/.worktrees/anchor-alloc` | `2c339784`（`src/` 与 RFC 设计基线 `854421d4` 逐字节相同，见 inventory §12） | **未合并**，用户裁决由本次 cutover 一并重塑 |

**两棵树互不为祖先**（实测 `git merge-base --is-ancestor master feat/inter-block-anchor-allocator` = NO；merge-base `200aba8b`；master 领先 47 commit，feature 领先 8 commit）。

**因此本文每张锚点表的每一行都标树。** 混写的具体后果，已实测两例：

- `closeAnchorViaOwner` 在 feature 树 `src/` 有 14 处命中，在 **master 上零命中**——它是 M1 引入的。
- `ClientSink` 在 feature 树是 `src/lib/pipeline/types.ts:747`，在 master 上是 **`:737`**。RFC §7.2 的闭包种子行号全部锚在 feature 树。

### 0.2 Commit 0 之前还有一件事没有归属：cutover 在哪棵树上起

RFC §7.1 要求「在实际 entry commit `<sha>` 连跑至少 15 次」，但**没有说 entry commit 属于哪棵树**。而两棵树都不能直接当 entry：

- 在 master 上起 → M1 不在（`closeAnchorViaOwner` 零命中、`OwnerRawSink` 零命中），RFC §7.2 的 A／C／D 集人口与 §5 的 inventory 全部对不上，而用户已裁决「M1 由 cutover 重塑而非丢弃」。
- 在 feature 上起 → 落后 master 47 commit，其中含本轮修掉的三处既有缺陷（`4f7a3989` O-6 恒真、`200aba8b` AST 守卫假红、`51b1e1c9`+`cc909c81` 两条基线 flaky）——而这三处正是 RFC §7.1 入场条件要求已闭合的东西。

**这是一条调度决策，不是实施者可自裁的技术细节**，见 §11「待裁项 #4」。**T0.1 在它裁定前不可开工**——`MIN_TESTS` 与 15 次连跑都必须锚在最终 entry commit 上，锚错树等于整条入场证据链作废。

### 0.3 每个 commit 的共同门（RFC §7.1，不在各节重复）

```bash
cd /home/xp/src/copilot-api-js && bun run typecheck
cd /home/xp/src/copilot-api-js && FORCE_COLOR=0 bun scripts/parallel-test.ts unit it http
cd /home/xp/src/copilot-api-js && exp/inter-block-anchor-allocator/byte-equivalence.sh   # 须打印 O-6 PASS、rc=0；禁止 RECAPTURE=1
```

第三条即 **R-11／O-6**，每个 commit 都跑，**本文不在各节重复列它**。另外每个 commit 结束还须满足 §7.1 的两条状态断言：本 commit 已激活的 witness 正样本绿、production mutation 红、false-red 对照绿。

### 0.4 准备 commit（1～3）的越界判据

RFC §7.4 的两条，**缺一不可**，每个准备 commit 结束时都要跑：

1. `git diff` 中无 production call-site 切换。
2. **存在性分派的解析结果不变**——属性存在性快照逐 commit 比对，快照由 checker 产出而非人工列举，口径覆盖闭包内全部类型、它们的实现对象、以及构造它们的 options 字面量。**理由是实测出来的**：feature 树 `session.ts:581-602` 那类 `sink.writeAnchor ?? sink.write` 的分派，只要方法是否存在变了就会改行为，而 call-site 一行不动。

第 2 条的快照工具本身是 **T0.7** 的产物。

---

## Commit 0 — Legacy 基线、旧缺陷 characterization 与 oracle 分型

**目标**（RFC §7.3）：不改 production；冻结 O-1／O-2／O-6 与现有 goldens、搭建 handle-level physical recorder 并自检、把测试面分四类、并把「旧生成 delivery 的完整能力面」按 §7.2 的双向闭包冻结成 A／B／C／D 四集。

### 逐 task

| id | 先写什么失败测试 → 预期怎么红 | 实现什么 → 预期怎么绿 |
|---|---|---|
| **T0.1** | **入场条件，不是测试**。在 §11 待裁项 #4 裁定的 entry commit 上，先跑一次 `unit+it+http` 取真实用例数，再把它作为 `MIN_TESTS` 冻进命令。**`MIN_TESTS` 的取值必须来自你即将运行的那条命令之外**，否则下限自我认证（HANDOVER T3 🔴）。 | `OUT=docs/tmp/<date>-entry-runs RUNS=15 MIN_TESTS=<实测数> exp/inter-block-anchor-allocator/baseline-runs.sh`，rc=0 且保存每次原始输出。任一次失败即不得开始 cutover。**在 T3-b 落地前，本条结果只能按缩小版命题引用**：「具名命令在同一 commit 上被调用了 15 次，每次带 provenance，自报用例数稳定且高于调用方指定的下限」——不得表述成「全后端套件已验证」。 |
| **T0.2** | 先把 O-6 脚本在**未改动树**上跑一次，确认打印 `O-6 PASS`、rc=0、fixture blob 未变；再注入一字节，确认 rc=9。**这是 false-red／false-green 双向自检，不是形式**——该门此前恒真（脚本覆盖自己的基线、全脚本无 `cmp`），`4f7a3989` 才修好。 | 把这两条写进 cutover 的每 commit 检查清单。**禁止 `RECAPTURE=1`**。 |
| **T0.3** | 写 handle-level physical recorder，**先让它在「什么都没包住」的状态下断言零 direct send**——此时断言平凡为真，是**假绿**。 | recorder 必须包裹 composition root 实际取得的 `stream`／`ws` handle 并**位于 raw emitter 之下**；再加一条 test-only direct-send seam，断言 recorder **确实看得见**绕过 owner 的发送。看不见就说明探测层装错了深度（RFC §10.1「探测深度必须与被测对象对齐」）。**注入 owner 的 test raw adapter 不用于本判定**。 |
| **T0.4** | 对 warmup fake／drop 写真实 route behavior test：断言完整字节、upstream 零调用、delivery observer **零 session**、一次响应。**先在缺失 observer 的状态下跑**，确认「零 session」这条断言此刻还够不到 delivery 层。 | 接上 delivery session observer（feature 树已有 `setDeliverySessionObserverForTests`，见锚点表），四条断言转绿；mutation「提前创建 owner」或「双写」必须红。这是 **Q3 已裁方案 A**，是 §5 唯一没有现成 behavior witness 的出口，也是 composition-root 互斥性的 gatekeeper。 |
| **T0.5** | 对 AUQ fallback SSE 与四格式 non-streaming JSON 各写一条 route observer 基线：断言该 operation 零 delivery owner、完整响应只写一次。**先构造「提前创建 owner」的 mutation 确认它会红**。 | 基线转绿。注意 AUQ 的正确状态是 **upstream／ctx 可能已存在但 client wire 未 commit**——不得把「有 upstream」误判成「有 owner」。 |
| **T0.6** | 在**旧边界**上写 red characterization：让一个与 active anchor index 同字节的 stop 走普通 generic `write`，断言「wire 已 closed 而 owner lease 仍 open」这一分裂**稳定复现**。**这条测试在 Commit 0 就是红的，而且必须一直红到 Commit 4。** | 不修它。把它标成 R-3 的旧缺陷 characterization，并在 Commit 4 转绿时同步改写断言方向。**「现在是红的」本身要落盘**，否则 Commit 4 会把它当成新引入的失败。 |
| **T0.7** | 实现 §7.2 的**双向不动点闭包**并先跑一次：种子 = §7.2 列出的 6 个 capability 类型（**按 declaration identity 取，不按文件路径也不按名字文本**）；向上（消费者）+ 向下（成员，含**声明**的参数与返回类型）交替迭代。**先构造一个反例确认判据有牙**：`createGenerationWireIndexAllocator()` 零参数、返回类型不是种子——只做向上方向时它与调用点 `handler-v4.ts` 都进不了闭包，**必须**由向下方向捞进来。 | 输出完整 symbol hit set（不是数字），再切成互不相交的 A／B／C／D 四集。四条结构停止点写死（原始／内置类型、`node:`、`node_modules`、别名解析后判断），`any`／`unknown` **不是停止点**、落入 unclassified 并具名 disposition。C／D 相交时按 §7.2 tie-break：**construction／resolution 语义优先归 C，有疑义入 C**。任何 export／production reference 既未进 A／B／C、也未被具名判为合法 pre-owner／test-only，**Commit 0 与 Commit 4 均 fail loud**。 |
| **T0.8** | 把测试面分四类（owner-backed array adapter／raw transport 字节与 observation unit／owner→adapter seam／**test-only adversarial 旧边界正控**）。**先验证第四类真的还能在旧边界造出 wire／state 分裂**——造不出来说明它已经被「合法化」掉了，那正是 R-10 要防的。 | 四类分档落盘（口径来自 inventory §9：92 个 fake 构造点／40 文件、57 个编译期 sink API 依赖文件、65 个 raw factory 调用／14 文件）。**不得机械把所有 fake 改成合法 owner 路径后丢掉 positive control**。 |
| **T0.9** | 冻结现有 anchor／terminal goldens 的文件清单与当前哈希；对每份写明它锁的是什么。**先挑一份注入帧重排，确认它会红**——不会红的 golden 是摆设。 | 清单落盘，作为 Commit 4 「Q5 逐帧预测 diff」的比对基座与 Commit 7 审计对象。 |

### factory／锚点表

| 符号 | `file:line` | **树** | 在本 commit 的用途 |
|---|---|---|---|
| `ClientSink` | `src/lib/pipeline/types.ts:737` | **master** | 闭包种子。**RFC §7.2 写的 `:747` 是 feature 树的行号** |
| `ClientSink` | `src/lib/pipeline/types.ts:747` | feature `2c339784` | 同上；RFC 引用的就是这一行 |
| `OwnerRawSink` | `src/lib/pipeline/delivery/types.ts:12` | **feature only**（master 零命中） | 闭包种子 |
| `AnchorState` | `types.ts:519`（master）／`:529`（feature） | 两树皆有 | 闭包种子 |
| `GenerationWireState` | `types.ts:486`（master）／`:496`（feature） | 两树皆有 | 闭包种子 |
| `WireBlockAllocationPort` | `types.ts:309`（master）／`:319`（feature） | 两树皆有 | 闭包种子 |
| `DownstreamDeliverySession` | `delivery/session.ts:50`（master）／`:57`（feature） | 两树皆有 | 闭包种子；public 面 9 项 |
| `GenerationWireIndexAllocator` | `types.ts:494`（master）／`:504`（feature） | 两树皆有 | **T0.7 的向下方向反例**：它只是 `GenerationWireState` 的一个属性 |
| `createGenerationWireIndexAllocator()` | `keepalive-anchor.ts:52` | 两树同行 | 同上，零参数工厂，只做向上会漏 |
| `createGenerationWireState(allocator)` | `keepalive-anchor.ts:44` | 两树同行 | 对照组：**因返回种子**而会进闭包 |
| `WireBlockMapping` / `LegToken` | `types.ts:467` / `:464`（master）；`:477` / `:474`（feature） | 两树皆有 | §7.2 明确点名：它们是 C10／C3 的授权事实本身，**不得被「无能力」过滤器排除** |
| `setDeliverySessionObserverForTests` | `delivery/session.ts:74` | feature | **T0.4／T0.5 的 observer 接入点**；master 上须先核实是否存在（见 T0.4 调查） |
| warmup 三个 direct write | `warmup.ts:214,230,243` | 两树同行 | T0.4 被测对象 |
| AUQ direct write | `error-shaping-glue.ts:131` | 两树同行 | T0.5 被测对象 |
| raw SSE physical adapter | `client-sink.ts:209`（feature）／`:200` 附近（master 待核） | 两树 | T0.3 recorder 必须**位于它之下** |
| raw WS physical adapter | `client-sink.ts:645`（feature） | feature | 同上 |
| 10 个 outer composition roots | 见 §Commit 4 锚点表 | 两树行号不同 | T0.3 recorder 包裹点 |

> ⚠️ **master 侧行号只在本文写作时（master `fcf10eca`）成立**，且 master 每天前进。**引用前重取，别引用本表的快照值**：
> ```bash
> cd /home/xp/src/copilot-api-js && rg -n '^export interface ClientSink|^export interface AnchorState' src/lib/pipeline/types.ts
> ```

### 本 commit 的门

| id | 段与等级 | 可复跑命令 |
|---|---|---|
| R-13 | C0 `production 硬门`（Q3 已裁 A） | 见 T0.4／T0.5 落盘的测试路径 |
| R-1 | C0 `辅助门`（recorder 自检） | 见 T0.3 |
| R-3 | C0 `辅助门`（旧缺陷 characterization，**红**） | 见 T0.6 |
| R-11 / O-6 | 每 commit 共同门 | `exp/inter-block-anchor-allocator/byte-equivalence.sh` |

### commit invariant

production 源码与运行时行为**逐字节不变**（`git diff -- src/` 只允许为空）；A／B／C／D 四集全部原样存活；新 core 不存在；旧边界的「wire stop 已写、owner lease 仍 open」稳定为红；typecheck 绿、`unit it http` 确定性全绿、O-6 PASS。

---

## Commit 1 — Capability types 与 profile registry 准备

**目标**（RFC §7.4）：增加 discriminated profiles、command input／result types、`openMessageEnvelope`、`runEmissionBatch`、typed terminal result、validated envelope type 与 compatibility registry；选定「先 narrow profile 再 factory」或经 PoC 证明的 owner top-level discriminant。**不创建 production owner、不改 outer roots／driver／handler 参数、不注册 timer／sampling。**

### 逐 task

| id | 先写什么失败测试 → 预期怎么红 | 实现什么 → 预期怎么绿 |
|---|---|---|
| **T1.1** | compile fixture **正样本**：四类 non-Anthropic concrete profile 调 `emitGeneric`／`emitKeepalive`／`terminate`，Anthropic concrete profile 调 common 与每个 indexed command。**先在类型不存在时跑 `tsc`，确认红。** | 按 RFC §3.2 加 `AnthropicDeliveryProfile` 等五个 profile 与 `FormatDeliveryProfile` union，`indexedBlockLifecycle` 是 **compile-time discriminant，不是 runtime feature flag**，所有 profile 必须显式给值。`tsc` 转绿。 |
| **T1.2** | compile fixture **负样本**：在 Responses HTTP／Responses WS／Chat Completions／Azure／Gemini owner 上分别引用 `openAnchor`／`openRealBlock`／`writeRealBlockFrame`，由 `@ts-expect-error` 锁定 property 不存在。**先确认移除注解时 `tsc` 必须失败**——否则这条 fixture 什么都没测。 | 按 §3.4 的 `CommandsFor<P>` 条件类型收窄，负样本转绿。 |
| **T1.3** | **判别正控**：故意把 factory 返回值退化成共同大接口，负样本必须因「unused `@ts-expect-error`」或显式 compile-failure harness **转红**。再写 union profile 正负样本：未收窄的 `FormatDeliveryProfile` 不能取得 indexed port；先 `profile.indexedBlockLifecycle === "anthropic"` 收窄再调 generic factory，所得 owner 的 indexed command 必须 compile-green，`none` 分支仍 compile-red。 | 保留 §3.5 的**反例锁定**：factory 先接 union profile、再检查嵌套 `owner.profile.indexedBlockLifecycle` 的样例**必须保留为 compile-red characterization**（该路径已被 TypeScript 5.9.3 PoC 证否）。**不得用 `as AnthropicGenerationCommandPort` 作正确样本。** |
| **T1.4** | classifier 三态 unit：①structured payload parse failure 在 external write 前拒绝；②已登记为 owner-governed／terminal／indexed-block 的 effect 误走 generic → `CommandEffectMismatchError`；③payload 可解析但 effect 未登记 → **按 richest-data-flow 默认允许发送**，`actualEffect=unknown`，原始 type／frame detail 进 trace／History。**第三态先写成「拒绝」跑一遍确认它会红**——默认拒绝是最容易写错的方向。 | 三态转绿。**未知 effect 不是已知 generic 的证明，也不是默认拒绝理由。** |
| **T1.5** | command input／result types、`ValidatedDeliveryEnvelope`、`command × profile` compatibility registry 的 unit：断言 envelope 至少保留 §2.2 冻结的性质集合（原始 frame、`command`＋per-operation 唯一 `commandId`、format profile、expected／actual effect、owner-minted provenance、target kind、authorization 引用的 wire index／leg kind／owner state version、candidate／dispatch identity、observation time、C9 committed、compound phase）。 | 转绿。**这些是最小性质集合，不预先规定扁平字段／嵌套对象／opaque token**——具体形状由 T3.1 沿真实 caller 调查后定。 |
| **T1.6** | `openMessageEnvelope`／`runEmissionBatch`／typed `TerminalEmissionResult` 的**类型层**存在性与 `terminalFrameDisposition` 三态（`emitted` / `suppressed_client_gone` / `suppressed_session_terminating`）穷尽性 unit。 | 转绿。**`finalize(result)` 只能消费本 owner 签发的 opaque result**——类型层先把「无 result 时只允许 client-aborted／零 terminal-frame 分支」表达出来。 |
| **T1.7** | 属性存在性快照工具（§0.4 第 2 条）在 Commit 0→1 之间跑一次。**先手工加一个 optional 方法确认它会红。** | 快照相等，rc=0。 |

### factory／锚点表

| 符号 | `file:line` | **树** | 用途 |
|---|---|---|---|
| `ClientFormat`（四值 union） | `src/lib/pipeline/envelope.ts:19-23` | 两树 | profile discriminant 的 `format` 取值来源 |
| `FormatCodec` | `src/lib/pipeline/types.ts:942-1031`（feature） | feature（master 行号待重取） | RFC §2.6 的既有格式抽象；本次沿用「格式方提供知识、delivery 消费窄口」的依赖方向 |
| `DeliveryTerminalCommand` | `delivery/types.ts:67-74`（feature） | feature | 迁移**输入**；其 `frames?: DeliveryFrame[]` 允许 caller 提交已铸 provenance，**不能原样成为终态公共签名** |
| `ClientBlockLedger` | `delivery/types.ts:28`（master）／`:37`（feature） | 两树 | observation 层既有形状，T1.5 的对照 |
| `WireBlockAllocationPort` 五方法 | `types.ts:309-322`（master）／`:319-332`（feature） | 两树 | **被替换的双面能力**，不是可继续扩展的终态 |

> **调查任务（本 commit 内必须回答，答不上就只冻结性质）**：`makeDeliverySseSink`／`makeDeliveryWsSink` 当前都是 exported function 且返回静态 `ClientSink`；新 composition factory **是否需要 export**、哪些调用方拿 `GenerationDeliveryOwner<P>`、哪些只拿 `CommandsFor<P>`——RFC §9.3 第 1 项，**最终证据槽在 Commit 4 publish kickoff**，Commit 1 只取最小子集。

### 本 commit 的门

| id | 段与等级 | 可复跑命令 |
|---|---|---|
| R-6 | C1 段，**等级未定见 §11 待裁项 #1** | `bun run typecheck` + compile fixture harness（T1.1～T1.3） |
| R-2 | C1 `辅助门`（classifier 三态 unit） | T1.4 落盘的测试路径 |
| R-11 / O-6 | 每 commit 共同门 | 同 §0.3 |

### commit invariant

旧 API population 与 Commit 0 **机械相等**（A／B／C／D 四集逐 symbol 相等）；**存在性分派解析结果不变**（T1.7 快照相等）；`git diff` 无 production call-site 切换；所有新代码只被 compile fixture 与 direct unit test 引用；typecheck 绿、全套绿、O-6 PASS。若 `git diff` 出现 production call-site 切换，**本 commit 越界，重排而非放宽**。
