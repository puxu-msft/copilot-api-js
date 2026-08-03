# M1 调查结论评审（Claude，独立评审者）

- 日期：2026-08-03
- 被审对象：`docs/plan/2026-07-27-inter-block-anchor-allocator/plan-3-remap-sites.md` 的「#### M1 调查结论（2026-08-03 回填 …）」一节（①–⑧ + 其下「验收分两层」）
- 裁判轴（派活方显式指定）：长远正确 + 完整；架构健康 > 回归风险。**不采用** ROI / YAGNI，不提「先做简单版、以后再说」。
- 工作树：`/home/xp/src/copilot-api-js/.worktrees/anchor-alloc/`（只读，未修改任何被审文件）
- 独立性声明：同目录已存在 `docs/tmp/2026-08-03-m1-investigation-review-gpt.md`。**本次评审全程未读它**，以保证结论独立。

## 总体 verdict

**存在 blocker（3 个）——M1 不得按本节现状开工。**

Blocker 3 / Major 8 / Minor 5 / Nit 2。

八条冻结性质：**满足 3 条**（性质 2 / 3 / 6，性质 6 附条件），**部分满足 3 条**（性质 1 / 4 / 8），**未满足 2 条**（性质 5、性质 7）。

三条 blocker 都不是「写得不够细」，而是**结论规定的做法与仓库现状直接冲突、且 M1 自己的门会因此不可满足**：

1. **B1**：12 个 close 站点中 1–10 迁 owner、11/12 留 legacy，而 legacy 关闭**不清 `openAnchorIndex`** → 同一 anchor 写出**两个 `content_block_stop@0`**。M1 门的 exactly-once 不可满足。
2. **B2**：`OwnerTerminalDecision` 的 `kind: "stream-error"` 对象字面量必被 master 架构守卫判为 offender → M1 的「`test:fast` 绿」不可满足。
3. **B3**：性质 7 指定的持久载体不成立——`recordFeature` **不进 History**，只发一条活体事件。

## 双视角覆盖证据（可审计）

### 机械核对（扫描 / 对账 / 查证）

- **① 的 12 个站点行号逐条实测为真**：`handler-v4.ts` 的 `closeAnchorIfOpen` 调用点 = `:693 / :1416 / :1526 / :1553 / :1607 / :1716 / :1754 / :1798`；共享 primitive 定义 `keepalive-anchor.ts:259`；driver 私有闭包定义 `driver.ts:1181`、调用点 `:1438 / :1609`；`closeAnchorBeforeReal` 定义 `driver.ts:1239`、调用点 `:1247 / :1259`；`live-reconcile.ts:138` 置位、`:172-173` 装饰器经 `writeAnchor` 写出。
- **③ 的三条事实实测为真**：`keepalive-anchor.ts:319-335`（Migration bridge 同步预发布 + `restoreMirror`）逐字为真；`session.ts:353`（commit 回调置 `openAnchorIndex`）、`:407`（成功路径清它）、`:411-413`（close 的 client-gone 返回 `committed:true` 且**不清** `openAnchorIndex`）行号精确命中；`driver.ts:1223-1224`（serializer 外快照两标志）为真。
- **⑥ 的构造点计数实测为真**：`session.ts` 的 `ownerFailure` 恰好 5 处（`:290 / :291 / :328 / :413 / :440`）；`ownerUnavailable` 写死 `false`（`:290-291`）、非 client 写失败 `throw DeliveryOwnerError` → 两个「不可达」的机制性证明成立。
- **⑤ 的计数实测**：`ownerFailureOutcome` 5 个调用点（`driver.ts:878 / 1022 / 1109 / 1523 / 1581`），均紧随 `beginLeg`；`beginLeg` 亦 5 处 → 数字无误，措辞易误导（Minor-3）。
- **守卫真身查证**：`tests/architecture/package-boundaries.unit.test.ts:590-621`（AST 判据）+ `:708` `MINT_HELPER = "streamErrorOutcome"`；`package.json:54` `test:fast = unit + http` → 该守卫在 M1 的门内。
- **持久性查证**：`HistoryEntryData`（`src/lib/context/types.ts:312-383`）**无 features/tags 字段**；`recordFeature`（`src/lib/context/request.ts:2109-2116`）只 `publish`；`request.feature_applied` 消费者仅 `observability/sinks/ws.ts:129` + `tui/active-request-store.ts:110`，telemetry sink 不收；`tests/context/request-emit-methods.unit.test.ts:7` 自陈「no ctx mutation」。
- **类型可行性核对**：`PartialResponseInfo`（`src/lib/context/types.ts:123-138`）字段全可选 → 8 站点四种 partial 形状结构上都可赋值；`RequestContext.settled`（`:474`）、`recordFeature`（`:745`）存在，方法参数双变 → `OwnerFailureContext` 可由真 ctx 满足。
- **反向扫描 AnchorState 构造点**：`anchorClosed: false` 全仓仅 `handler-v4.ts:1128` 与 `driver.ts:1165`（后者是 ping 模式惰性兜底、无注入器）→ ③ 的「唯一供给点 = `makeAnchoredSseSink`」成立。
- **陈旧引用扫描**：本节上方引用的 `types.ts:444` 实指 `AnchorHooks.remap` 一带；`anchorBlockOpen` 的「stays TRUE」原注释实际在 `types.ts:536-538`（Minor-2）。

### 第一人称执行视角（模拟走查的流程 / 分支）

- **走查 A（live 腿 + 真实块 + 截断）**：注入器开 anchor（owner 置 `openAnchorIndex=0`）→ `reconcileLiveFrame` 在首个真实块前置 `anchorClosed=true` 并经装饰器 `writeAnchor` 写出 `stop@0`（**不经 owner，`openAnchorIndex` 仍为 0**）→ 上游截断 → pump 站点 4（`handler-v4.ts:1553`）按 ⑤ 调 owner `closeOpenAnchor` → owner 见 `openAnchorIndex !== undefined`（`session.ts:399`）→ **写第二个 `stop@0`**。→ B1。
- **走查 B（buffered 腿 + 真实块 + 穷尽）**：flush 内站点 11（M2 才迁，`driver.ts:1239-1244`）legacy 关 anchor → 上游截断不可重试 → driver 站点 10（`driver.ts:1609`，M1 已迁）调 owner → 同上第二个 `stop@0`。→ B1。
- **走查 C（站点 1 的 `writeTerminalThenSettle`）**：按 ⑤ 的统一形状 `if (d) { settleFromOwnerFailure(...); return }` → `return` 触发 `finally { ctx?.setForwardedResponse(...); settle() }` → **settle 先于 setForwardedResponse**，与 `handler-v4.ts:683-694` 明写的「close anchor → writeSynthetic → setForwardedResponse → fail」顺序相反。→ Major-2。
- **走查 D（driver 站点 9/10 无 anchor 的常态）**：今天 `driver.ts:1182` 的 `sink.close?.()` 在 `if` **之外**无条件执行；owner 的 `closeOpenAnchor` 在 `openAnchorIndex === undefined` 时于 `session.ts:399` 直接 `return "none"`，**走不到 `:400` 的 `closeHeartbeat()`** → 迁移后心跳不再被停。→ Major-3。
- **走查 E（站点 5 / 8 抛错）**：这两个站点本身就在 `catch (error) {` 块里、无内层 try；owner 的非 client 写失败是 `throw DeliveryOwnerError`（`session.ts:415` 一带）→ 异常直接逸出 pump。⑤ 只规定了 `OwnerResult` 失败分支。→ Major-7。
- **走查 F（`session-terminating` 从真实 HTTP 入口怎么来）**：`state` 变非 open 的唯一生产入口是 `session.terminate(...)`，其唯一生产调用点是 `session.ts:510` 的 `clientSink.finalize = () => session.terminate({kind:"complete"})`；而 8 个 handler close 站点全部在各自 `sink.finalize?.()` **之前**执行 → 真实 HTTP 入口下该组合基本触不到。→ Major-5。
- **走查 G（enveloped_ping）**：`makeSyntheticEnvelopeInjector`（`keepalive-anchor.ts:383-418`）**不走 owner 分配端口**，直接 `sink.write` / `writeSyntheticEnvelope` → `openAnchorIndex` 恒 undefined、`anchorClosed` 不被触碰 → 与转移表不冲突。**已验证为良性**。
- **走查 H（早退跳过 `sink.finalize?.()`）**：两个 pump 调用点（`handler-v4.ts:577` 与 `:768`）都有 `finally { sink.finalize?.() }` → 统一形状早退不会漏 finalize。**已验证为非问题**，不计入发现。

---

## 一、八条冻结性质逐条判定表

| # | 性质 | 结论的哪一段回应它 | 满足？ | 缺口 |
|---|---|---|---|---|
| 1 | **唯一翻译点**：翻译只有一处实现，不得每站点一份 | ⑤「位置」+ `classifyOwnerFailure` 签名 + 「两个适配器，各一份实现，站点不得自行发明」 | **部分满足** | 分类维度满足（唯一裁决点 = `classifyOwnerFailure`）；**适配维度不满足**：handler 侧适配器签名不可实现（缺 `ctx`，Major-1），且 8 站点在 model 取值、`upstreamSucceeded`、`partial` 来源、`ctx` 可空四个维度的差异**未被适配器吸收**，会以「站点各自补参数」退化 |
| 2 | **穷尽**：加第四个 reason 必须编译失败，不用 `default` | ⑤「穷尽性（性质 2）：内部用 `satisfies Readonly<Record<OwnerFailureReason, …>>`…不写 `default` 兜底」 | **满足** | 已核 `OwnerFailureReason` 现有且仅三个（`types.ts:295`）。⑥ 收紧 `OwnerResult` 后该别名不再被 union 直接引用，但按索引取表 `TABLE[failure.reason]` 仍会对新 reason 编译失败（**未验证**：未实跑 tsc 构造该反例，属类型推理） |
| 3 | **保住 provenance-gap 语义** | ⑤「不返回 `ResponseOutcome`…改由 driver 侧适配器消费 decision 后调 `streamErrorOutcome(decision.error, env)`」 | **满足** | 性质本身满足：mint 点仍是 `driver.ts:972` 的 `streamErrorOutcome`，`env.clientFormat` 原样可达（`:973`）。**但该设计撞守卫**——Blocker-2，属可实现性问题，与性质 3 的语义两回事 |
| 4 | **短路**：拿到终局决定后立即结束本站点终局路径，不得再补第二个终局帧 | ② + ⑤ 的统一形状 `const d = …; if (d) { settleFromOwnerFailure(d,…); return }` | **部分满足** | 帧层面满足（8 站点 `return` 后各自的 `writeSynthetic` 被跳过；两个 pump 的 `finally { recordForwarded() }` 不写帧）；**三处未闭合**：① 站点 1 的 `finally` 仍执行 `settle()` 与 `setForwardedResponse`，顺序被倒置（Major-2）；② 短路顺带丢掉各站点现存的「settle 前 `recordForwarded()`」载重顺序（Major-2）；③ wire-torn 下客户端**一个终止符都收不到**，与 C9 张力未记录（Major-6） |
| 5 | **ctx 侧收尾仍归 pump**：`ctx` 的 abort/settle 与 forwarded snapshot 必须由 pump 完成，翻译层不做也做不了 | ⑤ 的 `settleFromOwnerFailure(decision, ctx, model, partial?)`「按 decision 走 `ctx.abort` / 不动 / `ctx.fail`，**绝不写任何帧**」 | **未满足** | ① **字面冲突**：⑤ 的小标题就叫「翻译层：模块位置、签名、**两个适配器**」，把 `ctx.abort`/`ctx.fail` 明文放进「翻译层」，与性质 5 逐字矛盾（裁决见 §二.2）；② **实质缺口**：性质 5 点名的三件事里 **forwarded snapshot 一件都没安排**——适配器不做，统一形状也没给 pump 留位置（Major-2） |
| 6 | **终态分类按 reason 分** | ⑤「分类规则（性质 6）」三条 | **满足（附条件）** | 三支全覆盖，判据与 `driver.ts:938-940` 现行实现一致，已实测。附条件：`delivery-finished` 分支写「不动」，而两个 pump 既有的 `delivery-finished` 分支都会先 `recordForwarded()`（`handler-v4.ts:1387-1390` / `:1688-1691`）→ 应写明站点仍需 `recordForwarded()`，否则是与既有形状的静默分岔（Minor-4） |
| 7 | **partial-delivery 必须落到持久载体** | ⑦「用既有的 request-scoped 诊断载体…`FeatureKind` 新增 `wire-partial-delivery`…它已随 `request.feature_applied` 进 History 与 observability 事件（`events.ts:231`）」 | **未满足** | **⑦ 的支撑事实为假**：`recordFeature` 只 `publish`、不改 ctx（`request.ts:2109-2116`；`tests/context/request-emit-methods.unit.test.ts:7` 自陈 "no ctx mutation"）；`HistoryEntryData`（`types.ts:312-383`）**无 features 字段**；消费者只有 WS 活体广播（`sinks/ws.ts:129`）与 TUI 内存 store（`active-request-store.ts:110`）→ 请求结束即消失。见 Blocker-3 |
| 8 | **六组合逐一 disposition** | ⑥ 六格表 + 类型收紧 + 「两腿都改为类型级负测」+「验收分两层」 | **部分满足** | **降级合规**：⑥ 的类型收紧确实使两个非法组合构造不出来，腿二命中性质 8 第一条 ⚠️、腿一命中「producer 边界同样由类型排除」那条 ⚠️，且结论自加「正反各一」正样本对照 → **允许**（裁决见 §二.5）。**缺口在可达侧**：`session-terminating × false` 从真实 HTTP 入口在 8 个 handler close 站点处基本不可构造（走查 F），`wire-torn × false` 亦无先例（现有同类 oracle 全在 session 层用假 sink，`tests/pipeline/allocation-real-block-refusal.it.test.ts:44-68`）→ 该条验收有落空风险（Major-5） |

---

## 二、派活方点名的五个不确定点：逐条裁决

### 1. 性质 1 —— 「一个纯分类器 + 两个适配器」算不算「唯一」？`partial` 入参形状够不够用？

**裁决（前半）：算，但不是因为「两个」不多，而是因为唯一裁决点只有一个。** 性质 1 冻结的是「owner failure → **终局决定**的翻译」，不是「决定 → 各层终局形状」的落地。② 已实测证明两侧返回类型不同（handler 8 站点全在 `Promise<void>`，driver 2 站点在 `Promise<ResponseOutcome>`），所以强行统一返回形状反而会造出跨缝假设。分类器唯一 + 每层一个适配器 + 站点零判断，**符合性质 1 的立法意图**。

**「会不会退化成各自发明」：会，但退化点不在「两个适配器」，在适配器没吸收站点差异。** 逐个打开 8 个站点后实测到四类差异：

| 站点 | file:line | settle 调用 | model 取值 | partial 形状 | 额外参数 |
|---|---|---|---|---|---|
| 1 | `handler-v4.ts:693` | 由调用方传入的 4 个不同 `settle` 闭包（`ctx?.fail(resolvedName, error)` / `ctx?.fail(…, new HTTPError(…))` 等），且 **`ctx` 可为 `undefined`** | `resolvedName` | **无 partial** | — |
| 2 | `:1416` | `env.ctx.fail(…)` | `acc.model \|\| model` | `buildAnthropicResponseData(acc, model)` 的 4 字段 | — |
| 3 | `:1526` | `env.ctx.fail(…)` | `acc.model \|\| model` | 同上 4 字段 | **`{ upstreamSucceeded: true }`（第 4 参）** |
| 4 | `:1553` | `env.ctx.fail(…)` | `acc.model \|\| model` | 同上 4 字段 | — |
| 5 | `:1607` | `env.ctx.fail(…)` | `acc.model \|\| model` | **只有 `{usage:{input_tokens,output_tokens}, stop_reason}`**，非 `buildAnthropicResponseData` | — |
| 6 | `:1716` | `env.ctx.fail(…)` | `model` | `outboundResponseData()`（OpenAI/Responses 形状） | — |
| 7 | `:1754` | `env.ctx.fail(…)` | `model` | `outboundResponseData()` | — |
| 8 | `:1798` | `env.ctx.fail(…)` | `model` | `failedResponseData()` | — |

**裁决（后半）：`partial?: PartialResponseInfo` 这一个入参**够用**，但整个签名不够。**

- **够用的部分**：`PartialResponseInfo`（`src/lib/context/types.ts:123-138`）字段全可选，且 `fail`/`abort` 共用它（`:629` / `:643`）。站点 6–8 传的 `outboundResponseData()` 是函数返回值而非新鲜字面量 → 不触发 excess property check → **四种形状都可赋值**。这一点结论是对的。
- **不够用的三处**（结论未覆盖，都是「跨缝规定签名」的同型残留）：
  1. **站点 3 的 `{ upstreamSucceeded: true }` 无处安放**（`handler-v4.ts:1531-1536`）。它不是装饰——`fail` 的 TSDoc（`types.ts:620-627`）明说它决定「upstream leg 记 success:true、verdict 走 failureReason」。owner 失败时若一律丢掉，站点 3 的 History 归因会从「代理拒绝」翻成「上游失败」。
  2. **站点 1 的 `ctx` 可为 `undefined`**（`handler-v4.ts:691` 的形参类型是 `ReturnType<typeof codec.getContext>`，全篇用 `ctx?.`）。而 `classifyOwnerFailure` 需要 `ctx.settled` 才能分 `session-terminating` 的两支 → **ctx 缺失时的分类未定义**。
  3. **站点各自的原始诊断被 decision 的 error 覆盖**：站点 3 的「unrepairable tool_use」、站点 4 的「no message_stop」都是比 owner 的合成 Error 更精确的根因。结论没写「谁赢」。

→ 记为 **Major-8**。修法建议（不改性质）：`settleFromOwnerFailure(decision, ctx | undefined, model, partial?, opts?: { upstreamSucceeded?: boolean; cause?: unknown })`，并在 plan 里写死「owner 失败的 error 作为 settle 的 error，站点原诊断降为 `opts.cause`」或反之——二选一，但必须选。

### 2. 性质 5 —— 适配器里的 `ctx.abort` / `ctx.fail` 算不算「翻译层做了 ctx 侧收尾」？

**明确裁决：分两半，实质合规、字面违规、且漏了第三件事。**

- **实质：不违反。** 性质 5 的立法理由写在它自己的句尾——「翻译层**不做、也做不了**」。做不了的原因是纯函数拿不到 pump 的 `ctx` 与 `model`。而 ⑤ 的 `settleFromOwnerFailure` 住在 `handler-v4.ts` 模块级、由 pump 调用、吃 pump 传进去的 `ctx`/`model`/`partial` —— 它是 **pump 的一段被抽出来的代码**，不是翻译层。真正的翻译层 `classifyOwnerFailure`（`owner-failure.ts`）确实不碰 ctx 的 settle。判：**性质 5 的实质不被违反**。
- **字面：违反，必须改词。** ⑤ 的小标题是「**⑤ 翻译层：模块位置、签名、两个适配器**」，紧接着的子弹点写「**两个适配器**，各一份实现」。按字面读，`ctx.abort`/`ctx.fail` 就在「翻译层」里，与性质 5 的「翻译层不做」逐字矛盾。**这是指令文本**，后续每个站点照它做——实施者按字面理解会得出「性质 5 已被结论推翻」，或反过来「适配器不许碰 ctx，那谁碰？」。必须把 ⑤ 的措辞拆成两级：**翻译层 = `owner-failure.ts`（纯）**；**pump 侧收尾助手 = `handler-v4.ts` 的两个模块级函数（属 pump）**，并在 ⑤ 里显式写一句「后者属 pump 侧，性质 5 因此成立」。
- **漏的第三件事（真正的缺口）**：性质 5 列了三件必须由 pump 完成的事——`ctx` 的 abort、settle、**forwarded snapshot**。结论安排了前两件，**第三件一件都没安排**：适配器明写「绝不写任何帧」也不管 snapshot，而 ⑤ 的统一形状 `if (d) { settleFromOwnerFailure(d,…); return }` **没给 pump 留调用 `recordForwarded()` 的位置**。实测这不是理论问题：
  - 8 个站点今天全部是「`recordForwarded()` → `ctx.fail(...)`」的顺序（如 `handler-v4.ts:1435-1443`、`:1568-1576`），注释明写「a post-fail snapshot would miss it」；
  - 站点 1 更严重：`writeTerminalThenSettle` 的 `finally { ctx?.setForwardedResponse(...); settle() }`（`handler-v4.ts:695-700`）在早退后**仍会执行**，于是变成 **settle 先、snapshot 后** —— 与 `:683-694` 逐字写下的「Unit 1 (reduced) reorder」相反，而记忆库 `reference-settle-freezes-history-entry-record-before-fail` 正是说 settle 会冻结快照。

→ 记为 **Major-2**。修法：统一形状改为 `if (d) { recordForwarded(); settleFromOwnerFailure(d, …); return }`，站点 1 另需把 `closeAnchorViaOwner` 的早退移到 `finally` 之外（或让 `finally` 感知已 settle）。

### 3. 性质 4 —— `return` 之后真的不会再补第二个终局帧吗？短路能安全跳过各 pump 的 `finally` 吗？

**逐个站点实测后的裁决：帧层面安全，settle 与 snapshot 层面不安全。**

- **两个 pump 的 `finally { recordForwarded() }`**（`handler-v4.ts:1655-1657` / `:1806-1808`）：只调 `env.ctx.setForwardedResponse`，**不写任何帧** → 短路跳过它不会产生第二个终局帧。**性质 4 的字面要求在这里满足。** 但它在 settle 之后跑 → 该次 snapshot 落空（已并入 Major-2）。
- **站点 1 的 `finally { ctx?.setForwardedResponse(...); settle() }`**（`handler-v4.ts:695-700`）：`return` **跳不过它**（`finally` 语义）。后果两条：
  1. `settle()` 会**第二次**settle。实测靠的是 `ctx.settled` 去重（`types.ts:473-474`，`handler-v4.ts:729-731` 的注释亦称「the `settled` guard dedups」）→ 行为上不会双记，但 **⑤ 完全没提这条依赖**。「短路 = 立即结束终局路径」在这个站点其实是「短路 + 依赖一个未言明的幂等守卫」。指令文本必须写出来，否则实施者只要把 `settle()` 挪出 `finally` 就会踩双 settle。
  2. `if (frame) await sink.writeSynthetic?.(frame)` 在 `try` 内、被 `return` 跳过 → **不会有第二个终局帧**。✓
- **站点 2–8 跳过的 `sink.finalize?.()`**：两个 pump 调用点外层都有 `finally { sink.finalize?.() }`（`handler-v4.ts:577-580` / `:768-772`）→ **已验证为非问题**，不必写进 plan。
- **wire-torn 分支的副作用**：短路使客户端**收不到任何终止符**（原本要写的 `event: error` 帧被跳过）。这不是性质 4 禁止的「第二个」终局帧——preflight 的 wire-torn 意味着这次调用一个字节都没写——而是一个**未记录的行为裁决**，且与 C9 的「terminal error / close / finalize 仍可完成」有张力。→ **Major-6**，见 §三.1。
- **未被 ⑤ 覆盖的第三条出口：owner `throw`**。`closeOpenAnchor` 的非 client 写失败是 `throw DeliveryOwnerError`（`session.ts:415` 一带），**不进 `OwnerResult`**。站点 5（`:1607`）与站点 8（`:1798`）**本身就在 `catch (error) {` 块内、没有内层 try** → 该 throw 会直接逸出 pump。⑤ 的 `closeAnchorViaOwner` 只定义了「返回 undefined / 返回 decision」两种出口。→ **Major-7**。

### 4. 性质 6 —— handler 适配器覆盖全三支吗？`session-terminating` 且 ctx 已 settle 时「什么都不做」，forwarded snapshot 谁保？

**裁决：三支全覆盖 ✓；snapshot 不会丢，但结论的写法与既有形状分岔，应改。**

- **三支覆盖**：⑤ 的分类规则 `client-gone → {client-aborted}` / `wire-torn → {stream-error}` / `session-terminating → ctx.settled ? {delivery-finished} : {stream-error}`，与 driver 现行 `ownerFailureOutcome`（`driver.ts:937-943`，其中 `:938-940` 正是 `settled` 判据）逐条同构。**性质 6 满足。**
- **snapshot 归属**：`delivery-finished` 的前提就是 `ctx.settled === true`，而 settle 那一刻的 snapshot 已由**先前那个 settle 的一方**冻结（记忆 `reference-settle-freezes-history-entry-record-before-fail`）。所以**不存在无人保管的 snapshot**——此时任何 `setForwardedResponse` 本就是 no-op。这一点结论没说错。
- **但「什么都不做」是与既有形状的静默分岔**：两个 pump 现有的 `delivery-finished` 分支都写着 `recordForwarded(); return`（`handler-v4.ts:1387-1390`、`:1688-1691`）。⑤ 让 owner-failure 路径的同一语义只 `return`，未来读者会得到「同一个 outcome 有两种收尾」的错觉，也会掩盖 Major-2 的修法（统一形状本就该带 `recordForwarded()`）。→ **Minor-4**：把 ⑤ 的「不动」改写成「不 settle，但仍 `recordForwarded()` 后 `return`」。
- **附带核实**：`session-terminating` 在 M1 的 8 个站点上究竟可不可达，见 §二.5 的走查 F —— 这一支**分类正确但可能全程走不到**，两件事不要混。

### 5. 性质 8 —— 类型收紧替代两腿 positive control，被允许吗？4 个可达组合的真实 HTTP oracle 造得出来吗？

**裁决（前半）：被允许，且这是本节做得最扎实的一段。**

- 性质 8 的 ⚠️ 第一条明写：「若最终的类型设计已在类型层排除该组合（构造不出来），**腿二**改为类型级负测即可」。⑥ 的收紧 union 确实让 `{ok:false, reason:"wire-torn", committed:true}` 无法通过类型检查 → **腿二合规**。
- 性质 8 的 ⚠️ 第二条（写在腿一里）明写：「**若 producer 边界同样由类型排除该组合**，腿一也允许 compile-red」。producer 就是 `session.ts` 的 `ownerFailure(...)`（5 处，`:290/:291/:328/:413/:440`），收紧后它的返回类型即是同一 union → **腿一合规**。
- ⚠️ 的红线「不得为了满足『能构造』而把公共入参放宽成更松的类型」——⑥ 走的是**收紧**方向，没有触线。✓
- ⑥ 还自加了性质 8 没要求的一条正样本对照（「正反各一：合法组合必须编译通过，否则负测在测编译器而非测约束」）→ 这条应保留，它正是 `methodology-new-oracle-discriminating-power-is-experimental` 要的那种自证。
- **一处需补的措辞**：⑥ 说「C9 正文已写『wire-torn 统一返回 `committed:false`』，故这是把冻结契约写实、不是改契约」——已核 README C9（`README.md:58`）逐字为真，**该主张成立**。但收紧后 `ownerFailure` 的 5 个构造点里，`:291` 传的是变量 `finishReason ?? "session-terminating"`（`session.ts:291`），在新 union 下需要重载或对象字面量分支才能编译。⑧ 已把这条列为「留给实施者」，**可以接受**，但应升级为「实施者必须先写通这一处，写不通即回报」，因为它是收紧方案唯一的编译风险点。

**裁决（后半）：4 条真实 HTTP oracle 至少 1 条造不出来，1 条无先例 —— 该验收有落空风险。**

| 组合 | 从真实 HTTP 入口可构造？ | 依据 |
|---|---|---|
| `client-gone × true` | **可以**（较难但可做） | 由 `closeOpenAnchor` 的写失败 catch 产出（`session.ts:411-413`）。需客户端在 anchor stop 写出的瞬间断开；仓库已有 http 档中断客户端的先例 |
| `client-gone × false` | **可以** | 前一次失败后 `finishReason` 已是 `client-gone`，后续任一 owner 调用经 preflight（`session.ts:291`）产出。与上一格可在同一请求内先后拿到 |
| `wire-torn × false` | **无先例、需新造能力** | 需要一次**非 client** 的瞬时 write 失败先把 `wireTorn` 置真。现有唯一构造方式是 session 层塞一个会 throw 的假 sink（`tests/pipeline/allocation-real-block-refusal.it.test.ts:44-68`），**不是真实 HTTP 入口**。真实 HTTP 档下要让 Hono 的 SSE 写抛非 abort 错误，需要新的注入缝 |
| `session-terminating × false` | **基本不可构造**（走查 F） | `state` 变非 open 的唯一生产入口是 `session.terminate(...)`，唯一生产调用点 `session.ts:510` 挂在 `clientSink.finalize` 上；而 8 个 handler close 站点**全部先于**各自的 `sink.finalize?.()` 执行 |

**这不是「验收写高了」，是 M1 自己的规矩要求现在就处理**：plan 明写「若某 commit 的门实测不可满足…**停下回报**——不得靠手工补状态硬凑绿」。所以正确处置有且仅有两条，二选一并写进 plan：

- **(a)** 为 `wire-torn` 与 `session-terminating` 两支**降层但不降强度**：显式写「这两格的 oracle 在 owner/session 层构造（真实 delivery session + 可控 sink），另加一条真实 HTTP 档的 `client-gone` 双格 oracle 证明站点接线」，并注明降层理由与它证不到的东西（`aborted/failed` 分类可证，`forwarded snapshot` 仍需 History oracle）。
- **(b)** 承认需要新的注入能力（例如让测试可在真实 HTTP 档下令一次 sink write 抛非 abort 错误），把它作为 M1 的一个具名前置 task。

**不可接受的第三条路**：把「4 个可达组合各一条真实 HTTP oracle」原样留在文档里 —— 那样 M1 收尾时必然出现「两格填不上就默认放过」，正是 `pass-null-clean-not-self-validating` 那类假绿。

---

## 三、三处跨文档自洽的裁决

### 1. 结论 vs README 的 C9 / C10 / C11

**C9（commit point 与 `wireTorn`）—— 一处一致、一处张力。**

- **一致**：C9（`README.md:58`）逐字写着「五个 owner 入口此后统一返回 `{ok:false,reason:"wire-torn",committed:false}`」。⑥ 的类型收紧把这句写进类型，**是把冻结契约写实、不是改契约**，⑥ 的自我定性正确。实测支撑：`ownerUnavailable`（`session.ts:290`）确实写死 `false`；非 client 写失败走 `throw DeliveryOwnerError`、不进 union（`session.ts:332 / 417 / 444` 一带）。✓
- **张力（Major-6）**：C9 同句还写着 wire-torn「**禁止后续分配但不关闭 session，因此 terminal error / close / finalize 仍可完成**」。而 ⑤ 的统一形状在 wire-torn 时 `return`，把站点原本要写的 `event: error` 帧一并跳过 → 客户端拿到的是一条**没有任何终止符**的流。这可能是对的取舍（撕裂后再写只会加深协议不完整），但它是一个**未记录的裁决**，且与 C9 的措辞方向相反。plan 必须显式写出「wire-torn 下不再写终止符」及其理由，否则实施者会在 C9 与 ⑤ 之间自行选边。
- **另一处 C9 相关的确认**：转移表里「post-commit 写失败时 `anchorClosed` 保持 `false`」与 C9 档 ② 一致，且实测成立——`writeAllocationFrames` 的 `onCommit` 在首帧写出**之前**置 `openAnchorIndex`（`session.ts:352-354`），失败后不回退。✓

**C10（mapping token 生命周期）—— 无冲突。** 结论全程不碰 `mappings` / `writeBlockFrame`；⑥ 关于「missing mapping 直接 throw、不进 failure union」的表述与 C10（`README.md:59`）及 `session.ts` 的 `writeBlockFrame` 实现一致。✓

**C11（provenance 不无条件退化）—— 无冲突，但有一处需在 ⑤ 里点名。** ⑤ 要改 `ownerFailureOutcome` 的签名，其 5 个调用点全部是 `beginLeg` 失败位（`driver.ts:878/1022/1109/1523/1581`）——而 `beginLeg` 正是 C11 指定的「身份进入 wire state 的唯一入口」。签名变更是机械的、不影响 C11 的四类腿覆盖。✓ 但 ⑤ 现在的写法「其 **5** 个现有 `beginLeg` 调用点…随签名一并更新」把两个不同的东西说成一个（要改的是 `ownerFailureOutcome` 的调用点，只是它们恰好都紧跟 `beginLeg`，两者计数都是 5）→ **Minor-3**，改成「`ownerFailureOutcome` 的 5 个调用点（均位于 `beginLeg` 失败分支）」。

### 2. 结论 vs 本文件「迁移期双写的精确状态转移表」

**问题：结论说 owner 只写 `anchorClosed`，那表里 `anchorBlockOpen` 那几列由谁写？表还成立吗？**

**裁决：表的每一格取值仍然成立，但表的前言已经变成假命题，必须改。**

- **表体逐格复核（成立）**：
  - 「`allocateAndWriteAnchor` 成功」行的 `anchorBlockOpen = true` / `injected = true`：由 injector wrapper 在**入队前同步**发布（`keepalive-anchor.ts:333-335`）→ 操作结束后的取值确实是 `true`。✓
  - 同行的 `anchorClosed = false`（重新武装）：由 owner 在 commit 回调写（③ 指定），与 `openAnchorIndex` 同一回调（`session.ts:352-354`）。✓
  - 「preflight 拒绝」行的「四列全不变」：靠 injector 的 `restoreMirror()`（`keepalive-anchor.ts:327-332`，在 `!allocated.committed` 时调用）。✓
  - 「post-commit 写失败」行的 `anchorBlockOpen = true` 不回退：`restoreMirror` 在 committed 时不执行（`keepalive-anchor.ts:176-183` 一带的分支）。✓
  - 「`closeOpenAnchor` 成功」行：`anchorClosed = true` 由 owner 写（③），`anchorBlockOpen` 保持 `true` 无人改动。✓
  - `enveloped_ping`：走 `makeSyntheticEnvelopeInjector`，**完全不经 owner 分配端口**（`keepalive-anchor.ts:383-418`）→ 不产生表内任何一行。✓（走查 G）
- **前言已假（Major-4）**：表的前言（plan 第 96 行）写「M1–M4 期间 owner 是 legacy 字段的**唯一写者**；下表规定每个 owner 操作结束后**四个状态**的取值」。经 ③/④ 之后这句有**两处为假**：
  1. `anchorBlockOpen` 的写者是 injector（`keepalive-anchor.ts:335`）与 `live-reconcile.ts:138` 的关侧，不是 owner —— ④ 自己已经承认并改成三处 allowlist；
  2. `injected` 这一列 **owner 从来没写过**，从 P2 落地那天起就由 injector 写（`keepalive-anchor.ts:333`）—— 这一条 ③/④ 都没提到，是前言里更早就存在的错误。
  第 100 行的 ✅ 注只把「owner 维护 legacy 字段」重定义为「owner 只维护 `anchorClosed`」，**没有修正「唯一写者」这句**。指令文本里留一句与守卫（④）直接冲突的不变量，实施者按第 96 行去写守卫就会得到 ④ 明说「实测不可满足」的那个判据。→ 必须把第 96 行改写为「下表规定每个 owner 操作结束后四个状态的取值；写者按 ④ 的 allowlist 分工：`anchorClosed` 归 owner，`anchorBlockOpen`/`injected` 归 injector 开侧与 live-reconcile 关侧」。
- **表还缺一行（Minor-5）**：⑥ 已实测 `closeOpenAnchor` 的 client-gone 返回 `committed:true`（`session.ts:411-413`），表里也有这一行；但表**没有** `withAllocatedRealBlock` / `writeBlockFrame` 失败对四列的影响行。虽然它们确实不改这四个字段（`session.ts` 两处 catch 只置 `wireTorn` 或 finalize），但表已经列了「`withAllocatedRealBlock` / `beginLeg`（任何结果）→ 全不变」这一行，`writeBlockFrame` 却漏了 → 补一格，零成本。

### 3. 结论 vs M1 那一行 commit 表的「可满足的门」

M1 的门原文：**owner 单元测试（连续两轮 open/close、close 幂等、终局 exactly-once）+ 8+2 站点各自的 close 路径回归 + O-6 字节等价（证零行为变化）**。

| 门里的项 | 结论对它的影响 | 裁决 |
|---|---|---|
| 「8+2 站点」 | ① 把真实站点数改成 12，其中 M1 归属仍是 8 handler + 2 driver | **一致**，门的口径未变 ✓ |
| 「终局 exactly-once」 | **被结论变成不可满足** —— 站点 11（M2）与站点 12（M4）继续以 legacy 方式写 `stop@0` 且**不清 `openAnchorIndex`**，而站点 1–10 改由 owner 关。同一个 anchor 被两套机制关两次 | **Blocker-1** |
| 「close 幂等」 | 逐站点表第 277 行明写「**exactly-once 由 API 保证**…这取代了原先跨站点共享 `anchorClosed` 的手工幂等」。该断言只在**所有关闭者都走 owner** 时成立，M1 结束时并不成立 | **Blocker-1 的成因**：文档主动指示实施者拆掉唯一还在生效的那道幂等 |
| 「O-6 字节等价（证零行为变化）」 | O-6 的论域是**无-anchor 主腿**（README `:131` / C3 修订表 `:84`）→ 它对「有 anchor 且双写 stop」结构性失明 | **Minor-1**：门里「证零行为变化」这句给了 O-6 它证不到的信用；应写明 O-6 只覆盖无-anchor 主腿，有-anchor 的零变化要靠站点回归 |
| M1 终态不变量「生产行为零变化」 | 被 Major-3 破坏（driver 站点 9/10 的无条件 `sink.close?.()` 退化为条件性 `closeHeartbeat`） | **Major-3** |
| 门里没有、但结论新增的负担 | ⑤ 新建 `owner-failure.ts` 会命中 master 的 stream-error mint 守卫（`tests/architecture/package-boundaries.unit.test.ts:590-621`），而该守卫在 `test:fast`（`package.json:54` = unit + http）里 → commit invariant「`test:fast` 绿」不可满足 | **Blocker-2** |

**结论有没有让某个门变得多余？** 没有。⑥/⑦ 增加的是新验收层（翻译层 unit + 站点接线），与原门正交，不替代任何一项。

---

## 四、事实性发现（按严重级别）

### Blocker

**[blocker] B1 — `plan-3-remap-sites.md` ① 的 M1/M2/M4 站点切分会写出两个 `content_block_stop@0`，M1 的 exactly-once 门不可满足**

- **证据**：owner 的 `closeOpenAnchor` 只在**成功写出 stop 之后**清 `openAnchorIndex`（`src/lib/pipeline/delivery/session.ts:407`），且它对是否已关的唯一判据就是 `openAnchorIndex === undefined`（`:399`）。而 ① 判给 M2 的站点 11（`src/lib/pipeline/driver.ts:1239-1244`）与判给 M4 的站点 12（`src/lib/anthropic/live-reconcile.ts:138` + 装饰器 `:172-173`）在 M1 之后**继续以 legacy 方式**置 `anchorState.anchorClosed = true` 并经 `writeAnchor` 直接写出 `stop@0`——**完全绕过 owner，`openAnchorIndex` 原封不动**。
- **失败场景（两条，均为一等公民路径）**：
  - live 腿（当前生产默认 `protect_streaming_generation: false`）：anchor 注入 → `reconcileLiveFrame` 在首个真实块前关掉它（`live-reconcile.ts:129-140`）→ 上游截断 → pump 站点 4（`handler-v4.ts:1553`）按 ⑤ 调 owner → owner 见 `openAnchorIndex` 仍为 0 → **第二个 `stop@0`**。
  - buffered 腿：flush 内站点 11 关掉 anchor → 上游截断不可重试 → driver 站点 10（`driver.ts:1609`）调 owner → **第二个 `stop@0`**。
- **为什么不是「实施者自然会注意到」**：plan 第 277 行明写「**exactly-once 由 API 保证**…这取代了原先跨站点共享 `anchorClosed` 的手工幂等」，即文档**主动指示**拆掉唯一还在生效的那道跨站点幂等；而 plan 第 234 行的「原子迁移红线」是按**站点**表述的（「同一 close 站点的 legacy write 与 owner close 不得并存」），恰好读不出「12 个站点关的是**同一个** anchor」这层。真正的红线应按 **anchor** 表述。
- **既有 oracle 咬不咬得住（已核）**：`tests/pipeline/anchor-multiblock-lifecycle.it.test.ts:494` 的 `expect(stop0s).toHaveLength(1)` 场景里两次关闭都来自站点 11（legacy↔legacy），M1 后仍绿；`tests/anthropic/live-pump-terminal-anchor-closeoff.http.test.ts` 覆盖的是「错误发生在**首个真实块之前**」（reconcile 尚未关）——也躲开了。**未找到覆盖「legacy 关过、owner 再关」的现存 oracle**（搜索范围：`tests/pipeline/anchor-*`、`tests/anthropic/*anchor*`，关键词 `stop0`/`content_block_stop`/`toHaveLength(1)`）→ 该缺陷会静默落盘。
- **修复方向（供参考，不代表已裁决）**：三选一并写进 plan —— (a) 迁移期 `closeAnchorViaOwner` 保留完整 legacy 前置守卫 `injected && anchorBlockOpen && !anchorClosed`，并删掉第 277 行那句「取代手工幂等」；(b) 让站点 11/12 的 legacy 关闭同步清 `openAnchorIndex`（即把 legacy 关闭也纳入 ④ 的 allowlist 并加一格转移表）；(c) 把站点 11、12 一并提前到 M1（代价是 M1 变大，但符合「按 anchor 原子」的红线本意）。

**[blocker] B2 — `OwnerTerminalDecision` 的 `kind: "stream-error"` 必然触发 master 的 mint 守卫，M1 的 `test:fast` 门不可满足**

- **证据**：`tests/architecture/package-boundaries.unit.test.ts:590-621` 的判据是 **AST 级**的——「`src/` 下任何 `kind: "stream-error"` 的**对象字面量**，若其最近的外层函数名不是 `streamErrorOutcome`（`:708` `MINT_HELPER`），即 offender」。它显式覆盖 `as const`、字符串键、计算键、同文件 const 转发等写法（`:628-644` 的注释逐条列出）。
- **为什么必然命中**：⑤ 要求新建 `src/lib/pipeline/delivery/owner-failure.ts`，其 `OwnerTerminalDecision` 含 `{ kind: "stream-error"; error: Error }`。**类型声明**是 TypeLiteral、不被守卫看见，但 `classifyOwnerFailure` **构造**该决定时必然写出一个对象字面量 → offender。预过滤 `if (!text.includes("stream-error")) continue`（`:605`）也拦不住——该文件必然含这个串。
- **门为什么因此不可满足**：`package.json:54` `"test:fast": "bun scripts/parallel-test.ts unit http"`，该守卫是 `.unit.test.ts` → 在 M1 的 commit invariant「`bun run test:fast` 绿」之内。
- **讽刺点（值得记进 plan）**：⑤ 正是**引用这条守卫**作为「不返回 `ResponseOutcome`」的理由，却只推理了「不要搬走 mint 点」，没读守卫的**实际判据是字面量而非类型**。这与本节自陈的「三次跨缝规定行为」同型——只是这次缝的另一侧是一个测试。
- **修复方向**：(a) 把 decision 的判别式改名（如 `kind: "fail-loud"` / `"loud-error"`），语义上也更准确——它是「站点该怎么收尾」，不是一个 `ResponseOutcome`；(b) 或扩守卫的 allowlist，但需同时扩它的正样本对照，代价与风险都高于 (a)。**倾向 (a)**，且它顺带消除了「两个不同类型共用同一个字面量」的读者混淆。

**[blocker] B3 — 性质 7 未满足：`recordFeature` 不落 History，⑦ 的支撑事实为假**

- **⑦ 的原话**：「它已随 `request.feature_applied` 进 History 与 observability 事件（`events.ts:231`），满足『落到持久载体』」。
- **实测反证（四条独立证据）**：
  1. `recordFeature` 的实现（`src/lib/context/request.ts:2109-2116`）只做一件事：`publisher?.publish({ kind: "request.feature_applied", ... })`。**不写 ctx、不写 entry**。
  2. `HistoryEntryData`（`src/lib/context/types.ts:312-383`）**没有** features / tags 字段。
  3. `request.feature_applied` 的全部消费者：`src/lib/observability/sinks/ws.ts:129`（活体 WS 广播给 UI）、`src/lib/tui/active-request-store.ts:110`（TUI 内存 store）。`sinks/telemetry.ts` 不处理该 kind。
  4. 项目自己的测试写着结论：`tests/context/request-emit-methods.unit.test.ts:7` ——「`recordFeature` publishes `request.feature_applied`（**no ctx mutation**）」。
- **后果**：`wire-partial-delivery` 这个 marker 在请求结束后**不复存在**，事后无法回答「这条流的 stop 是不是已经部分上线」。性质 7 的立法理由正是「动作相同但**证据不同**」——证据一旦不持久，这条性质等于没做。
- **修复方向（都在既有机制内，不必发明字段）**：(a) `HistoryEntryData.warningMessages`（`types.ts:326`）是**已持久**的 request-scoped 载体，语义也贴（「有字节可能已部分上线」是个值得留痕的告警）；(b) 或走 `clientResponse` 腿加一个布尔/枚举字段（需确认投影链路）；(c) 若坚持用 `FeatureKind`，则必须**同时**把 feature 落进 entry —— 那是一次独立的可观测性改造，应作为具名前置 task，不能夹带。**无论选哪条，选定前不得开工**，因为性质 7 明说「不得留给站点各自选择表达方式」。

### Major

**[major] M-1 — `closeAnchorViaOwner(sink, anchorHooks, anchorState)` 的签名拿不到 `ctx`，却被要求返回需要 `ctx` 才能算出的 decision**

- **证据**：⑤ 定义 `closeAnchorViaOwner(sink, anchorHooks, anchorState)` → 失败时「返回 `OwnerTerminalDecision`」。而 `OwnerTerminalDecision` 的产出者 `classifyOwnerFailure(failure, operation, ctx)` 需要 `ctx.settled`（分 `session-terminating` 两支）与 `ctx.recordFeature`（⑦ 的 partial-delivery 记录）。**参数表里没有 ctx。**
- **为什么这条要单列**：本节第 104 行自陈「三次都是在没读过调用点两侧的情况下跨缝规定行为」，并宣布「本节不再规定签名——签名要读完站点与 pump 返回类型才能定」。① 和 ② 确实把两侧读了，但 ⑤ 最终**又写下了一个自拟签名**，且它缺的正是上一轮被指出过的同一类东西（上一轮缺 `env.clientFormat`，这一轮缺 `ctx`）。
- **附带的第二个缺口**：站点 1 的 `ctx` 是 `ReturnType<typeof codec.getContext>`，全篇以 `ctx?.` 使用（`src/routes/messages/handler-v4.ts:691-700`）→ **可为 `undefined`**。`ctx` 缺失时 `session-terminating` 该判哪一支，⑤ 没有答案。
- **修复方向**：`closeAnchorViaOwner(sink, anchorHooks, anchorState, ctx)`，并在 plan 里写死「`ctx` 为 undefined 时 `session-terminating` 视为未 settle（走 loud）」或反之——二选一，但必须选。

**[major] M-2 — 统一形状丢掉了「settle 前 `recordForwarded()`」，站点 1 更被倒置成「settle 先、snapshot 后」；性质 5 的 forwarded snapshot 无人负责**

- **证据**：8 个站点今天全部是 `recordForwarded()` → `ctx.fail(...)`（如 `handler-v4.ts:1435-1443`、`:1568-1576`、`:1740-1742`），注释明写「a post-fail snapshot would miss it」。⑤ 的统一形状 `if (d) { settleFromOwnerFailure(d, …); return }` 中间没有 snapshot 位。
- **站点 1 更严重**：`writeTerminalThenSettle` 的 `finally { ctx?.setForwardedResponse(...); settle() }`（`handler-v4.ts:695-700`）在早退后仍会执行 → 顺序变成 settle→snapshot，与 `:683-694` 逐字写下的「close anchor → writeSynthetic → setForwardedResponse → fail」相反。settle 冻结快照这一事实见记忆 `reference-settle-freezes-history-entry-record-before-fail`。
- **失败后果**：owner 失败发生在 anchor stop 的**写尝试**之后时，该 stop 已按「recorded == attempted-to-send」采样进 `forwardedSseEvents`（`handler-v4.ts:688-694` 的注释），却因 snapshot 落空而进不了 History —— **这正是性质 7 想留住的那份证据**，两个缺口叠加后 partial-delivery 在 History 上彻底不可见。
- **修复方向**：统一形状写成 `if (d) { recordForwarded(); settleFromOwnerFailure(d, …); return }`；站点 1 另需把早退移出 `finally` 的辖域，或让 `finally` 感知已 settle。

**[major] M-3 — driver 站点 9/10 的无条件 `sink.close?.()` 在 owner 路径下退化为条件性 `closeHeartbeat`，M1 的「行为等价」不变量被破坏**

- **证据**：`src/lib/pipeline/driver.ts:1181-1193` 的 `closeAnchorIfOpen` 把 `sink.close?.()` 放在 `if` **之外**（`:1182`），即**无论有没有 anchor 都停心跳**；注释 `:1174-1176` 明写理由「`close()` first so no ping/anchor can fire between here and the stop write」。而 owner 的 `closeOpenAnchor` 在 `openAnchorIndex === undefined` 时于 `session.ts:399` 直接 `return "none"`，**永远走不到 `:400` 的 `closeHeartbeat()`**；`clientSink.close` 正是 `closeHeartbeat`（`session.ts:469`）。
- **失败场景**：无 anchor（绝大多数请求）+ driver 走 `:1438` 或 `:1609` 的失败返回 → 心跳仍在跑 → 在 driver 返回与 handler 写出 error 帧之间可能插入一个 ping，甚至触发 anchor 注入。
- **为什么 O-6 咬不住**：O-6 是短请求字节等价（README `:131`），不含 idle 窗口。
- **修复方向**：M1 迁移站点 9/10 时显式保留 `sink.close?.()`（或改调 `closeOpenAnchor` 前先 `sink.close?.()`），并在 plan 里写出这条不对称性——handler 侧的 legacy primitive 是**条件性** close（`keepalive-anchor.ts:259-265`，`sink.close?.()` 在 `if` 内），driver 侧是**无条件**，两者不能用同一句话概括。

**[major] M-4 — 转移表前言「owner 是 legacy 字段的唯一写者」在 ③/④ 之后已成假命题，且对 `injected` 一列本就为假**

- **证据**：plan 第 96 行的前言 vs ④ 自己给出的三处 allowlist；`anchorBlockOpen` 的实际写者是 `keepalive-anchor.ts:335` 与 `live-reconcile.ts:138`；`injected` 的写者是 `keepalive-anchor.ts:333`（owner 从未写过它）。第 100 行的 ✅ 注只重定义了「owner 维护 legacy 字段」，没有触及「唯一写者」这句。
- **失败场景**：实施者按第 96 行写守卫 → 得到 ④ 明说「M1–M4 实测不可满足」的那个判据 → 门当场红，或被改成「先豁免」。
- **修复方向**：改写第 96 行，明确写者分工，并在 ④ 与它之间加交叉引用。

**[major] M-5 — 「4 个可达组合各一条真实 HTTP 入口 oracle」至少一条不可构造、一条无先例**（详见 §二.5 的表与两条处置路径）

**[major] M-6 — wire-torn 下短路使客户端收不到任何终止符，与 C9「terminal error 仍可完成」的措辞相反，且未记录**（详见 §三.1）

**[major] M-7 — `closeAnchorViaOwner` 未定义 owner `throw DeliveryOwnerError` 的处置，而站点 5 / 8 本身就是无内层保护的 `catch` 块**

- **证据**：非 client 写失败在 owner 侧是 `throw new DeliveryOwnerError(...)`（`session.ts:415` 一带、`writeAllocationFrames` 同形），**不进 `OwnerResult`**（转移表已写明）。站点 5（`handler-v4.ts:1607`）与站点 8（`:1798`）位于各自 pump 的 `catch (error) {` 块内，块内**没有**内层 try。
- **失败场景**：该 throw 逸出 pump → 逸出 `streamSSE` 回调；ctx 是否已 settle 取决于逸出时机 → 可能留下未 settle 的悬挂请求。
- **注意**：这不完全是新增风险（今天 `closeAnchorIfOpen` 的 `writeAnchor` 也没有 catch），但 M1 改变了抛出物与抛出条件，plan 作为指令文本必须写明各站点对 throw 的处置。

**[major] M-8 — 8 个站点的 settle 语义差异未被适配器吸收：站点 3 的 `upstreamSucceeded` 丢失、站点 1 的 ctx 可空、站点原始诊断与 owner error 的优先级未定**（详见 §二.1 的站点表）

### Minor

**[minor] m-1 — M1 门里「O-6 字节等价（证零行为变化）」给了 O-6 它证不到的信用**。O-6 的论域是**无-anchor 主腿**（README `:131`、C3 修订表 `:84` 已把「引用相等」收窄到无-anchor 主腿）→ 对「有 anchor 且双写 stop」「有 anchor 且心跳未停」结构性失明。门里应写明 O-6 的覆盖边界，并把有-anchor 的零变化明确挂到「8+2 站点回归」上。

**[minor] m-2 — 陈旧行号未在声称逐行核对的范围内被修正**。转移表下方「三条承重解读」引用 `types.ts:444` 作为 `anchorBlockOpen`「stays TRUE for the whole stream once set」的出处；实测该注释在 `src/lib/pipeline/types.ts:536-538`，`:444` 是 `AnchorHooks.remap` 一带。① 的方法论段落自陈已通读 `types.ts:461-544`（涵盖 536）→ 这处本该顺手改掉。

**[minor] m-3 — ⑤ 的「其 5 个现有 `beginLeg` 调用点…随签名一并更新」把两件事说成一件**。要改的是 `ownerFailureOutcome` 的 5 个调用点（`driver.ts:878/1022/1109/1523/1581`），只是它们恰好都紧跟 `beginLeg`；`beginLeg` 自身也是 5 处，两个计数巧合相同 → 数字无误但表述会诱导实施者去改 `beginLeg`。

**[minor] m-4 — ⑤ 的 `delivery-finished` 写「不动」，与两个 pump 既有的同名分支（都会先 `recordForwarded()`，`handler-v4.ts:1387-1390` / `:1688-1691`）形成静默分岔**。应改成「不 settle，但仍 `recordForwarded()` 后 `return`」。

**[minor] m-5 — 转移表缺 `writeBlockFrame`（任何结果）那一行**。表已列了「`withAllocatedRealBlock` / `beginLeg`（任何结果）→ 四列不变」，`writeBlockFrame` 同样不改这四列（`session.ts` 的两处 catch 只置 `wireTorn` 或 finalize）却被漏掉。补一格零成本，且能避免 M2–M4 时有人以为它有影响。

### Nit

**[nit] n-1 — ⑧ 把 `OwnerOperation` 的字面量集合留给实施者，但 ⑦ 已经把它写进 `FeatureKind` 的 detail 契约**（`detail: { operation: OwnerOperation, reason: OwnerFailureReason }`）。实测全仓无 `OwnerOperation` 定义（`grep -rn OwnerOperation src/ tests/` 零命中，仅 docs 中出现）→ 它是新类型。契约既然已冻结形状，集合本身也宜同时冻结，否则 History/事件消费者拿到的是一个未定义值域。

**[nit] n-2 — ⑦ 让 `classifyOwnerFailure` 承担 `recordFeature` 副作用，与 ⑤ 把它定位为「叶子模块，只 `import type`」的纯度描述不一致**。类型上没问题（`OwnerFailureContext` 已声明 `recordFeature`，且方法参数双变使真 ctx 可赋值），但「纯分类器」这个称呼与实际职责不符——按项目「命名反映实际职责」的约定，要么改称呼，要么把记录动作上移到两个适配器（⑦ 选择放在分类器是为了「唯一记录一次」，理由成立，那就改称呼）。

---

## 五、主观建议（不是事实性缺陷，取舍留给调用方）

**[建议] ① 的站点编号与「逐站点 close 迁移」旧表编号冲突** —— 旧表（保留作「改法参考」）里 #9 = driver 终端（真实 `:1609`）、#10 = 失败返回前（真实 `:1438`）；新 ① 里 #9 = `:1438`、#10 = `:1609`，**两表的 9/10 互换**。预期影响：实施者以「站点 9 已迁」记录进度时，两张表指的不是同一处，跨会话交接尤其危险。推荐做法：把旧表的编号列整体删掉（只留「站点 / 改法」两列），编号权威唯一归 ①。

**[建议] 把「原子迁移红线」从按站点改写为按 anchor** —— 现文（第 234 行）「同一 close 站点的 legacy write 与 owner close 不得在任何可提交中间态并存」。预期影响：B1 正是「不同站点、同一 anchor」这个被漏掉的维度；改写后同类错误在 M2/M4 不会再犯。推荐做法：改为「**同一个 anchor 的所有关闭者**不得跨 legacy / owner 两套机制并存；若必须并存，legacy 关闭必须同步清 `openAnchorIndex`」。

**[建议] `OwnerTerminalDecision` 改名，顺带解决 B2** —— 当前判别式 `client-aborted` / `delivery-finished` / `stream-error` 三个值全部与 `ResponseOutcome` 的 kind 同名，而它们是**不同的类型、不同的语义层**（一个是「driver 的控制信号」，一个是「站点该怎么收尾」）。预期影响：改名同时消除守卫冲突（B2）与读者混淆，成本仅一次替换。推荐做法：`{ kind: "settle-aborted" } | { kind: "already-settled" } | { kind: "settle-failed"; error: Error }`。

**[建议] 把「结论与代码不符时以代码为准并停下回报」升级为具名 checkpoint** —— ① 的方法论段落已有这句，但它是散文。预期影响：本次评审在 ①③⑥ 的行号上核到的准确率很高（几乎全部精确命中），说明调查确实读了两侧；真正出问题的是 ⑤ 和 ⑦ 这两段**没有对应「读了哪一侧」记录**的部分。推荐做法：在 ⑤ / ⑦ 各补一行「本段依据的两侧分别是 X 与 Y」，缺一侧就不许落笔——这正是本节自己总结的教训的可执行版本。

**[建议] ⑥ 的类型收紧值得单独一个 commit 先落** —— 它是本节质量最高的一段（机制性证明扎实、降级合规、自加正样本对照），且与 B1/B2/B3 三个 blocker 完全正交。预期影响：先落它可以让后续讨论在一个已收紧的类型基础上进行，也避免它被 blocker 的返工波及。推荐做法：作为 M1 的第一个子 commit（含 `session.ts:291` 那处构造点的重载/字面量改写 + 类型级负测正反各一）。

---

## 六、给调用方的一句话

本节的 ①（站点清单）、③（供给缝裁决）、④（守卫修正）、⑥（六组合 disposition）是**扎实的、经得起逐行核对的调查产出**——行号几乎全部精确命中，两个「不可达」的机制性证明成立。问题集中在 ⑤ 和 ⑦：这两段**又一次在没有读完缝的另一侧的情况下写下了具体形状**（⑤ 引用守卫却没读守卫的判据、自拟签名却漏了 `ctx`；⑦ 断言「进 History」却没查 `recordFeature` 的落点），与本节第 104 行自己记录的三次翻车**完全同型**。建议把这条模式本身也记进教训：**「引用一个守卫 / 一个既有机制作为论据」与「跨缝规定行为」是同一类风险——引用之前必须打开它读判据，而不是读它的名字。**
