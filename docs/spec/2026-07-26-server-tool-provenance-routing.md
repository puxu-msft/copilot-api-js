# 响应侧 server-tool 块按来源分流：客户端声明的原样转发，我方注入的降级保留

日期：2026-07-26（**2026-07-29 全文重写为 v2**，取代被对抗评审判为「应重新设计」的 v1）
状态：**已定稿，待用户裁决是否起实施**（经 5 轮异模型对抗评审，终轮 0 blocker / 0 major；逐条处置见 §0–§0.4，评审原文见 [评审合集](2026-07-26-server-tool-provenance-routing-review.md)）
**尚未实施** —— 本文档只描述目标状态，代码一行未动。
前置：[2026-07-26-thinking-terminal-block-layout.md](2026-07-26-thinking-terminal-block-layout.md)（触发事故与三条上游布局约束 C1/C2/C3，已 landed）
交接：[../plan/2026-07-27-handover-server-tool-provenance.md](../plan/2026-07-27-handover-server-tool-provenance.md)（v1 评审结论、实测记录、踩坑清单）
相关 ADR：[server_tool 定位与 web_search 退役](../decisions/2026-07-13-server-tool-positioning-and-web-search-retirement.md)、[richest-data-flow](../decisions/2026-07-05-richest-data-flow.md)
相关 skill：`ghc-anthropic-upstream`、`client-proxy-e2e-testing`、`empirical-verification`

---

## 0. v2 相对 v1 改了什么（评审意见处置表）

| 评审项 | v1 的问题 | v2 的处置 | 章节 |
|---|---|---|---|
| CRITICAL-1 | 复用 `stringifyServerToolResultContent`，它是 web-search 专用的，对 `tool_search_tool_search_result` 谎报 `"Web search failed: unknown"` + `isError:true` | 定义**穷尽式** `renderServerToolTranscript` 契约，覆盖 SDK 全部 6 类 `*_tool_result` 与未知类型；`isError` 只由 `_error` 判别式决定，绝不由「content 不是数组」推断 | §5 |
| CRITICAL-2 | 「历史含 `server_tool_use` 就无条件重新声明该 server tool」—— 信息上不可能（历史里没有声明的 `type` 与参数） | 放弃重建。改为**共享判据 + 既有 learned downgrade 反应式兜底**，并补上兜底当前认不出的第二种 400 措辞 | §7.1 / §7.4 |
| CRITICAL-3 | 未收窄客户端格式，隐含所有 clientFormat 都走同一逻辑；而 CC/Responses 的 `originalRequest.tools` 是有损投影、且它们的翻译腿本就丢弃 server-tool 块 | 收窄到 `clientFormat === "anthropic"`；其余格式保持**当前行为逐字节不变**，语义归 Phase 6 另立 spec | §3 |
| HIGH-4 | provenance 判据只写「在不在 `originalRequest.tools` 里」，未处理同名 custom function 冒充、未处理 `caller.tool_id` 嵌套 | 补 typed-declaration 判据表（name → 合法 type 前缀）+ invocation graph + `caller.tool_id` 传播 + 五条 fallback | §4 |
| HIGH-5 | 只有一句「N 块 → 1 块」，无逐事件算法 | 完整状态机：状态定义、逐事件动作表、索引分配规则、7 类边界、非流式对应算法 | §6 |
| HIGH-6 | 未定义与请求侧 learned strip / downgrade 的优先级 | 优先级矩阵 + 根因修复（`stripServerTools` 与 pair-downgrade 共用同一判据函数，消除时序错位） | §7 |
| MED-7 | 只列了 3 个标记落点，且非流式无标记机制 | 4 个落点（含 WS 腿）+ 非流式三重机制（in-band 前缀 / ctx 侧信道 / 双轨 diff） | §8 |
| HIGH-8 | 验收标准无 e2e 两轮、无冻结 fixture、无 positive control、无前端构建门 | 12 条验收标准，每条带**证伪方式** | §10 |

**未采纳 / 修正评审意见的地方**（`record-not-adopted`）：

- 评审建议「原样转发分支必须保持原 upstream index、不进 densify」。**修正后采纳**：只要本次响应发生过任何降级，索引就必然整体前移，「保持原 index」不可能成立。v2 采用的等价且可执行的不变量是——**当本次响应没有任何降级时，客户端索引与上游索引逐一相等**（identity），由 golden 锁定（§6.4）。
- 评审提示「新 union 成员会打爆 ui-v4 的穷尽 `Record`」。**复核后修正**：实测 grep（`ui-v4/src` 与 `ui/src` 全量）显示两个前端对 synthetic kind 都**没有**穷尽 `Record` —— ui-v4 的 [SseEventsSegment.tsx:37-39](../../ui-v4/src/components/detail/segments/SseEventsSegment.tsx#L37) 直接把 `f.synthetic` 当字符串渲染，Vue `ui/` 的 [SseEventsSection.vue:116](../../ui/src/components/detail/SseEventsSection.vue#L116) 只与 `"keepalive"` 做字面量比较。故本次新增 kind **预期不会**打爆任一前端。但仍把前端 typecheck + build 列为权威门（§10-12），因为根 `typecheck` 不覆盖 ui-v4，而「预期」不是证据。
  **同时修正一处踩坑**：交接文档与旧记忆里的 `build:ui` 指的是 **Vue 的 `ui/`**（`package.json:39` = `cd ui && bun run build`）；React 的 ui-v4 对应脚本是 **`build:ui-v4`**（`package.json:40`）。本 spec 一律写 `build:ui-v4`。

---

## 0.1 首轮对抗评审处置表（2026-07-29，`gpt-souls:reviewer`，异模型）

结论：**0 blocker / 5 major**，报告见 [评审合集](2026-07-26-server-tool-provenance-routing-review.md)「第 1 轮」。5 条**全部采纳**，其中 2 条在采纳修法的同时**修正了它给的因果链**（先亲自复核 `file:line` 再采纳，见下）。全部为 **C 级**（落进产物、可逆），无 A/B 级 —— 不涉及改变用户裁决、ADR 或指令类文本。

| # | 发现 | 处置 | 级别 | 落点 |
|---|---|---|---|---|
| M1 | provenance graph 未定义 forward reference 与环，可能不终止或误降级 | **采纳，但换了修法**：不采用「缓冲到父出现」（那要求为保序扣住后续所有块，把流式退化成半阻塞、代价落在每个正常响应上），改为**显式 `UNRESOLVED`/`CYCLE`/`DEPTH_EXCEEDED`/重复 id 四条确定动作 + 保守降级 + 警告 + 观测钩子**，并把「保守但有损」按评审要求写明 + 补验收。评审自己也把这列为可接受的备选 | C | §4.3、§4.3.1、§4.4、§10-14 |
| M2 | `flush` 只处理无结果 invocation，遗漏「结果已 start 未 stop」→ 整对静默丢失 | **全采纳，这是真 bug**。flush 遍历范围改为「所有未发射单元」并分三形态渲染 | C | §6.2、§6.3、§10-13 |
| M3 | 「JSON 序列化天然不产生 `<invoke`」是错的，`<` 不被 JSON 转义 | **采纳修法**（改为可验证的 `&lt;` 编码契约 + 禁止反向 decode + 回流验收）。**但修正其因果链**：评审称 recover-tool-call 会把 transcript 重建成假 `tool_use` —— 核后**不成立**，recover 是 order 100、filter 是 order 300，recover 跑在前面看不到 transcript；回流时它以请求身份出现，而请求侧没有 recover。**真实可达的腿是 `removeAnthropicSystemReminders`**（确会编辑 assistant text，[system-reminders.ts:76-86](../../src/lib/anthropic/sanitize/system-reminders.ts#L76)）。编码仍要做 —— 我方输出会回流，且「现在够不着」不是安全论据 | C | §5.4-2、§10-5b |
| M4 | §12 影响面漏文件（策略更名连带点、共享 helper 消费者、config 全链） | **全采纳**。它给的每个 `file:line` 我都实地核过，全部属实 —— **我的 C11 断言是错的**。§12 重写为按接线分组的穷尽清单，并额外发现 config 更名涉及**对外契约**（`configKey`），按「配置哲学独立」要求保留兼容层 + warn 继续 | C | §12（全节重写） |
| M5 | 多条验收标准在错误实现下会假绿 | **全采纳**：AC1 改逐字段深等于 + mutation；AC6/AC9 要求**改动前冻结** raw-byte oracle（禁止由新实现重生成）；AC7 要求独立 oracle + 真实 retry-hint 路径；AC9 分别点名三个象限的真实测试文件。另加「positive control 必须先证明 mutation 真的生效」的元要求 | C | §10 全表 + 表后元要求 |

**评审未提但本轮自查补上的**：§10-13（flush 三形态的 positive control 指定 mutation = 「改回 v2 初稿的遍历范围」）。

## 0.2 第二轮复评处置表（同一 reviewer 续跑）

结论：**0 blocker / 3 major**，报告见 [评审合集](2026-07-26-server-tool-provenance-routing-review.md)「第 2 轮」。3 条**全部采纳**。两处争议中，它**接受**了我对 M3 因果链的修正，**驳回**了我对 M1 的驳回 —— 而它是对的（见下）。全部 C 级。

| # | 发现 | 处置 | 级别 | 落点 |
|---|---|---|---|---|
| R2-M1 | 「不缓冲」的代价论证不成立；保守降级会在可构造序列上破坏「客户端声明则原样转发」这条已决语义 | **采纳，我的论证确实错了**：缓冲是**条件触发**的，正常响应零代价，我却写成「代价落在每一个正常响应上」——**用一个不存在的成本去否决语义完整的方案**。改为局部缓冲。**并在其建议之上补一条它未考虑的**：缓冲必须有**硬上界**（时长/帧数/字节），因为缓冲期的静默正落在 keepalive 失守窗口，已有约 300s 被客户端掐断的实测。探针从「设计裁决门」降为「优化门」，两种结果都不阻塞实施 | C | §4.3.1（全节重写）、§4.4-3、§10-14 |
| R2-M2 | `emitted: Set<serverToolUseId>` 与「重复 id / 重复 result 各自独立发射」自相矛盾，会吞单元 | **全采纳，这是我引入的真矛盾**。emission identity 改为 **upstream index**；`tool_use_id` 降为只做关联与 duplicate 标注 | C | §6.2 红框、§10-15 |
| R2-M3 | 伪代码入口域未封闭（畸形 `caller` 直接抛）；§4.4 未声明 first-match，多行可同时命中导致归因不确定 | **全采纳**。伪代码加 0 号入口形状校验 + 有序互斥分支；§4.4 重写为 7 行 first-match 表。**一处我做得比建议更细**：未知 `caller.type` **只要带有效 `tool_id` 就照常继承**（继承语义与 type 取值无关），避免 SDK 新增 caller 类型平白触发降级 | C | §4.3（伪代码重写）、§4.4（全表重写）、§10-16 |

**两处争议的收口**：M3 因果链修正**被接受**（recover order 100 < filter 300，确实够不着；真实腿是请求侧 system-reminder 清理）。M1 我**接受被驳回** —— 我的性能前提被代码路径推翻，这是一次我该认的错：拿「代价」当理由否决正确方案，正是本项目明令禁止的那种论证。

## 0.3 第三轮复评处置表（同一 reviewer 续跑）

结论：**0 blocker / 3 major**，报告见 [评审合集](2026-07-26-server-tool-provenance-routing-review.md)「第 3 轮」。3 条**全部采纳**。本轮它**推翻了我上一轮自作主张的一处「放宽」** —— 而我当时还特意标出来请它重点审，结果证明标对了。全部 C 级。

| # | 发现 | 处置 | 级别 | 落点 |
|---|---|---|---|---|
| R3-M1 | 5s「硬上界」在现有 `ResponseRewrite` 契约下**没有执行点**，上游长沉默时恰好永不触顶 | **全采纳，我写了一条不可实现的机制**。核实后发现比它说的更硬：[rewrite-registry.ts:93-99](../../src/lib/pipeline/rewrite-registry.ts#L93) 的接口注释里就记着这个 **P1.5 未决问题**（timer-driven 注入无法用纯 `transform` 表达）。改为**选定可执行接线**：帧数/字节上界帧驱动、时长改为**下一帧到达时惰性检查**，并诚实标注残余风险（管不了「进缓冲后彻底沉默」）及其为何有界。真正的时长硬上界需要 idle hook —— **本 spec 不单方面扩展核心 rewrite 契约**（跨模块架构决策，应独立裁决），改为记录依赖 + 写死触发条件 | C | §4.3.1 新增两小节、§10-14b |
| R3-M2 | 触顶后的状态转移完全没定义，无法保证不丢/不重/不乱序，后到 parent 会让 pair provenance 分裂 | **全采纳**。补 `idle → buffering → replaying → idle` 子状态机 + 5 条重放规则，其中**锁存 `forcedDowngrade` 不可翻案**直接守 §4.3 的 pair 硬不变量；普通块夹在缓冲区里照常 passthrough（不卷进 transcript）；重放禁止二次入缓冲（保证终止）；exactly-once 由 `emitted<upstreamIndex>` 承担 | C | §4.3.1 子状态机、§6.2、§6.3 前置分派、§10-14b/14c |
| R3-M3 | 未知 `caller.type` 仅凭有 `tool_id` 就继承，把**未知判别式当已知语义**，可构造绕过 §4.2 | **全采纳，撤回我上一轮的「放宽」**。改为**白名单** `NESTED_CALLER_TYPES = {code_execution_20250825, code_execution_20260120}`，未知一律 `UNKNOWN_CALLER → 降级 + warn`。我原来的理由「继承语义与 type 取值无关」是**字段名推断**，没有协议契约支撑；而放行的代价是「未知 caller 指向 client-declared 根 → 任意 child name 继承 passthrough」。新增 caller 类型是一行数据改动，与既有 `SERVER_TOOL_REJECTION_TABLE`「没观测到就不加行」纪律一致 | C | §4.3 伪代码、§4.4-1、§10-16 |

**本轮的方法论教训**（值得记进项目记忆）：我在第二轮**主动放宽**了一条判据，理由是「更通用、避免将来平白降级」——听起来是长远正确，实际是**拿字段名推断代替协议契约**，把一个封闭 union 的未知成员当成已知语义。**「向前兼容」不能靠猜判别式的含义**；正确的向前兼容是白名单 + 加行成本极低。

## 0.4 第四轮复评处置表（同一 reviewer 续跑）

结论：**0 blocker / 2 major**，报告见 [评审合集](2026-07-26-server-tool-provenance-routing-review.md)「第 4 轮」。2 条**全部采纳**。**边界争议已裁决**：评审**接受**「本 spec 不扩展核心 rewrite timer 契约」，认可惰性时长检查 + 记录 idle hook 依赖足以实施，且它「不再冒充真实 wall-clock 硬上界」。全部 C 级。

| # | 发现 | 处置 | 级别 | 落点 |
|---|---|---|---|---|
| R4-M1 | `awaiting`(tool_id) 与 `forcedDowngrade`(upstream index) **键域矛盾**，「给 awaiting 里的 id 锁存」在类型与信息上都做不到 | **全采纳**。拆成三个键域分明的字段：`awaitingParentIds` / `unresolvedChildIndicesByParentId` / `forcedDowngradeIndices`。**并采纳它的第二半 —— 我把不变量扩大化了**：前稿要求「后到的父即便判 `CLIENT_DECLARED` 也服从降级」，那是把「**同一 pair** 内两块一致」误扩成「**整棵树**同 disposition」，会白丢一个客户端明确声明过的块。锁存作用域收窄到「该 invocation 自己的 result」 | C | §4.3.1 字段表 + 重放规则 3、§6.2、§10-14b |
| R4-M2 | 多个 awaiting 时「任一父出现即重放」会把其余 child 无故强制降级，破坏已决的 passthrough 语义 | **全采纳**。`buffering → replaying` 改为在 **`awaitingParentIds` 清空** / 上界触顶 / flush 三者之一时发生；父出现只从集合移除。缓冲区已在手，没有理由在第一个父出现时放弃等待其余的 —— 最坏情况本就由上界兜着 | C | §4.3.1 转移表、§10-14c |


---

## 0.5 用户裁决 + 第六轮双方设计论证（2026-07-29）

**用户裁决两项（A 级，不由我裁）**：
1. **idle hook 并入本次** —— P1.5 那个未决的 rewrite 契约扩展由本 spec 一并闭合（落点 §4.3.1）。
2. **跨格式降级分两阶段，但写进同一份 spec** —— 不推给边界模糊的 Phase 6（落点 §3.1 / §3.4）。

**第六轮不是复评，是设计论证**：用户对「spec 的方案长期最优吗」的追问触发。我把「provenance 是否该在 source 侧记录」同时交给**跑完 5 轮的 GPT reviewer**（有上下文，但它刚批准过现方案、算半个当事方）与**一个未卷入的 Claude architect-advisor**（异底座、独立）。

| 议题 | 结论 | 落点 |
|---|---|---|
| 我提的「source 侧记录 provenance」 | **两方都判我押错了「谁拥有那个事实」**：注入点（S3）只知道自己**提议**了什么，不知道 `stripServerTools`（S4-pre）之后上游**看到**了什么。以它为 SoT = 把意图当事实 | §4.3.0 |
| 那该用什么 | **wire ∩ originalRequest 求交** —— 两份本就活到 sink、都不会撒谎的记录。不需新载体、不可能 stale、同名冲突自动按客户端优先收敛 | §4.3.0 |
| 是否推翻 §4 | **不推翻**（正式裁决）。§4 的判定机器（判据表、两陷阱、graph 继承、first-match、缓冲子状态机、idle hook）在**任何**形状下都必须存在；两个形状只在 `classifyByDeclaration` 的**一个输入**上分岔。我把它称作「结构性选择」是**高估**。且 §4 已吸收 5 轮评审的真 bug 修复，推翻重来会把它们置于重新论证的风险 —— 这是**正确性**论据，不是成本论据 | §4 保留，三处外科修正 |
| 私有字段方案 | **已实测证伪**：字符串字段被 `structuredClone` 保留并直达上游；Symbol 被丢弃、承载不了 | §11-9 |
| 我对独立方一条断言的反驳 | **反驳成立、对方已撤回**：它称「客户端声明了但被 learned strip 删掉 → 误判 CLIENT_DECLARED → 下轮 orphan 400」。我指出声明既被 strip、上游就看不到该工具、不会发出对应块，**路径不可达**。已降格为「形状更干净、不修可复现 bug」 | —— |
| §3.2 的收窄论证 | **一条已死、一条被用反**（我实读确认：`text` 块能过两条翻译腿，被丢的只有 server-tool 块）。收窄只支持 passthrough，**降级到 text 与客户端格式无关** | §3.2 全表重写 |
| 三张分类表并存且漂移 | 仓库已有正确的 server/client 二分（`hedge-policy.ts:3-4`），本 spec **不造第三张**，抽共享 primitive | §4.2、§12.1 |

**独立方明确标注的未验证项**（原样转录，不美化）：三个入站 schema 是否真表达不出 Anthropic typed server tool（推断，未逐一比对）；两条翻译腿的**流式**腿未读（第 4 条对流式是外推）；SDK 的 6 类结果块与 caller 白名单它未打开 `node_modules` 复核（采信本 spec 自述实读）；§4.3.1 缓冲子状态机自身的正确性它未逐行审。**前两项已写进 §3.4 作为阶段二的前置核实项。**

## 0.6 第七轮复评处置表（改动触及已定稿章节后的复评）

结论：**0 blocker / 3 major**，报告见 [评审合集](2026-07-26-server-tool-provenance-routing-review.md)「第 7 轮」。3 条**全部采纳**。其中 R7-M1 **推翻了独立方的一个论断、也推翻了我转述给用户的一条「收益」**。全部 C 级。

| # | 发现 | 处置 | 级别 | 落点 |
|---|---|---|---|---|
| R7-M1 | 求交按 `name+type` 存在性匹配，**同名重复声明下 provenance 不可判**；「客户端优先自动收敛」不成立 | **全采纳**。响应块只带 `name`、**没有 declaration identity**，无法知道由哪条声明触发 → 可能把我方注入的 invocation 判成 `CLIENT_DECLARED` 而原样转发，**违反决策 1**。且 `"Tool names must be unique"` 是**真实上游约束**（交接文档 §5-6 实测）。**歧义必须在 S3 消灭**：客户端已声明同名合法 typed server tool 时不得再注入；wire 对 server-tool name 强制唯一。**§11-11 从「不修、单独立项」升为必修** | C | §4.3.0、§11-11、§12.1、§10-17 |
| R7-M2 | 非流式腿的 wire 接线**描述错误**：`renderNonStreamingV4` 拿到的 `env` 里没有 `PreparedRequest` | **全采纳**。已核：[handler-v4.ts:528](../../src/routes/messages/handler-v4.ts#L528) 只解构 `{upstream, env}`，[driver.ts:1562](../../src/lib/pipeline/driver.ts#L1562) 的 `runResponseWhole` 也只收 env，wire 在 candidate ready/result 上。§12 改为写明：wire 作**独立参数**贯通、扩展 driver 返回契约、**绝不塞回 env 冒充 request 状态**，并补上第二个调用点 [dry-run-pipeline.ts:463](../../src/routes/debug/dry-run-pipeline.ts#L463) | C | §12.1 |
| R7-M3 | idle hook 是本次新增的**核心契约**，§12 却完全没列它的生产接线与测试 | **全采纳** —— 这正是「改了正文、没改指向它的清单」那类漏。§12 补 `rewrite-registry.ts`（契约字段）与 `response-processor.ts`（定时器/serializer 实际归属，现在那里只有 `for await` + `finally` flush），§10 补 AC18 五条竞态测试 | C | §12.1、§10-18 |

**其余结论**：求交只用于 direct 根、嵌套走继承，与 `forcedDowngradeIndices` 的锁存作用域**自洽**，未发现新的 graph/replay 问题；§3 的两阶段与诚实度**通过**。




## 1. 问题

### 1.1 事故因果链（已实证）

```
① GHC 上游返回   [thinking, server_tool_use{tool_search}, tool_search_tool_result, thinking, tool_use]   ← 合法
② 我方 filter 无条件剥离中间两块 + 索引压密 → 转发 [thinking, thinking, tool_use]                       ← 我方制造违规
③ 客户端把它 baked 进本地历史
④ 下一轮回传 → 撞 C1（相邻 thinking）→ 400 "cannot be modified"
⑤ L1 destack 修 C1（tool_use 挪中间）→ 撞 C2（末块 thinking）→ 400 "final block ... cannot be `thinking`"
```

第 ⑤ 步就是 `req_1785016294183_896` / `req_1785016294884_897` 两次每轮必败的 400（`claude-opus-5`，直连 `/v1/messages`，`translated:false`）。

**取证**：`req_1785016247905_895` 的两条腿逐块对比 —— 上游轨 `thinking,server_tool_use,tool_search_tool_result,thinking,tool_use`，客户端轨 `thinking,thinking,tool_use`。同 session 14 条请求中含 server-tool 块的只有 1 条，**而它 100% 制造了相邻 thinking**：只要上游把 server-tool 块夹在两个 thinking 之间，[server-tool-filter.ts:136-141](../../src/lib/anthropic/server-tool-filter.ts#L136) 必然把两个 thinking 并拢。

### 1.2 三层 thinking 修复机制的真实定位

L1 destack / L2 strip-all / L3 quarantine **全部是在下游收拾这个 filter 制造的烂摊子**。它们治的是症状；病灶在响应侧的剥离。这也解释了为什么 destack 是「每轮重复施加」的 —— 坏形态已写进客户端本地历史，每一轮都要重新修补同一批消息。

### 1.3 被忽视的信息丢失

`tool_search_tool_result` 携带的是模型刚刚搜到的工具引用（实例：`Task` / `Agent` / `SendMessage`）。模型在**第二段 thinking** 里会引用这次搜索的结果，但结果被我方丢弃了 —— 后续轮次里模型看到自己说「我搜索到了 Task」，上下文却没有任何搜索痕迹。这违反 [richest-data-flow](../decisions/2026-07-05-richest-data-flow.md)（数据以最丰富形式流动、决策交给末端），属于**中途裁剪**。

### 1.4 `tool_search` 是我方注入的，客户端从未声明

实测（`req_1785016247905_895`）：

| | tool_search 声明 |
|---|---|
| 客户端请求 `tools` | **无** |
| 我方发出的上游请求 `tools` | `{"name":"tool_search_tool_regex","type":"tool_search_tool_regex_20251119"}` |

注入条件（[message-tools.ts:177-186](../../src/lib/anthropic/message-tools.ts#L177)）是三者合取：config `anthropic.tool_search`（默认 true）× 模型能力表支持 × **请求带 tools**（整个 `processToolPipeline` 只在请求带 tools 时跑）。同 session 实测 14/15 轮注入，唯一例外正是 `clientTools=0` 的那条。

注入目的是开启 `defer_loading`（把非核心工具标记为延迟加载以省 prompt token）—— 这是**纯代理侧优化**，客户端既不知情也不参与。收益已量化裁决为「保留、不退役」（每轮省 16,157 prompt token / 62.7%，见 [exp/tool-search-cost-benefit/FINDINGS.md](../../exp/tool-search-cost-benefit/FINDINGS.md)），所以**本 spec 的工作没有「等 tool_search 退役就自动消失」的退路**。

### 1.5 现存缺陷（非本 spec 引入，但本 spec 必须修）

[rewrite-server-tool-blocks.ts:70-94](../../src/lib/anthropic/sanitize/rewrite-server-tool-blocks.ts#L70) 的 `stringifyServerToolResultContent` 是 web-search 专用的：它把 `content` 是否为数组当作成功/失败的判别式，于是 `tool_search_tool_result`（`content` 是**对象** `{type:"tool_search_tool_search_result", tool_references:[…]}`）被渲染成 `"Web search failed: unknown"` + `isError: true` —— **谎报失败、丢光真实工具引用**。请求侧 downgrade 模式被 learned 开启即触发。

---

## 2. 已定决策（用户拍板，不再重开）

1. **不如实暴露**：我方注入的 server-tool 块**不能**原样转发给客户端（客户端从未声明过它，转发会把内部优化泄漏成客户端契约，且回传后依赖「每轮都注入同样声明」这一脆弱前提）。
2. **降级而非丢弃**：把这些块降级成客户端能理解的形式，保留其携带的信息。
3. **分流判据不是模型族**：用户的原始表述是「仅对 claude models 处理」，但模型族只是代理变量 —— 采用更本质的判据见 §4。**能力的归属，而不是模型的品牌，才是决定可见性的东西。**
4. **存量坏数据必须有修复机制**（§9）。
5. **`tool_search` 注入本身值不值必须量化后裁决** —— 已于 2026-07-27 裁决为「保留」（§1.4）。

---

## 3. 范围：两阶段，阶段一收窄到 `clientFormat === "anthropic"`（CRITICAL-3）

> **2026-07-29 修订**：v2 前稿把这个收窄写得像**信息上做不到**，那是错的（独立评审查出、我实读代码确认）。它其实是**我们选择分两阶段做**。用户 2026-07-29 裁决：**两个阶段都写进本 spec**，不推给边界模糊的 Phase 6。

### 3.1 阶段划分

| 阶段 | 覆盖 | 状态 |
|---|---|---|
| **一** | `clientFormat === "anthropic"`：provenance 分流（原样转发 / 降级为 text） | 本 spec 主体，可立即实施 |
| **二** | 降级分支扩到 `openai-cc` / `openai-responses` / `gemini` | 本 spec §3.4，带验收与触发条件 |

阶段一的门 = **保留 rewrite 的注册与 `appliesTo` 不变**（仍是 `targetEndpoint === /v1/messages`），在 rewrite **内部**按 `clientFormat` 分支：

| `clientFormat` | 阶段一行为 | 阶段二行为 |
|---|---|---|
| `anthropic` | provenance 分流（转发 / 降级） | 不变 |
| `openai-cc` / `openai-responses` / `gemini` | **与今天逐字节一致**：无条件 suppress + 索引压密（`legacy-suppress` 模式） | **降级为 text**（passthrough 仍不开放） |
| 任意，`targetEndpoint` 非 `/v1/messages` | rewrite 不注册（与今天一致） | 不变 |

### 3.2 收窄的真实理由（前稿三条：一条已死、一条被用反 —— 重写）

| 前稿理由 | 复核结论 |
|---|---|
| ① provenance 判据源在非 Anthropic 客户端上有损（CC codec 的 `originalRequest.tools` 只有 `{name, description}`，丢了 `type`） | **已死**。判据源已改为「本次 dispatch 的 `wire.body.tools` ∩ `ctx.originalRequest.tools`」（§4.3），而 `wire.body.tools` 是 **Anthropic 原生、完整、与客户端格式无关**的数组。这条理由不再成立 |
| ② 翻译腿本来就丢弃 server-tool 块 | **被用反了**。实读 [anthropic-to-cc.ts:106-109](../../src/lib/openai/translate/anthropic-to-cc.ts#L106)（`case "text": textParts.push(block.text)`）与 [anthropic-to-responses.ts:117-125](../../src/lib/openai/translate/anthropic-to-responses.ts#L117)（`case "text"` → `output_text` item）：**`text` 块能正常通过两条翻译腿**，被 `default:` 丢掉的**只有 server-tool 块**。所以这条只支持收窄 **passthrough**，**不支持**让这些客户端继续走无条件剥离 —— **降级成 text 恰恰是让它们第一次拿到这段信息的办法** |
| ③ 跨格式语义未定 | **仍成立，但同样只覆盖 passthrough**（「客户端声明的 server tool 如何跨格式表达」确实未定；而「降级成 text」不需要任何跨格式语义） |

**正确的分解**：**降级到 text 与客户端格式无关；passthrough 才是 anthropic-only。**

**因此必须诚实写明的代价**：维持阶段一 = 在 **3/4 的象限里原样保留 §1.3 那个信息丢失病灶**（今天 CC/Responses/Gemini 客户端是静默丢块，模型说「我搜到了 Task」而上下文没有任何搜索痕迹）。这不是做不到，是**排期**。

### 3.3 阶段一为什么仍然值得先做（不是妥协，是可验证性）

- 阶段一有**真实冻结 fixture**（`req_1785016247905_895` 的生产帧）与**两轮 e2e**（§10-10）可验证；阶段二在本部署语料里**没有**对应的真实样本（CC/Responses/Gemini 客户端撞上 server-tool 块的记录为 0）。
- 阶段一的转发字节改变**只发生在 anthropic 象限**，另外三个象限可用现有 golden 逐字节锁定（§10-9），把回归面压到最小。
- 阶段二会**删掉** `legacy-suppress` 模式与 §3.1 的分支表 —— 那是净简化，但要重新冻结三份 golden，适合作为独立的一次改动。

### 3.4 阶段二：跨格式降级（写实，不是占位）

**做什么**：`legacy-suppress` 模式整个删除；所有 `clientFormat` 走同一条降级路径。

**为什么届时不需要 `clientFormat` 分支**：在 §4.3 的求交规则下，非 anthropic 客户端的 wire typed 声明**按构造**都不在其 `originalRequest.tools` 里（CC/Responses/Gemini 的入站 schema 表达不出 Anthropic typed server tool）→ 求交为空 → **自动全部落到降级分支**。分支表因此可以删掉，而不是改写。

> **未验证标注**：「三个入站 schema 都表达不出 Anthropic typed server tool」由独立评审基于 schema 印象推断，**未逐一比对**。阶段二实施前必须逐个 schema 核实；若某个入站格式其实能表达，则该格式的 passthrough 语义要单独裁决。

**验收（阶段二）**：
- CC / Responses / Gemini 三个象限各一条：上游返回 server-tool pair → 断言客户端收到**降级后的 text**（CC 折进 `content`、Responses 产 `output_text` item、Gemini 对应字段），而不是块被静默丢弃。
- 三份 golden 重新冻结，且**冻结前后 diff 必须逐条可解释**（只应出现新增的 transcript 文本，不应有其它字节变化）。
- 流式腿单独验：**未验证标注** —— 独立评审只读了两条翻译腿的**非流式**折叠函数，流式腿（新 index 的 text 块如何映射成增量）未读，阶段二实施前必须补读并补测。

**触发条件**：阶段一 landed 且其 e2e 稳定后即可启动；**不设额外前置**（不依赖任何探针结论）。



---

## 4. provenance 判据（HIGH-4）

### 4.1 概念前提：三类工具，不是两类

引 ADR [server_tool 定位](../decisions/2026-07-13-server-tool-positioning-and-web-search-retirement.md)（实测确立）：

| 类别 | 声明形状 | 谁执行 | 响应块类型 |
|---|---|---|---|
| 自定义 client tool | `{name, input_schema}`，无 `type` | 客户端 | `tool_use` |
| **内置 client tool**（易混） | `{name, type}`，如 `memory_20250818` / `bash_20250124` / `text_editor_20250728` | **客户端** | `tool_use` + `caller:{type:"direct"}` |
| **真 server tool** | `{name, type}`，如 `web_search_20250305` / `web_fetch_*` / `code_execution_*` / `tool_search_tool_*` | **服务端** | `server_tool_use` |

**判据不是「有没有 `type`」**，而是「Anthropic 是否把这个具体工具划为服务端执行」。本 spec 只处理第三类。

### 4.2 typed-declaration 判据表（**复用既有表，不造第三张**）

> **2026-07-29 修订**：v2 前稿要新建一张 server-tool 分类表。独立评审查出**仓库里已经有两张、且已经漂移**，我复核确认：
> - [hedge-policy.ts:3-4](../../src/lib/pipeline/generation/hedge-policy.ts#L3)：`ANTHROPIC_SERVER_TOOL_PREFIXES = [web_search_, web_fetch_, code_execution_, tool_search_]` / `ANTHROPIC_CLIENT_TOOL_PREFIXES = [text_editor_, computer_, bash_, memory_]` —— **这正是 ADR 的 server/client 二分**，是仓库里已有的**正确**表。
> - [message-tools.ts:337](../../src/lib/anthropic/message-tools.ts#L337)：`API_DEFINED_TOOL_TYPE_PREFIXES` 把两类**混成一张**「API-defined」表（10 项，server 与 client 执行的混在一起）—— 它服务的是另一个目的（判断要不要动 `input_schema`），本身不算错，但与上表**成员不一致**。
>
> 再加一张就是三处并存 —— 正是 `fix-all-comparison-sites` 的形状。**本 spec 不新建表**：抽出单一共享 primitive（建议落在 `server-tool-provenance.ts`），`hedge-policy.ts` 与本 spec 共同消费；`API_DEFINED_TOOL_TYPE_PREFIXES` 保留其原用途但注释指向 primitive，说明二者语义不同、不要混用。

`server_tool_use.name` 的取值域来自 SDK（`ServerToolUseBlock.name`，本次实读）。判据表如下 —— **`name` 匹配还不够，客户端声明里的 `type` 必须落在该 name 允许的前缀集合内**：

| `server_tool_use.name` | 允许的客户端声明 `type` | 可被客户端直接声明？ |
|---|---|---|
| `web_search` | `web_search_` 前缀（`web_search_20250305` / `web_search_20260209`） | 是 |
| `web_fetch` | `web_fetch_` 前缀 | 是 |
| `code_execution` | `code_execution_` 前缀 | 是 |
| `tool_search_tool_regex` | `tool_search_tool_regex` 或 `tool_search_tool_regex_20251119` | 是（但今天只有我方注入） |
| `tool_search_tool_bm25` | `tool_search_tool_bm25` 或 `tool_search_tool_bm25_20251119` | 是（同上） |
| `bash_code_execution` | **无** —— 它是 `code_execution` 的服务端子工具 | 否，见 §4.3 |
| `text_editor_code_execution` | **无** —— 同上 | 否，见 §4.3 |

**必须写死的两个陷阱**：

1. **同名 custom function 不算声明。** 客户端可以合法地声明一个 `{name:"web_search", input_schema:{…}}` 的**自定义 client tool**（没有 `type`，由客户端自己执行）。它与 server tool `web_search` 同名但语义完全不同 —— 判据必须要求 `type` 存在且落在表内前缀，否则会把「客户端自己实现的 web_search」误判成「客户端要的 server tool」，从而把一个它根本不认识的 `server_tool_use` 块原样转发过去。
2. **`bash` / `str_replace_based_edit_tool` 与 `bash_code_execution` / `text_editor_code_execution` 是不同的东西。** 前两者是**客户端执行**的内置 tool（产 `tool_use`），后两者是 `code_execution` 沙箱内的**服务端**子工具（产 `server_tool_use`）。按 name 做子串匹配必然把它们混起来 —— 判据只用**全等**，不用 `includes`/`startsWith`。

### 4.3.0 `classifyByDeclaration` 的判据源：**wire ∩ originalRequest**（2026-07-29 修订）

v2 前稿只拿 `ctx.originalRequest.tools`（客户端意图）判。独立评审指出**那押错了「谁拥有那个事实」**，我复核后采纳：

> 注入点（`preprocessTools`，S3）只知道自己**提议**了什么；一条声明能不能上 wire 由 **S4-pre 的 `stripServerTools`** 决定（[request-preparation.ts:579](../../src/lib/anthropic/request-preparation.ts#L579)，读 learned 缓存 + `prepareHints.excludeServerToolTypes`）。**以注入点为事实源 = 把意图当事实。**

**判据源 = 两份都已经活到 sink、且都不会撒谎的记录求交**：

| 记录 | 是什么 | 出处 |
|---|---|---|
| ① `wire.body.tools` | **本次 dispatch** 上游真正看到的 typed 声明全集（post-strip） | `CandidateReady.wire`（[candidate.ts:41](../../src/lib/pipeline/generation/candidate.ts#L41)） |
| ② `ctx.originalRequest.tools` | 客户端原始声明数组（未经我方注入/改写） | [codec.ts:422](../../src/lib/codec/anthropic/codec.ts#L422) |

| 判定 | 规则 |
|---|---|
| `CLIENT_DECLARED` | name 在 ① 里有合法 typed 声明（§4.2）**且** 同一 name+type 也在 ② 里 |
| `NOT_DECLARED`（我方注入 → 降级） | 在 ① 有、② 无 |
| `NOT_DECLARED`（未声明 → 降级） | 不在 ① |

**这个规则只作用于 `caller.type === "direct"` 的根 invocation**；嵌套子调用（`bash_code_execution` 等**永远**不在任何声明集里）走 §4.3 的 graph 继承、**不**参与求交 —— 否则会把客户端明确声明的 `code_execution` 整棵树切碎。（此边界经独立评审确认。）

**三个连带收益**：
- **不需要新载体**：两份记录本就活到 sink，不必往 `ctx` / `requestState` / `prepareHints` 上挂新字段（三者各有致命问题，见 §11-9）。
- **不可能 stale**：wire 与 response 同属**一次 dispatch**。响应处理只发生在获胜 attempt 上（`createProcessor` 在 `scheduler.run()` 成功返回后才调用），`createState(env)` 每 candidate 只跑一次（[response-processor.ts:65-71](../../src/lib/pipeline/stream/response-processor.ts#L65)，注释原文 "isolated from every sibling candidate"）。
- **同名歧义必须在 S3 消灭，而不是靠求交「收敛」**（第七轮复评 R7-M1 推翻了前稿的说法）：[message-tools.ts:178-205](../../src/lib/anthropic/message-tools.ts#L178) 先无条件 push 我方 `tool_search_tool_regex` 声明，再**无 dedupe** 地追加客户端 tools。若客户端也声明了同 `name`：
  - wire 上出现**两条同形声明**，而响应里的根块**只携带 `name`、没有 declaration identity** —— 从信息上就**无法**判断这次 invocation 是由哪一条触发的。前稿写「求交天然给出安全答案：客户端声明优先」是**错的**：它可能来自我方注入的那条，判成 `CLIENT_DECLARED` 原样转发就**违反决策 1**。
  - 而且 `"Tool names must be unique"` 是**真实的上游约束**（交接文档 §5 第 6 条实测记录：重放 upstream body 前必须剔除我方注入的工具，否则撞这个 400）—— 两条同名声明本身就可能被上游直接拒。
  - **因此本 spec 必须修它**（从「单独立项」升为**必修**，见 §11-11）：**S3 若发现客户端已声明同 `name` 的合法 typed server tool，就不得再注入我方同名声明**；同 `name` 但 `type` 不同、或同名 custom function 的冲突也要有明确策略，**绝不允许两条同名声明同时上 wire**。最终 wire 对 server-tool `name` **强制唯一** —— 否则 provenance 在信息论上不可判。

**明确否掉「在 sink 里重算判据」**：`stripServerTools` 读的 `getUnsupportedServerToolTypes` 是**带 TTL 的全局可变缓存**，响应期重算可能与发请求时给出不同答案，且 TTL 到期那一支是**不安全方向**（重算说「声明还在」→ 误转发）。**捕获，不重算** —— 这才是 `abort-provenance-tag-at-source-not-guess-at-boundary` 那条教训在本案里真正适用的部分。

### 4.3 invocation graph 与 `caller.tool_id` 嵌套传播

`ServerToolUseBlock.caller` 的类型是 `DirectCaller | ServerToolCaller | ServerToolCaller20260120`：

- `{type:"direct"}` —— 模型直接发起。provenance 由 §4.2 判据表直接判定。
- `{type:"code_execution_20250825" | "code_execution_20260120", tool_id}` —— 该调用是**由某次 `code_execution` 调用发起的嵌套调用**，`tool_id` 指向发起者。

因此 provenance 不是逐块独立可判的，而是沿 invocation graph **从根传播**。分支**有序且互斥**（first-match），入口先封闭输入域 —— 否则畸形 `caller` 会让 `caller.tool_id` 直接抛异常：

```
classify(block, visited = {}):
  # ── 0. 入口形状校验（先封闭域，再谈分类）──
  if typeof block.id !== "string" or block.id === "":     return MALFORMED
  if typeof block.name !== "string":                      return MALFORMED
  if block.caller == null or typeof block.caller !== "object" or
     typeof block.caller.type !== "string":               return MALFORMED_CALLER

  # ── 1. 直接调用：判据源见 §4.3.0 ──
  if block.caller.type === "direct":
      return classifyByDeclaration(block.name)            # 求交规则，含未知 name → UNKNOWN_NAME

  # ── 2. 嵌套调用：caller.type 必须在白名单内 ──
  if block.caller.type ∉ NESTED_CALLER_TYPES:             return UNKNOWN_CALLER
  if typeof block.caller.tool_id !== "string" or block.caller.tool_id === "":
      return MALFORMED_CALLER

  # ── 3. 沿 graph 继承 ──
  parent = invocationById.get(block.caller.tool_id)       # 只含「此刻已经见过」的 invocation
  if parent === undefined:      return UNRESOLVED
  if parent.id ∈ visited:       return CYCLE
  if visited.size >= 8:         return DEPTH_EXCEEDED
  return classify(parent, visited ∪ {block.id})
```

`NESTED_CALLER_TYPES` = SDK 当前**封闭 union** 里真正定义了「`tool_id` 指向父 server tool」语义的那两个：`code_execution_20250825`、`code_execution_20260120`（`messages.d.ts` 的 `ServerToolCaller` / `ServerToolCaller20260120`）。

> **未知 `caller.type` 一律 `UNKNOWN_CALLER → 降级 + warn`，绝不因为「它也有个 `tool_id` 字段」就放行。**
> 这一条我在第二轮改错过：当时我把它「放宽」成「只要带有效 `tool_id` 就照常继承」，理由是「继承语义与 type 取值无关」。**第三轮复评 R3-M3 证明这是错的** —— 那等于把**未知判别式**当成已知语义：构造一个未知 type 的 caller 指向某个 client-declared 根，就能让**任意** child name 继承 `CLIENT_DECLARED`、**整个绕过 §4.2 的 typed name/type 判据**被原样转发。而「未来的 caller type 里同名的 `tool_id` 仍表示 provenance 父」这件事**没有任何协议契约**支撑，纯属字段名推断。
> SDK 新增 caller 类型时，把它加进 `NESTED_CALLER_TYPES` 是**一行数据改动**；而放行的代价是一类静默误判。**表驱动 + 白名单**，与本项目 `SERVER_TOOL_REJECTION_TABLE`「没有观测到就不加行」的既有纪律一致。
- `invocationById` **只包含此刻已经见过的 invocation** —— 它不是完整图，这一点必须写在实现注释里，否则下一个人会以为 `undefined` 就等于「不存在」。
- 传播是**继承而非重判**：`bash_code_execution` 在表里没有可声明的 type，若不继承就永远判为「未声明 → 降级」，而它的根 `code_execution` 可能正是客户端声明的 —— 那会把客户端明确要的一整棵调用树切碎。
- **递归终止性**：`visited` 单调增长且 `depth < 8`，每层要么返回要么消耗一个新 id，故必然终止。入口校验保证递归只在结构合法的对象上进行。
- `*_tool_result` 的 provenance = 它 `tool_use_id` 所指 `server_tool_use` 的 provenance。**结果块自己不参与判定**（SDK 里只有 `web_search_tool_result` / `web_fetch_tool_result` 带 `caller`，其余四类只有 `tool_use_id`，所以按 `caller` 判会有一半判不出来）。

**一个 pair 的两块 provenance 必须一致** —— 这是硬不变量：若一半原样转发一半降级，客户端会拿到一个没有结果的 `server_tool_use`（或一个没有调用的结果），这正是我们要根治的那类畸形。

### 4.3.1 `UNRESOLVED` / 环 / 重复 id 的确定动作

上面三个非正常返回值必须有确定语义，否则算法要么不终止、要么依赖实现偶然行为。

| 返回 | 动作 | 语义标注 |
|---|---|---|
| `UNRESOLVED`（父在**本块 start 的时刻**尚未出现） | **局部缓冲**该块及其后续帧，直到父出现 / 缓冲上界触顶 / EOF（见下） | 保住「客户端声明的原样转发」这条已决语义 |
| `CYCLE`（`A→B→A`，含 self-cycle `A→A`） | **降级** + `consola.warn`（附整条 id 链） | 上游若真产出环，那是上游异常；降级是唯一安全动作 |
| `DEPTH_EXCEEDED`（链长 ≥ 8） | **降级** + `consola.warn` | 防御性上限，正常嵌套远不到 |
| 同一响应内出现**重复** `server_tool_use.id` | `invocationById` **保留首次**（后到者不覆盖）+ `consola.warn`；后到的块按**自己的 upstream index** 独立成一个单元 | 见 §6.2 的 emission identity —— 去重键必须是 upstream index，**不是** `id` |

#### `UNRESOLVED` 为什么是缓冲而不是直接降级（一次被推翻的取舍，记录全过程）

v2 初稿选的是「保守降级」，理由写的是「缓冲要连带扣住后续所有块，代价落在**每一个正常响应**上」。**这个理由是错的**，首轮评审 R2-M1 推翻：缓冲是**条件触发**的 —— 只有真的出现 child-before-parent 才启动，正常的 parent-before-child 响应（以及根本没有嵌套的绝大多数响应）**一帧都不缓冲、零代价**。既然代价不落在正常路径上，就没有理由拿它去否决一个语义完整的方案（那等于用不存在的成本换真实的语义损失，而且**已降级的历史无法补回**）。

故改为**局部缓冲**，并补上评审未考虑、但本项目有实测教训的一条：**缓冲必须有上界**。

#### 上界的可执行接线（R3-M1 修正了不可实现的写法；2026-07-29 用户裁决扩大为真时长上界）

v2 前稿写了「缓冲累计**时长** 5s 触顶」。**这条在当时的契约下没有执行点** —— `ResponseRewrite` 只有由上游帧驱动的同步 `transform` 与流末 `flush`（[rewrite-registry.ts:101-125](../../src/lib/pipeline/rewrite-registry.ts#L101)），该接口的文档注释里就记着这个**未决问题**：

> timer-driven `heartbeat` … injects during upstream SILENCE — no frame arrives to drive `transform`. A pure per-frame `transform` cannot express that. **P1.5 must decide**: keep heartbeat as a handler-side bypass, or **extend this interface with an idle/timer hook**.

**用户 2026-07-29 裁决：并入本次，扩展 idle hook**（决策记录见 §0.5）。即 P1.5 这个未决问题由本 spec 一并闭合，而不是绕开它。

**契约扩展**：

```ts
interface ResponseRewrite {
  /**
   * 上游静默期的执行点。由 processor 的 idle 定时器驱动，`idleMs` = 距上一帧到达的时长。
   * 返回要注入的帧（空数组 = 什么都不做）。可选 —— 不实现的 rewrite 完全不受影响。
   */
  onIdle?(state: RewriteState, idleMs: number): Array<UpstreamFrame>
}
```

**三条必须写死的接线约束**（否则会引入比它修的问题更严重的问题）：

1. **串行化**：`onIdle` 产出的帧必须走与 `transform`/`flush` **同一个发射路径**，并与之**互斥执行**。sink 早已因为「synthetic 与 real 帧绝不能字节交错」而实现了 `writeSerialized`（[client-sink.ts](../../src/lib/pipeline/client-sink.ts)），本扩展必须复用同一纪律，不得另开一条发射路径。
2. **竞态单一赢家**：`onIdle` 触发与「新帧到达 / flush」同时发生时，**帧到达与 flush 优先**；`onIdle` 若发现自己已被抢先（缓冲区已被重放），**必须无副作用返回**。exactly-once 仍由 `emitted: Set<upstreamIndex>` 兜底（§6.2）。
3. **不与 heartbeat 打架**：sink 已有一个 forward-idle racer 在跑 keepalive。两个定时器**必须各自独立、互不重置对方**（sink 那两个 racer 就是按「deliberately SEPARATE」设计的，本扩展遵循同一原则）。`onIdle` 注入的是**真实内容帧**（transcript），会自然重置客户端的 no-real-content 计时器 —— 这是收益，不是冲突。

**上界表（扩展后全部可执行）**：

| 上界 | 检查点 |
|---|---|
| 缓冲累计**帧数**（200）/ **字节**（1 MiB） | 每次 `transform` 收到新帧 |
| **距进入缓冲的时长**（5s） | `onIdle` —— **真 wall-clock 上界**，不再是「下一帧到达时惰性检查」 |
| EOF / 上游抛错 | `flush`（在 `finally` 内，必跑） |

**这条扩展的收益不止本 spec**：它闭合了 P1.5 记录的未决问题，让「上游静默期需要动作」这一整类需求（heartbeat 的 handler-side bypass、未来任何 buffering rewrite）都有正规表达方式，而不是各自绕开契约。这也是本次把它并入的理由 —— 若只为本 spec 打一个局部补丁，下一个遇到同样问题的人还要再绕一次。

**上界不是防御性洁癖**：缓冲期客户端收不到已到达的字节，而这段沉默落在**首块提交之后**的区间 —— 按并发会话在飞的 [inter-block-keepalive-carrier spec](2026-07-27-inter-block-keepalive-carrier.md)（其状态以该文档自身为准）记录的 live 取证，那正是 keepalive 目前**失守**的窗口，且已观测到两条约 300s 的 open-block 请求**被客户端掐断**。

#### 缓冲子状态机（第三轮复评 R3-M2：触顶后的状态转移原先完全没定义）

`idle → buffering → replaying → idle`，单流内串行，任一时刻只有一个执行点在跑（帧到达 / flush 二者互斥）。

**状态字段的键域必须分开**（第四轮复评 R4-M1：前稿把 `awaiting`(tool_id) 与 `forcedDowngrade`(upstream index) 混着用，「给 awaiting 里的 id 锁存」在类型和信息上都做不到）：

| 字段 | 键域 | 含义 |
|---|---|---|
| `awaitingParentIds` | `Set<toolId>` | 尚未出现的父 invocation id |
| `unresolvedChildIndicesByParentId` | `Map<toolId, Set<upstreamIndex>>` | 每个待解析父**各自挂着哪些 child 单元** —— 锁存时要的就是这个映射 |
| `forcedDowngradeIndices` | `Set<upstreamIndex>` | 已锁存强制降级的**单元** |

| 转移 | 触发 | 动作 |
|---|---|---|
| `idle → buffering` | 某块 `classify` 返回 `UNRESOLVED` | `awaitingParentIds += caller.tool_id`；`unresolvedChildIndicesByParentId[tool_id] += 该块 index`；**该块及其后到达的所有帧**（含普通块）**按原序全部入缓冲**，一律 suppress |
| `buffering`（持续） | 新帧到达 | 先入缓冲，再解析：若是 `server_tool_use` 则更新 `invocationById`；**若它正是某个被等待的父 → 只从 `awaitingParentIds` 移除，不立即重放**；检查上界 |
| `buffering → replaying` | **`awaitingParentIds` 清空** | 全部解析完成，重放 |
| `buffering → replaying` | 上界触顶（帧数/字节/惰性时长） | 把**仍在** `awaitingParentIds` 里的每个 id 所挂的 child indices 全部并进 `forcedDowngradeIndices`，再重放 |
| `buffering → replaying` | `flush`（EOF / 上游抛错） | 同触顶，重放后走 §6.3 的 flush 四形态 |
| `replaying → idle` | 缓冲区放空 | —— |

> **为什么「任一父出现即重放」是错的**（R4-M2）：构造 `childA→PA, childB→PB, PA, PB`，四者都在预算内到达且 PA/PB 都是 client-declared。若 PA 一到就重放，则 PB 尚未出现 → childB 被无故强制降级，**破坏「客户端声明则原样转发」这条已决语义**。缓冲区已经在手，没有任何理由在第一个父出现时放弃等待其余的 —— 上界本就管着最坏情况。

**重放规则（每条都是为了封死一类丢失/重复/乱序）**：

1. **按原序**逐帧重新过同一套分类与逐事件动作 —— 普通块照常 passthrough（**绝不**把它们卷进 transcript，它们只是恰好夹在缓冲区里）。
2. **重放期间禁止二次进入 `buffering`**：若仍有 `UNRESOLVED`（只可能发生在触顶/EOF 路径），直接按 `forcedDowngradeIndices` 处理。这保证终止（不会缓冲套缓冲）。
3. **`forcedDowngradeIndices` 是锁存的、不可翻案，但作用域严格限于「同一个 pair」**：被强制降级的 invocation，**它自己的** `*_tool_result`（后到也算）必须一并降级 —— 这是 §4.3 的 pair 硬不变量。
   > **不可外扩到整棵树**（R4-M1 的第二半，前稿在此扩大化了）：后到的**父** invocation 是**另一个 pair**（父的 use + 父的 result），它按 §4.4 正常分类，判为 `CLIENT_DECLARED` 就照常 passthrough。「一个 pair 内两块 disposition 一致」**不等于**「整棵调用树 disposition 一致」—— 把父也拖下水会白白丢掉一个客户端明确声明过的块，且没有任何不变量要求这么做。
4. **exactly-once 由 `emitted: Set<upstreamIndex>` 保证**（§6.2），重放不会把已发射单元再发一次。
5. **多个未解析父**：见上方转移表 —— 逐个从 `awaitingParentIds` 移除，**清空后一次性重放**；仍未到的由上界统一强制降级。

**探针（§11-4）的定位**：它是**优化门**而非裁决门 —— 若证明协议保证 parent-before-child，则整条缓冲路径永不触发、可以删掉；若探针构造不出来，缓冲路径就留着（正常响应零代价）。**两种结果都不阻塞实施。**

### 4.4 分类结果 → 动作（**有序，first-match**）

多个条件可能同时成立（例如「未知 name」与「环」），所以下表**自上而下首命中**，这既保证动作确定，也保证 warn 与计数的**归因唯一**。

| # | `classify` 返回 | 动作 | 理由 |
|---|---|---|---|
| 1 | `MALFORMED` / `MALFORMED_CALLER` / `UNKNOWN_CALLER` | **降级** + `consola.warn`（附原始块 JSON 截断） | 结构不合法、或 caller 判别式不在白名单 —— 都谈不上「客户端声明过」 |
| 2 | `CYCLE` / `DEPTH_EXCEEDED` | **降级** + `consola.warn` | §4.3.1 |
| 3 | `UNRESOLVED` | **局部缓冲**（触顶后降级） | §4.3.1 —— 这是唯一不立即出结果的一支 |
| 4 | `UNKNOWN_NAME`（`name` 不在 §4.2 表内，SDK 新增） | **降级** | 客户端不可能声明一个我们都不认识的工具 |
| 5 | `DECLARED_MISMATCH`（客户端声明了同名工具，但 `type` 不匹配表内前缀，或那是个无 `type` 的 custom function） | **降级** | §4.2 陷阱 1 |
| 6 | `NOT_DECLARED`（表内已知 name，但客户端本轮根本没声明） | **降级** | 我方注入的 `tool_search` 走这一支 |
| 7 | `CLIENT_DECLARED` | **原样转发** | 客户端自己要的 |

`*_tool_result` 的 `tool_use_id` 配不上任何 invocation（孤儿结果）时，不进上表 —— 它没有 invocation 可分类，直接按 §6.5-3 渲染成 invocation-unknown 的 transcript。**绝不静默丢**。

**一句话原则**：**判不出来就降级。** 降级的最坏后果是客户端多看到一段说明文本；原样转发的最坏后果是下一轮 400 每轮必败 —— 两者不对称，fallback 必须偏向降级。唯一的例外是第 3 行（`UNRESOLVED` 先缓冲），因为那一支还有机会拿到确定答案。

### 4.5 已知不确定性（诚实标注，不写成事实）

| 命题 | 状态 | 闭合方式 |
|---|---|---|
| `tool_search_tool_result` 的 `content` 在 `content_block_start` 帧里就是完整的 | **已实测**（本次事故取证，见交接文档 §6） | —— |
| 其余五类 `*_tool_result` 的内容是否也在 start 帧完整送达 | **未实测** | §6 的算法**不依赖**这一点（在 `content_block_stop` 处才渲染，中途 delta 一律累积），所以无需先实测即可实施 |
| 嵌套 server tool（`caller.tool_id` 非 direct）的真实帧序列 | **未实测**，本部署语料里从未出现 | §4.3.1 的局部缓冲**不依赖**这条实测即可正确（父来了就继承、不来就触顶降级），故不阻塞实施；探针（§11-4）是**优化门**，证明了 parent-before-child 才能把缓冲路径删掉 |
| GHC 对 orphan `server_tool_use` 回哪种 400 措辞 | **仓库内既有观测记录**（[rewrite-server-tool-blocks.ts](../../src/lib/anthropic/sanitize/rewrite-server-tool-blocks.ts) 模块注释），**本次未重新实测** | §7.4 要求两种措辞都进 matcher |

---

## 5. 渲染契约 `renderServerToolTranscript`（CRITICAL-1）

### 5.1 契约签名与归属

新建**中性叶子模块** `src/lib/anthropic/server-tool-transcript.ts`（纯函数，不依赖 request/response/ctx/state，便于两侧复用与单测）：

```ts
export interface ServerToolInvocation {
  id: string
  name: string
  /** 累积完成的 input JSON；解析失败时保留原始串 */
  input: unknown
  rawInput?: string
  callerToolId?: string
}

export interface ServerToolTranscript {
  /** 渲染后的完整文本，保证非空（§5.4） */
  text: string
  /** 仅当结果自身是错误形状时为 true */
  isError: boolean
  /** 判别到的结果种类，供遥测/测试断言用，绝不参与 isError 推断 */
  kind: ServerToolTranscriptKind
}

export function renderServerToolTranscript(
  invocation: ServerToolInvocation | null,   // null = 孤儿结果
  result: unknown | null,                    // null = 无结果（截断/流末）
  opts?: { maxChars?: number },
): ServerToolTranscript
```

**两侧共享同一份文本、各自套不同信封**（这是「杜绝文案漂移」的准确含义）：

- 请求侧（[rewrite-server-tool-blocks.ts](../../src/lib/anthropic/sanitize/rewrite-server-tool-blocks.ts) 的 `downgrade` 模式，喂上游）：`tool_use` + `tool_result{content: text, is_error: isError}`。
- 响应侧（本 spec，喂客户端）：单个 `text` 块，内容 = `text`。**绝不降级成 `tool_use`** —— 那会让客户端真的去执行一个它没有的工具。

`stringifyServerToolResultContent` 被 `renderServerToolTranscript` **取代并删除**（不是并存），否则缺陷会以旧函数的形式留在请求侧。

### 5.2 穷尽表：结果类型 → 渲染规则

判别顺序：**先看外层块 `type`，再看 `content` 的判别式 `content.type`**（`web_search_tool_result` 的成功形状是数组，没有 `content.type`，单列）。下表覆盖 SDK 全部类型（本次实读 `messages.d.ts` 提取）：

| 外层块 `type` | `content` 判别 | 渲染要点 | `isError` |
|---|---|---|---|
| `tool_search_tool_result` | `tool_search_tool_search_result` | `N tool references — <tool_name 列表>` | false |
| | `tool_search_tool_result_error` | `error_code`（+ `error_message`，可为 null） | **true** |
| `web_search_tool_result` | `Array<web_search_result>` | 逐条 `title — url`（+ `page_age`，可为 null） | false |
| | `web_search_tool_result_error` | `error_code` | **true** |
| `web_fetch_tool_result` | `web_fetch_result` | `url` + `retrieved_at` + 内层 `DocumentBlock` 摘要（受 `maxChars` 截断） | false |
| | `web_fetch_tool_result_error` | `error_code` | **true** |
| `code_execution_tool_result` | `code_execution_result` | `return_code` + `stdout` + `stderr` + `content[].file_id` | false |
| | `encrypted_code_execution_result` | `return_code` + `stderr` + **显式标注 stdout 已加密不可见**（`encrypted_stdout` 只记长度，不外泄 blob） | false |
| | `code_execution_tool_result_error` | `error_code` | **true** |
| `bash_code_execution_tool_result` | `bash_code_execution_result` | 同 `code_execution_result` | false |
| | `bash_code_execution_tool_result_error` | `error_code` | **true** |
| `text_editor_code_execution_tool_result` | `..._view_result` | `file_type` + `num_lines` / `start_line` / `total_lines` + 内容（受截断） | false |
| | `..._create_result` | `is_file_update` | false |
| | `..._str_replace_result` | `old_start`/`old_lines` → `new_start`/`new_lines` + `lines[]`（受截断） | false |
| | `..._tool_result_error` | `error_code` + `error_message` | **true** |
| **任意未知** `*_tool_result` | **任意未知** `content.type` | 结构化 JSON 序列化（受截断）+ 显式标注「未建模的结果类型 `<type>`」 | **false**（除非 `content.type` 以 `_error` 结尾） |

**三条硬规则**（每一条都直接对应 §1.5 的缺陷）：

1. **`isError` 只由判别式决定** —— `content.type` 以 `_error` 结尾（或外层块自身是错误块）。**绝不**从「`content` 不是数组」「`content` 是对象」「解析不出预期字段」推断为错误。
2. **未知类型必须保留信息**，序列化成 JSON 并标注未知，**绝不**渲染成任何形式的「failed」。未知是我方模型的不足，不是上游的失败。
3. **默认分支不得沉默** —— 命中未知分支时打一条 `consola.warn`（含块 type 与 content.type），让 SDK 新增类型在日志里立刻可见，而不是悄悄降级成 JSON 直到有人发现。

**截断**：`maxChars` 默认 8000（每个 result），超出部分截断并追加 `[truncated N chars]`。理由不是「省事」而是**这段文本会被客户端 baked 进历史、此后每轮重投并计费** —— 一个 web_fetch 文档可以是 MB 级。上游轨保留完整原始内容（§8.3），所以这是 richest-data-flow 允许的**末端裁剪**，不是中途裁剪。截断上限做成 config（`anthropic.server_tool_transcript_max_chars`），默认值即上述 8000。

### 5.3 文本形态（客户端可见字节，golden 锁定）

统一形态，行首带稳定 ASCII 标记前缀：

```
[copilot-api:server-tool] tool_search_tool_regex
input: {"pattern":"^(Agent|Task|SendMessage)$"}
result: 3 tool references — Agent, Task, SendMessage
```

### 5.4 文本必须满足的四条不变量

这四条都是从既往事故反推出来的，任一条被破坏都会把新的畸形写回客户端历史：

1. **非空。** 空/纯空白 text 块会被我方**自己的**请求侧 `filterEmptyAnthropicTextBlocks`（[sanitize/result.ts:51](../../src/lib/anthropic/sanitize/result.ts#L51)）在下一轮删掉 —— 而那正是 2026-07-27 C3 追加事故的成因链第一环（客户端发来的空 text 分隔符被删 → 两个 thinking 并拢 → 400）。降级文本永远非空，即使 invocation 和 result 都缺失（退化为 `[copilot-api:server-tool] <name> (no details available)`）。
2. **尖括号编码契约（可验证，不靠「天然不会」）。** 结果正文是**上游可控、且可能间接由用户内容构成**的字节（`web_fetch` 抓来的页面、`code_execution` 的 stdout 都可以含任意文本）。渲染时对嵌入的正文**必须把 `<` 编码为 `&lt;`**，且渲染管线中**不得**存在任何反向 decode。
   - **反面教训（v2 初稿的错误，首轮评审 M3 抓出）**：初稿写「JSON 序列化天然不产生这些标记」—— **这是错的**，`JSON.stringify("<invoke")` 原样输出 `<invoke`，JSON 从不转义 `<`。凡是「某某天然不会发生」的论证都该当场怀疑。
   - **真实可达的那条腿**：请求侧 `removeAnthropicSystemReminders` **确实会编辑 assistant 消息里的 text 块**（[system-reminders.ts:76-86](../../src/lib/anthropic/sanitize/system-reminders.ts#L76)）。若 transcript 里含成对的 `<system-reminder>…</system-reminder>`，下一轮回流时我方会把自己写的文本剪掉一截。
   - **一条经复核**不**成立的腿（评审的因果链需修正）**：评审称 `recover-tool-call` 会把 transcript 里的 `<invoke name="X">` 重建成假 `tool_use`。**核后不成立** —— `recoverToolCall` 是 order 100、`serverToolFilter` 是 order 300（[rewrite-registry.ts:179-181](../../src/lib/pipeline/rewrite-registry.ts#L179)），recover 在 filter **之前**跑，看不到 filter 才合成出来的 transcript；而下一轮 transcript 是以**请求**身份回流的，请求侧根本没有 recover（它只有响应侧的 `lnInResponse` / 流式 adapter）。
   - **即便如此仍然要编码**：我方产出会作为客户端历史回流，任何未来新增的、扫描请求侧文本的重写器都会踩上；而「现在够不着」不是安全论据（前置 spec 的教训原文：「客户端原生不会产出这种形态」不是安全论据）。
3. **不含 `<system-reminder>`** —— 由第 2 条的 `&lt;` 编码保证，而不是由「转义」这种含糊说法保证。
4. **前缀不与既有合成标记字面量冲突。** 现有的 destack 分隔符是 `[copilot-api: thinking separator]`，本 spec 的是 `[copilot-api:server-tool]` —— 两者不互为前缀，测试中可分别精确匹配。

---

## 6. 流式 N→1 状态机（HIGH-5）

### 6.1 实测帧形态（降低难度的关键事实）

事故取证里的真实上游帧（`tool_search`）：`server_tool_use` 的 `input` 经 `input_json_delta` 分片送达；**`tool_search_tool_result` 的完整 `content` 就在它的 `content_block_start` 帧里**，其后只有一个 `content_block_stop`，没有 delta。

即便如此，v2 的算法**在 `content_block_stop` 处才渲染并发射**，中途的任何 delta 一律累积。这样：对已实测的 tool_search，累积路径天然是空操作；对未实测的其余五类，即使它们改用 delta 送内容也照样正确 —— **不需要先做实测就能安全实施**（§4.5）。

### 6.2 状态

每个响应一份（`createState`）：

| 字段 | 类型 | 用途 |
|---|---|---|
| `mode` | `"provenance" \| "legacy-suppress"` | 由 `env.clientFormat` 决定（§3.1）；`legacy-suppress` 分支的行为与今天逐字节一致 |
| `nextClientIndex` | `number` | 客户端索引分配器 |
| `clientIndexMap` | `Map<upstreamIndex, clientIndex>` | 仅记录**透传**块（含原样转发的 server-tool 块） |
| `invocations` | `Map<upstreamIndex, PendingInvocation>` | 待降级的 `server_tool_use`，累积 `input` |
| `invocationById` | `Map<serverToolUseId, upstreamIndex>` | 供 `caller.tool_id` 与 `tool_use_id` 配对 |
| `passthroughIds` | `Set<serverToolUseId>` | 原样转发的 invocation id（其结果也须原样转发） |
| `downgradeResults` | `Map<upstreamIndex, {toolUseId, phase: "started" \| "closed", contentAtStart, deltas[]}>` | 待降级的结果块累积区。**`phase` 必须显式区分**：只有 `started` 而流就结束了，是一条真实可达的丢数据路径（见 §6.3 flush） |
| `suppressed` | `Set<upstreamIndex>` | 已被抑制的上游索引（delta/stop 据此路由） |
| `emitted` | `Set<upstreamIndex>` | 已发射过 transcript 的**单元**。**去重键必须是 upstream index，不能是 `server_tool_use.id`** —— 见下方红框 |
| `buffered` | `{ phase: "idle"\|"buffering"\|"replaying", frames: UpstreamFrame[], bytes, startedAtMs }` | `UNRESOLVED` 触发的局部缓冲区与子状态机（§4.3.1） |
| `awaitingParentIds` / `unresolvedChildIndicesByParentId` / `forcedDowngradeIndices` | `Set<toolId>` / `Map<toolId, Set<upstreamIndex>>` / `Set<upstreamIndex>` | 三者**键域不同、不可合并**，见 §4.3.1 的字段表 |

> **emission identity 必须是 upstream index（首轮复评 R2-M2 抓出的自相矛盾）**
> v2 前稿用 `Set<serverToolUseId>` 去重，与两条既定要求**直接打架**：§4.3.1 要求重复 `server_tool_use.id` 的后到块「独立成一个单元」，§6.5-4 要求同一 `tool_use_id` 的第二个结果「再发一次」。一旦第一个单元发射，该 id 就进了集合，第二个单元永远表示不出「尚未发射」→ **被吞掉**；顺序反过来同样吞一个。
> **upstream index 在一个响应内天然唯一且稳定**，是正确的 emission identity。`tool_use_id` 只用于**关联**（配对 invocation ↔ result）与**标注** duplicate，**不得兼任发射身份**。

### 6.3 逐事件动作表（`mode === "provenance"`）

> **前置分派**：`buffered.phase === "buffering"` 时，**任何**到达的帧一律先入缓冲并 suppress（§4.3.1 子状态机），不进下表；只有 `idle` 与 `replaying` 两个相位才按下表逐事件处理。这保证「缓冲期不改变相对顺序」这条不变量只在一处表达。

| 事件 | 条件 | 动作 |
|---|---|---|
| `content_block_start` | 非 server-tool 块 | 分配客户端索引（§6.4）→ 现有 `restoreToolUseName` → 索引重写 → **emit** |
| | `server_tool_use`，provenance = client-declared | 记 `passthroughIds`、`invocationById` → 分配索引 → **emit**（原样，仅索引重写） |
| | `server_tool_use`，provenance = proxy-injected/未知 | 建 `PendingInvocation`、记 `invocationById`、加入 `suppressed` → **suppress**（此时**不**分配索引） |
| | `*_tool_result`，其 `tool_use_id ∈ passthroughIds` | 分配索引 → **emit**（原样） |
| | `*_tool_result`，其 `tool_use_id` 属待降级 invocation | 建 `downgradeResults` 项（`phase: "started"`）、暂存 start 帧里的 `content`、加入 `suppressed` → **suppress** |
| | `*_tool_result`，孤儿（配不上任何 invocation） | 同上，`invocation = null` → **suppress**（在 stop 处渲染成 invocation-unknown transcript） |
| `content_block_delta` | `index ∈ invocations` | 追加 `input_json_delta.partial_json` → **suppress** |
| | `index ∈ downgradeResults` | 追加原始 delta（供未来 delta-送内容的结果类型）→ **suppress** |
| | 其他 | 索引重写 → **emit** |
| `content_block_stop` | `index ∈ invocations` | 标记 invocation 已闭合（`input` 解析定型）→ **suppress**（**不**在此渲染，结果还没到） |
| | `index ∈ downgradeResults` | 置 `phase = "closed"` → **渲染并发射 transcript 三元组**（见下）→ 原 stop 帧 **suppress** |
| | 其他 | 索引重写 → **emit** |
| 其他事件（`message_start` / `message_delta` / `message_stop` / `ping` / `error`） | —— | 原样 **emit**（不含索引，无需处理） |

**transcript 三元组**（在结果块的 `content_block_stop` 处发射，k = 此刻分配的客户端索引）：

```
content_block_start  index=k  content_block={type:"text", text:""}
content_block_delta  index=k  delta={type:"text_delta", text:<renderServerToolTranscript(...).text>}
content_block_stop   index=k
```

三帧全部 `tagFrameSynthetic(frame, "server-tool-downgrade")`（§8）。每帧都带 `event:` 行（SSE 契约，否则 `@anthropic-ai/sdk` 的 SSEDecoder 会静默丢帧 —— 现有 golden 的 `assertEventLineInvariant` 已在锁这一条）。

**`flush`（流结束时，正常与异常都会跑 —— 见 §6.5-6）**：遍历**全部**尚未发射的单元，按**上游索引升序**逐个发射 transcript 三元组：

| 未发射单元的形态 | 渲染入参 | 标注 |
|---|---|---|
| invocation 已闭合，从未见到结果 | `result = null` | 「结果未送达」 |
| invocation 已闭合，结果 `phase === "started"`（start 已到、stop 未到） | 用**已累积**的 `contentAtStart + deltas` 渲染 | **`incomplete`** —— 内容可能不完整 |
| invocation 未闭合（`input` 尚在累积） | 用已累积的 `rawInput` 渲染 | `incomplete` |
| 孤儿结果 `phase === "started"` | `invocation = null` + 已累积内容 | `incomplete` + 「未见对应调用」 |

> **这条是 v2 首轮评审抓出的真丢数据路径（M2）**：v2 初稿的 flush 只遍历「未配对的 invocations」，于是序列 `use start/delta/stop → result start → EOF` 会把 use 与 result 同时 suppress 而一个字都不发 —— 直接违反决策 2「降级而非丢弃」。**遍历范围必须是「所有未发射单元」，不是「所有未配对 invocation」。**

### 6.4 索引分配规则：**emission-order**

**规则**：客户端索引在**发射的那一刻**按 `nextClientIndex++` 分配，不在「上游首见」时分配。

- 待降级的 invocation 在 start 时**不**占索引，其 transcript 在结果的 stop 处才占 —— 因为 Anthropic 的内容块是**顺序**的（同一时刻只有一个块打开），此间不会有别的块插入，所以 emission-order 与「密集重映射」结果相同，且不依赖块不交错这一假设也依然产出**密集、单调、与发射顺序一致**的索引。
- **identity 不变量**：本次响应若没有发生任何降级（全 passthrough 或根本没有 server-tool 块），则 `∀ i: clientIndex(i) === i`。这就是评审那条「原样分支不进 densify」的可执行版本（§0）。由 golden 锁定。
- 只要发生过降级，后续所有块的客户端索引整体前移 —— 这是**必然且正确**的，SDK 按索引写入数组，密集单调即可。

### 6.5 边界情形（七条，逐条给出动作）

| # | 情形 | 动作 |
|---|---|---|
| 1 | 一个响应里多个 pair | 各自独立走状态机；`invocationById` 按 id 区分，互不干扰 |
| 2 | 嵌套调用（`caller.tool_id` 非 direct） | provenance 沿 graph 继承（§4.3）；父未见则按 §4.3.1 局部缓冲、根判为未声明则整棵树降级；每个 `server_tool_use` 各自成一个 transcript（**不**合并成一段），保持与上游块数的可追溯对应 |
| 3 | 孤儿结果（`tool_use_id` 配不上） | 渲染 `invocation = null` 的 transcript，文本显式标注「未见对应调用」→ 仍然发射。**绝不静默丢**（丢弃正是本事故的病灶） |
| 4 | 重复结果（同一 `tool_use_id` 出现第二个结果块） | 视为独立 transcript 单元再发射一次，文本标注「duplicate result」。信息优先于去重 |
| 5 | invocation 无结果，流正常结束 | `flush` 发射 `result = null` 的 transcript（§6.3） |
| 6 | 结果块 start 已到、stop 未到就结束（无论正常 EOF 还是上游抛错） | `flush` 用已累积内容发射并标 `incomplete`（§6.3 表第二行）。**`flush` 位于 `finally` 内**（[response-processor.ts:213-214](../../src/lib/pipeline/stream/response-processor.ts#L213)，同文件 :221 注释明写「上游抛错会在 `finally` flush 之后才继续传播」），所以异常路径**照样执行** —— 不能假设「异常了就没机会补」。唯一例外是客户端已断开：帧仍会被发射，只是无人接收，这与转发轨本就截断一致 |
| 6b | 上述发射失败 / 客户端已断开 | 不做额外补偿。完整信息在上游轨（§8.3），补一段文本反而伪造完整性 |
| 7 | `input_json_delta` 拼出的 JSON 不可解析 | 保留 `rawInput` 原始串，`input = undefined`，渲染时输出原始串（截断）。绝不因解析失败丢掉调用参数 |

### 6.6 非流式（`transformWhole`）对应算法

同一份 provenance 判据与同一个渲染函数，在整块 `content` 数组上做一遍：

1. 建 `invocationById`（扫一遍 `server_tool_use`）。
2. 逐块判 provenance（含 `caller.tool_id` 继承）。
3. 输出新 `content` 数组：passthrough 块原样保留；每个待降级 pair 折叠成**一个** `{type:"text", text}` 块，**放在原 `server_tool_use` 的位置**（保持相对顺序）；孤儿结果同样折叠成 text 块并留在原位。
4. 现有的 `restoreToolNamesInResponse` 顺序不变（仍在 filter 之后，order 300 内）。
5. 记录 ctx 侧信道（§8.2）。

流式与非流式**必须产出相同的文本**（同一 `renderServerToolTranscript`），由验收标准 §10-4 交叉锁定。

---

## 7. 请求侧交互与优先级矩阵（CRITICAL-2 / HIGH-6）

### 7.1 放弃「从历史重建 server tool 声明」（CRITICAL-2）

v1 §4.3 要求「只要历史里有引用某 server tool 的 `server_tool_use` 块，就无条件重新声明该 server tool」。**这在信息上不可能**：

- 历史块里只有 `name`（如 `web_search`），而声明需要 **`type`**（`web_search_20250305` 还是 `web_search_20260209`？）以及可选参数（`allowed_domains` / `max_uses` / `user_location` / `allowed_callers` / `defer_loading`…）。这些**从来没出现在响应里**，也不在历史消息里。
- v1 说它与普通-tool 安全网 `buildHistoryToolStubs`「同构」—— **不同构**。普通 tool 的 stub 只需要 `{name, input_schema:{type:"object"}}`，一个空 schema 就能让上游放行；server tool 没有「空 schema」这种退化形态，`type` 猜错就是另一个 400。

**改为**：不重建。orphan 风险由 §7.3 的共享判据**事前避免**，残余由 §7.4 的反应式 learned downgrade **事后自愈**。

### 7.2 现状：请求侧有五个决策点，分散在两个阶段

| # | 位置 | 阶段 | 做什么 |
|---|---|---|---|
| 1 | `preprocessTools`（[message-tools.ts:177](../../src/lib/anthropic/message-tools.ts#L177)） | S3 order 100 | 注入 `tool_search_tool_regex` 声明（config × 能力 × 请求带 tools） |
| 2 | `rewriteServerToolBlocks(msgs, resolveServerToolMode(model))`（[sanitize/index.ts:109](../../src/lib/anthropic/sanitize/index.ts#L109)） | S3 order 300 | learned 命中时降级**全部**历史 server-tool pair |
| 3 | `downgradeEmptyEncryptedSearchResults`（[sanitize/index.ts:118](../../src/lib/anthropic/sanitize/index.ts#L118)） | S3 order 300 | always-on 窄兜底（空 `encrypted_content`） |
| 4 | `processToolBlocks` | S3 order 300 | 校验 `tool_use` 引用 |
| 5 | `stripServerTools`（[request-preparation.ts:579](../../src/lib/anthropic/request-preparation.ts#L579)） | **S4-pre**（`buildWirePayload`） | 按 learned-unsupported type 前缀 + `prepareHints.excludeServerToolTypes` **删除声明** |

**根因**：#2 决定「历史 pair 留不留」，#5 决定「声明留不留」，两者**在不同阶段、用不同判据**各自决策，彼此看不见。于是可以产出「历史 pair 保留、但声明被删」的 wire —— 一个必然 400 的组合。

### 7.3 不变量与根因修复

**wire 级硬不变量**：

> ∀ 出站 payload 中残留的 `server_tool_use{name}` → `wire.tools` 必须含一个 `name` 全等、且 `type` 落在 §4.2 表内前缀的声明。

**修法（长远正确，不打补丁）**：抽出单一判据函数

```ts
/** 本轮最终会出现在 wire 上的 server-tool 声明集合（唯一事实源） */
resolveEffectiveServerToolDeclarations(tools, model, hints): Map<name, typePrefix>
```

- **S4-pre 的 `stripServerTools` 用它执行删除**（今天的判据下沉进来）。
- **S3 的 pair-downgrade 用它做决策**：凡是历史 pair 引用的 name 不在返回集合里 → 该 pair 必须在**同一次 attempt 内**降级。

这样两个决策点共用一个判据，时序错位从根上消失。所需接线：`env.prepareHints` 已在 envelope 上（[envelope.ts:111](../../src/lib/pipeline/envelope.ts#L111)），把它透进 `AnthropicRewriteContext` 即可（[request-rewrite-adapter.ts](../../src/lib/codec/anthropic/request-rewrite-adapter.ts) 一处接线）；retry 腿本就会用新 hints 重跑 S3（`resanitize(context.originalPayload)`，[web-search-not-found-retry.ts:71](../../src/lib/request/strategies/web-search-not-found-retry.ts#L71)），无需额外机制。

pair-downgrade 的执行位置保持在 `processToolBlocks` **之前**（与今天的 #2 同位），使降级后的 plain `tool_use`/`tool_result` 能被引用校验看到。

### 7.4 优先级矩阵（逐 pair 判定，自上而下首命中）

| # | 条件 | 动作 | 理由 |
|---|---|---|---|
| 1 | 该模型 learned `serverToolDowngrade` 生效 | **降级全部 pair** | 最宽、已被上游明确拒绝过，优先级最高（现有行为，不改） |
| 2 | pair 引用的 name **不在** `resolveEffectiveServerToolDeclarations` 结果里 | **降级该 pair** | 覆盖两种情形：客户端本轮不再声明；声明将被 learned/hint 删除 |
| 3 | pair 是 `web_search` 且结果 `encrypted_content` 为空/缺失 | **降级该 pair** | 现有 always-on 窄兜底（#3），保持 |
| 4 | 其余 | **保留 pair** | 声明在、上游认，原样喂回去 |

**新方案带来的一个结构性收益**：我方注入的 `tool_search` pair 在**响应侧**就被降级成 text 了，客户端历史里根本不会出现 `server_tool_use{tool_search}` —— 于是「某轮 `clientTools=0` 导致不注入 tool_search 声明、而历史里有它的 pair」这条 orphan 路径**被彻底消除**，而不是靠矩阵兜住。矩阵剩下要兜的只有**客户端自己声明**的那类。

### 7.5 反应式兜底的闭合（含一个现存缺口）

矩阵是事前预测，仍可能因上游行为变化而漏判。事后自愈腿：

| 400 措辞 | 当前是否被识别 | 处置 |
|---|---|---|
| `Tool 'X' not found in provided tools` | **是** —— [web-search-not-found-retry.ts:43](../../src/lib/request/strategies/web-search-not-found-retry.ts#L43) 的 `/Tool '[^']+' not found in provided tools/i`，**正则对工具名是通用的**（文件名叫 web-search 只是历史遗留） | 无需改动。命中 → `markServerToolDowngrade(model)` → 从 pre-S3 baseline 重跑 sanitize → 全部 pair 降级 → 重试 |
| `` `server_tool_use` block references `X`, but `X` is not defined in `tools` as a server tool `` | **否** —— 全仓无 matcher（`server-tool-rejection-retry.ts` 的表只有一行 `the use of the web search tool is not supported` → `web_search_`） | **本 spec 要求补**：作为同一条 learned-downgrade 腿的第二个 pattern。措辞出处是 `rewrite-server-tool-blocks.ts` 模块注释（仓库内既有观测，**本次未重新实测**，实施时以 mock 注入该 400 验证 matcher 触发即可，不需要真打上游） |

**两项配套（长远正确，不可省）**：

- **文件更名** `web-search-not-found-retry.ts` → `server-tool-not-provisioned-retry.ts`，策略名同步。现名与其通用正则**名实不符**，会误导下一个人以为只管 web_search（项目原则：闻到名实不符当场报警、当场改）。
- **TTL 到期会复发**：learned 条目有 TTL（`isEntryActive`，[feature-negotiation.ts:393](../../src/lib/anthropic/feature-negotiation.ts#L393)），到期后同一个 400 会再撞一次并再次自愈。**这是可接受的**（每 TTL 窗口最多一次 400 且能自愈），但必须写明，免得后人把它当成新 bug 排查。

---

## 8. synthetic 标记（MED-7）

### 8.1 流式：四个落点

新增 kind `"server-tool-downgrade"`，四处必须同步（前两处是类型定义，后两处是**内联字面量 union**，两者不共享类型，漏掉一处不会有编译错误）：

| # | 位置 | 内容 |
|---|---|---|
| 1 | [frame-origin.ts:29](../../src/lib/pipeline/frame-origin.ts#L29) `SyntheticOriginKind` | 加入新 kind |
| 2 | [model-operation-record.ts:42](../../src/lib/context/model-operation-record.ts#L42) `OperationSyntheticKind`（超集，含 `anchor`/`hook-mock`/`hook-replay` 等帧标记用不到的 kind） | 加入新 kind |
| 3 | [client-sink.ts:204](../../src/lib/pipeline/client-sink.ts#L204) —— **SSE 腿** `sampleForwarded` 的内联 union（8 个成员） | 加入新 kind |
| 4 | [client-sink.ts:613](../../src/lib/pipeline/client-sink.ts#L613) —— **WS 腿** `sampleForwarded` 的内联 union（6 个成员，比 SSE 腿少 `anchor`/`synthetic-message-start`） | 加入新 kind —— v1 漏了这一处 |

> 两个内联 union 成员数**本来就不一致**，说明它们已经各自漂移过。实施时顺手把两处收敛到从 `OperationSyntheticKind` 派生（`Exclude<...>` 或直接引用），从根上消灭「加一个 kind 要改四个地方」—— 这属于 §12 的顺手解环，不是本 spec 的必要条件，但也不许因为「不是必要的」就跳过记录。

transcript 三元组的**每一帧**都打标（不只 start）：中途只看到 delta 的消费者也必须能判断它是合成的。

### 8.2 非流式：三重机制（帧标记在此不可用）

`transformWhole` 处理的是整个 JSON body，没有帧可打标，且**不能**往 Anthropic 契约形状的 text 块里塞自定义字段（SDK 校验风险）。故用三条并行机制：

1. **in-band 文本前缀** `[copilot-api:server-tool]`（§5.3）—— 唯一能承载在非流式 body 内的标记，且它对流式同样生效，两条腿形态一致。
2. **ctx 侧信道**（流式/非流式**统一**走这条）：`ctx.recordFeature("server-tool-downgraded", { tools: [...names], pairs: N, orphanResults: M, incomplete: K })` + 写入 `pipelineInfo`，使 history 可审计、UI 可展示。这条是结构化 provenance 的主承重，不依赖文本启发式。
3. **双轨 diff**（§8.3）。

### 8.3 双轨语义

- **上游轨**（`attempts[].upstreamResponse.sseEvents` / 非流式 `sourceBody`）：保留**原始 server-tool 块**，逐字节不动 —— 这是 Option A 的既有约定（现有 golden `lastOutboundContent()` 已在锁）。
- **转发轨**（`clientResponse.sseEvents` / `setForwardedResponse`）：记降级后形态并带标记。

两轨 diff 即完整记录，任何被降级的信息都可从上游轨还原。渲染的截断（§5.2）只作用在转发轨，**上游轨永不截断**。

---

## 9. 存量坏数据的修复机制

已 baked 进客户端本地历史的相邻 thinking **无法还原原始内容**（客户端那边只剩两个 thinking 块，被剥离的 server-tool 块已不在它的历史里）。

- **L1 `repairAssistantBlockLayout` 保留**（已 landed，见前置 spec；2026-07-27 由并发会话从 `destack-adjacent-thinking.ts` 更名为 [assistant-block-layout.ts](../../src/lib/anthropic/sanitize/assistant-block-layout.ts)，接手时以实际文件名为准）：它是存量坏数据唯一的修复路径，职责正当，**不因本 spec 而退役**。
- **不从我方 history 反查还原**：技术上可行（上游轨存着原始块），但会让请求路径依赖 history 可用性，且对已归档/已降温记录不可靠。**明确不做**。
- 本 spec 落地后**新产生**的对话不再出现此形态，L1 对新历史趋于 no-op —— 但**不能**据此下调 L1 的优先级或删测试（旧历史会存在很久）。

---

## 10. 验收标准（HIGH-8）

每条都给出**证伪方式**（怎样才算真的被验证到，而不是「跑绿了」）。

| # | 标准 | 证伪方式 |
|---|---|---|
| 1 | 客户端声明的 server tool（typed 声明）→ 响应侧**逐字段原样**转发 | e2e：mock 上游 + 真 `@anthropic-ai/sdk`，请求声明 `web_search_20260209`，上游回 `server_tool_use{web_search}` + `web_search_tool_result`。断言**不是**「两块存在」而是**对冻结上游 fixture 逐块逐字段深等于**（含 `id` / `caller` / `input` / `content[].encrypted_content`）。**mutation**：让实现改写 `encrypted_content` 或 `caller` → 必须变红。只断「SDK 没抛错 + 两块在」的实现可以随意改写字段仍然绿 |
| 2 | 我方注入的 `tool_search` → 降级为**单个**带标记 text 块，含真实工具引用 | 用 `req_1785016247905_895` 的真实上游帧作**冻结 fixture**，断言转发轨含 `Task` / `Agent` / `SendMessage` 字面量，且 `server_tool_use` / `tool_search_tool_result` 一个字都不出现 |
| 3 | **核心回归**：上游 `[thinking, server_tool, server_tool_result, thinking, tool_use]` 经转发后客户端轨**不得出现相邻 thinking** | 同上 fixture；断言转发轨块序列为 `[thinking, text, thinking, tool_use]`。**positive control**：把降级分支临时改回「直接 suppress」，此断言必须变红 |
| 4 | 流式与非流式产出**相同文本** | 同一 fixture 分别走 SSE 与 JSON 两条腿，断言两侧 text 块内容全等 |
| 5 | 渲染契约穷尽性 | 单测覆盖 §5.2 表**每一行**（含未知类型行）；`tool_search_tool_search_result` 断言 `isError === false` 且文本含真实 tool 名。**positive control**：把旧 `stringifyServerToolResultContent` 接回去，该断言必须变红 |
| 5b | 尖括号编码契约（§5.4-2） | 构造结果正文内含**完整且工具名命中**的 `<invoke name="Bash">…</invoke>` 与 `<system-reminder>…</system-reminder>`，走**真实 rewrite 顺序**并**回流第二轮**：断言既没被重建成 `tool_use`、也没被 system-reminder 剥离剪短。**只单测 renderer 字符串不够** —— 那证明不了管线里没有反向 decode |
| 6 | identity 不变量 | 无降级的响应逐字节等于 golden。**oracle 必须在改动前冻结**（先在当前 master 上把 raw bytes 落成固定文件），**禁止**由新实现重生成 golden —— 否则实施者更新一下 golden 就自洽了 |
| 7 | 请求侧 wire 不变量（§7.3） | property 测试扫**最终 prepared wire**，且期望值由**独立 oracle**计算，**不得**复用 `resolveEffectiveServerToolDeclarations`（同源会让 S3/S4 一起错、一起绿）。必须包含一条**真实驱动** server-tool rejection 策略产生 `prepareHints.excludeServerToolTypes` 的 retry 路径，断言**同一个 attempt 内** pair 降级与声明删除同时发生 |
| 8 | 兜底 matcher 闭合 | 用 upstream hook 注入两种 400 措辞，各断言触发 learned downgrade + 重试；**positive control**：删掉新加的 pattern，第二条必须变红 |
| 9 | 非 anthropic 客户端行为**零变化** | 三个象限**分别点名**真实测试与各自 raw-byte oracle，不能用「现有 golden」一句泛称：CC → `/v1/messages`、Responses → `/v1/messages`、Gemini → `/v1/messages`（[tests/gemini/reverse-gemini-messages.it.test.ts](../../tests/gemini/reverse-gemini-messages.it.test.ts)）。同样要求改动前冻结 oracle |
| 10 | **两轮 e2e**（本事故的真正形状是跨轮的） | 第 1 轮：客户端拿到降级后的响应；第 2 轮：把第 1 轮的响应原样 baked 成历史再发一次 → 断言出站 payload 合法（无相邻 thinking、无 orphan server_tool_use）且**没有触发任何 L1 修复**（`blockLayout` 统计为 0）。单轮 e2e 结构上证不了这一点 |
| 11 | history 双轨 | 上游轨保留原始块；转发轨带 `server-tool-downgrade` 标记；`ctx` feature 记录存在 |
| 12 | 全量门 | `bun run test:backend` 绿 + `bun run typecheck` 绿 + **`bun run typecheck:ui-v4`** 绿 + **`bun run build:ui-v4`** 绿（根 `typecheck` 不覆盖 ui-v4；注意 `build:ui` 是 **Vue 的 `ui/`**，不是 ui-v4） |
| 13 | flush 三形态不丢数据（§6.3 flush 表） | 三条序列各一测：`use stop → EOF`、`use stop → result start → EOF`、`use stop → result start → result delta → EOF`。**每条都必须发出 transcript**。**positive control**：把 flush 的遍历范围改回「只遍历未配对 invocation」（即 v2 初稿的写法）→ 第 2、3 条必须变红 |
| 14 | `UNRESOLVED` 局部缓冲（§4.3.1） | 构造 `child(caller=P) → parent(P, client-declared) → …`：断言 child **最终原样转发**（不是降级）、且缓冲区里夹着的**普通块按原序 passthrough**（不被卷进 transcript）。**positive control**：把缓冲改回「立即降级」→ 必须变红 |
| 14b | 上界触顶 + 锁存作用域（§4.3.1 重放规则 3） | 构造：进入缓冲 → 帧数触顶 → child 强制降级 → **父随后到达且判为 `CLIENT_DECLARED`**。**逐块断言**：child 的 use 与 child 的 result **都降级**（同一 pair 一致）；而**父自己的 use 与父自己的 result 照常 passthrough**（不同 pair，不被拖下水）。另测字节触顶、惰性时长触顶（fake clock + 下一帧驱动） |
| 14c | 多父逐个解析后**一次**重放（§4.3.1 转移表） | 构造 `childA→PA, childB→PB, PA, PB` 且不触任何上界：断言 **childA 与 childB 都 passthrough**（`awaitingParentIds` 清空才重放）。**positive control**：改回「任一父出现即重放」→ childB 变降级 → 必须变红。另测 PB 永不到达：由上界统一强制降级 childB，而 childA 仍 passthrough |
| 14d | 重放不二次入缓冲（重放规则 2） | 触顶路径下缓冲区内**再有**一个 `UNRESOLVED`：断言重放不递归、直接强制降级、整体终止 |
| 15 | emission identity（§6.2 红框） | 三条：同一响应内**重复** `server_tool_use.id` 两个单元、同一 `tool_use_id` 的**两个** result、两者组合。断言**每个单元都发射了**、一个不少。**positive control**：把去重键改回 `serverToolUseId`（即前稿写法）→ 三条必须全红。**fixture 前提**：三组都必须走 downgrade transcript 路径并逐 upstream-index 计数，否则 passthrough 样本会绕开 `emitted` 让 mutation 失去分辨力（第三轮复评指出） |
| 16 | 畸形输入 + 未知 caller 不被误放行（§4.3 入口校验 + 白名单） | 逐个构造：缺 `caller`、`caller: null`、**未知 `caller.type` 且带合法 `tool_id` 指向一个 client-declared 根**（必须判 `UNKNOWN_CALLER` → **降级**，**不得**继承成 passthrough —— 这是 R3-M3 指出的绕过口子）、`tool_id` 空串/非字符串、`id` 空串。断言：全部不抛、按 §4.4 first-match 归到预期分支、warn 归因唯一 |

| 17 | wire 的 server-tool `name` 唯一性（§4.3.0 的前提） | 三组：客户端声明**同 name 同 type**、**同 name 不同 typed variant**、**同 name 的 custom function**。断言最终 wire 上该 name **只有一条**声明，且 provenance 判定确定。**positive control**：恢复无条件注入（即今天的行为）→ 三组必须全红 |
| 18 | idle hook 契约与竞态（§4.3.1，用户 A 级裁决） | fake timer 驱动，逐条：**无任何新帧时 5s 主动触发**（这是惰性检查做不到、必须靠 hook 的那条）、frame-vs-idle 单一赢家、flush-vs-idle 单一赢家、两个定时器互不重置、`onIdle` 产物**仍继续过后续 rewrite**（order > 300 的 refusal 腿）。**positive control**：把 `onIdle` 改成 no-op → 第一条必须红 |

**关于 positive control 的元要求**（不写会得到假的安心）：每一条 positive control 都必须**先确认 mutation 真的生效了** —— 断言没变红有两种解释：测试没咬住，或者 mutation 根本没打到运行路径（改错文件、改到没被调用的分支、被缓存挡住）。**必须先证明「改动确实进入了被测代码路径」，再解读红/绿。**

**需要更新的既有 golden（预期会变，属正常）**：

- `tests/anthropic/response-rewrite-golden.http.test.ts` S1（[:148](../../tests/anthropic/response-rewrite-golden.http.test.ts#L148)）：fixture 是**无结果**的 `server_tool_use{web_search}`，请求不带 tools → 新行为走 §6.3 的 `flush` 分支，转发一个 invocation-only transcript。现有断言 `expect(text).not.toContain("web_search")` 必然失败 —— 应改为断言降级文本形态，而不是简单放宽。
- 同文件 S6Filter（[:841](../../tests/anthropic/response-rewrite-golden.http.test.ts#L841)）：非流式 `content` 从 `[text]` 变为 `[text(transcript), text("after search")]`。

---

## 11. 明确未做 / 待办 / 未闭合问题

1. **GPT/Gemini 客户端的 server-tool 语义** → Phase 6，清单见 §3.3。
2. **`usage.server_tool_use` 计数器不做裁剪**：降级分支不改 `message_delta` 里的 usage 字段。它是计量元数据、不是内容块，且 richest-data-flow 反对中途裁剪。若将来发现某 SDK 因「有 server_tool_use 计数但无对应块」而报错，再按实测立案。
3. **客户端已断开时不做额外补偿**（§6.5-6b），理由：不伪造完整性。注意**不是**「异常就不 flush」—— `flush` 在 `finally` 里，上游抛错照样跑（这条在 v2 初稿里写错过，首轮评审 M2 纠正）。
4. **嵌套 server tool 的真实帧序列未实测**（§4.5），但**不阻塞实施** —— §4.3.1 的局部缓冲对「父稍后到」与「父永不到」两种情形都给出了确定行为。探针是**优化门**而非裁决门：在能构造 `code_execution` 嵌套调用的模型上抓真实帧，确认 `caller.tool_id` 的指向语义与帧顺序；**若**证明协议保证 parent-before-child，则缓冲路径永不触发、可以整个删掉；**若**探针构造不出来，缓冲路径就留着（正常响应零代价）。两种结果都有出路，不存在「卡在探针上」的可能。
5. **请求侧 `downgrade` 模式与响应侧降级不合并**：两侧目标不同（请求侧喂上游、可转 `tool_use`；响应侧喂客户端、只能转 text），**仅共享 `renderServerToolTranscript`**。
6. **架构张力记录**：「代理侧优化的副产品要不要对客户端可见」—— 本 spec 选择「不可见但不丢信息（降级）」。tool_search 已裁决保留，故这条张力会长期存在。
7. **`memory` 工具的请求侧重写**（[request-preparation.ts:983](../../src/lib/anthropic/request-preparation.ts#L983)，把客户端的 `{name:"memory"}` 改写成 typed `memory_20250818`）是我方对客户端声明的改写，但 memory 是**客户端执行**的（产 `tool_use` 而非 `server_tool_use`），不在本 spec 判据范围内。记录于此，免得后人误以为漏了一条 provenance 路径。
8. **缓冲上界（§4.3.1）先做成具名常量，不做成 config** —— 它守的是一条可能永不触发的异常路径，此刻做成 config 等于给运维多一个无从判断怎么调的旋钮。**触发条件明确写在这里**：一旦生产上观测到缓冲触顶计数非零，立即按 §12.4 的全链把它提升为 config。这是**延后**，不是取消。
9. **三个「给 provenance 找载体」的方案已被逐一否决**（记录理由，免得后人重走）：
   - `ctx`：请求域、**跨 candidate 共享**，hedge / recovery candidate 会互相覆写 —— 正中既有教训 `request-scoped-mutable-verdict-poisoned-by-hedge-candidates`。
   - `requestState`：契约是 request-lifecycle-**STABLE**，`with()` 在 retry 时从不 patch 它；把 per-attempt 事实塞进 per-request 载体是语义倒挂。**更有一个静默陷阱**：[candidate-state.ts:102-113](../../src/lib/pipeline/generation/candidate-state.ts#L102) 的 `snapshotStableState` 是**字段白名单**（5 项），新增纯数据字段在 candidate fork 时**被静默丢弃**；而 [:91-100](../../src/lib/pipeline/generation/candidate-state.ts#L91) 的 `validateOpaqueFactories` 只硬编码 4 项 opaque 检查，**纯数据字段触发不了它** —— 护栏在这里接不住。
   - `prepareHints`：replace 语义，第一个带 hint 的 retry 就整个覆盖（这正是 `requestState` 当初被拆出来的原因）。
   - 往 tool 对象上打**私有字段**：已实测两头堵 —— 字符串字段**被 `structuredClone` 保留**并经 `buildWirePayload` 直达上游（`stripToolFields` 只删 strip 集合里的键，不是未知字段清扫），撞 `Extra inputs are not permitted` 400；Symbol **被 `structuredClone` 丢弃**，跨 S3→S4 承载不了。
   - **结论**：§4.3.0 的求交规则**不需要任何新载体**，这是它胜出的主要原因之一。
10. **`tool_search` 注入事实上关闭了 hedge**（附带发现，**不重开** §1.4 的裁决，只补记）：[hedge-policy.ts:132-135](../../src/lib/pipeline/generation/hedge-policy.ts#L132) 用 `classifyServerExecutionRisk(wire)` 判定，wire 带 `tool_search_` 前缀即算 server-executed，而 `allow_server_tools` 默认 false → **几乎所有带 tools 的 Claude Code 请求都 hedge 不合格**。§1.4 那份「保留 tool_search」的成本收益量化**没有把这一项算进去**。建议单独立项评估，不阻塞本 spec。
11. ~~**同名声明无 dedupe** 是独立于本 spec 的既有隐患，本 spec 不修、建议单独立项。~~ **2026-07-29 升为必修**（第七轮复评 R7-M1）：它不只是「隐患」—— 两条同名声明会让 provenance **在信息论上不可判**（响应块只带 `name`，没有 declaration identity），且 `"Tool names must be unique"` 是真实的上游 400 约束。**wire 对 server-tool `name` 强制唯一**是 §4.3.0 求交规则成立的**前提条件**，不是可选优化。落点见 §4.3.0 与 §10-17。

---

## 12. 实施影响面（穷尽清单，按接线分组）

> v2 初稿只列了「主要改动的源文件」，首轮评审 M4 证明这不够 —— 更名与共享 helper 的既有消费者会留下编译/测试/契约漂移。下表按**生产接线 / 导出消费者 / 策略注册与名字守卫 / 配置全链 / 既有测试**分组。带 ✅ 的位置是本次已实地核实存在的。

### 12.1 生产接线（新建 + 改写）

| 文件 | 改动 |
|---|---|
| `src/lib/anthropic/server-tool-transcript.ts` | **新建**：穷尽渲染契约 + `&lt;` 编码（§5） |
| `src/lib/anthropic/server-tool-provenance.ts` | **新建**：判据表 + graph 传播 + UNRESOLVED/CYCLE/重复 id（§4） |
| `src/lib/anthropic/server-tool-filter.ts` | 流式状态机重写（§6）+ 非流式 `transformWhole`（§6.6） |
| `src/lib/codec/anthropic/response-rewrite-adapters.ts` | `createState` 读 `env.clientFormat` 定 mode；ctx feature 记录 |
| `src/lib/anthropic/sanitize/rewrite-server-tool-blocks.ts` | 删 `stringifyServerToolResultContent`，改调共享渲染函数 |
| `src/lib/anthropic/message-tools.ts` / `request-preparation.ts` | 抽 `resolveEffectiveServerToolDeclarations`，`stripServerTools` 改用它（§7.3） |
| `src/lib/anthropic/sanitize/index.ts` | pair-downgrade 改为消费共享判据（§7.4 矩阵） |
| `src/lib/codec/anthropic/request-rewrite-adapter.ts` | 把 `env.prepareHints` 透进 `AnthropicRewriteContext` |
| `src/lib/pipeline/generation/candidate.ts` | **`createProcessor` 入参加 `wire`**（[:65](../../src/lib/pipeline/generation/candidate.ts#L65) 签名、[:103](../../src/lib/pipeline/generation/candidate.ts#L103) 调用点）—— `CandidateReady.wire` 已存在（[:41](../../src/lib/pipeline/generation/candidate.ts#L41)），只是没传下去 |
| `src/lib/pipeline/rewrite-registry.ts` | **① `ResponseRewrite` 新增 `onIdle?(state, idleMs)`**（idle hook 契约，§4.3.1）；**② `createState` / `transformWhole` 需要拿到 `wire`** —— 契约签名变更，所有实现方受影响 |
| `src/lib/pipeline/stream/response-processor.ts` | **idle 定时器 + serializer 的实际归属**：现只有上游 `for await` 与 `finally` flush（[:146-217](../../src/lib/pipeline/stream/response-processor.ts#L146)），没有任何 idle 驱动。要新增定时器、与 `transform`/`flush` 的互斥、以及 `onIdle` 产物继续过后续 rewrite 的链路 |
| `src/lib/pipeline/driver.ts` | **`runResponseWhole` 与 driver 公开结果契约**：现签名只收 `env`（[:1562](../../src/lib/pipeline/driver.ts#L1562)），成功 dispatch 的 `PreparedRequest` 在 candidate ready/result 上、**不在 env 里**。须把它作为**独立参数**贯通，并扩展 driver 的返回类型让上层拿得到 —— **绝不把 wire 塞回 `env` 冒充 request 状态** |
| `src/routes/messages/handler-v4.ts` | [:528](../../src/routes/messages/handler-v4.ts#L528) 现只解构 `{ upstream, env }`，须一并取 wire 并透传给 `renderNonStreamingV4` → `runResponseWhole` |
| `src/routes/debug/dry-run-pipeline.ts` | [:463](../../src/routes/debug/dry-run-pipeline.ts#L463) 是 `runResponseWhole` 的**第二个调用点**，签名变更必须同步 |
| `src/lib/anthropic/message-tools.ts`（注入点 178-205） | **wire 上 server-tool `name` 强制唯一**：客户端已声明同名合法 typed server tool 时不得再注入（§4.3.0 的前提条件） |
| `src/lib/pipeline/generation/hedge-policy.ts` | 与新 primitive **共同消费**同一份 server/client 前缀分类（§4.2），消除三表并存 |
| `src/lib/anthropic/message-tools.ts`（`API_DEFINED_TOOL_TYPE_PREFIXES`） | 保留原用途，加注释指向 primitive 并说明二者语义不同、不要混用 |

### 12.2 共享 helper 的既有消费者（改签名/语义前必须逐个看）✅

`isServerToolResultType` / `isServerToolBlock`（均导出自 `server-tool-filter.ts`）当前的生产消费者：

- `src/lib/anthropic/stream-accumulator.ts` —— 累积**上游原始**响应（Option A）。本 spec 不改上游轨，但它与 filter 共用谓词，重构谓词时必须确认它仍看到原始块。
- `src/lib/anthropic/sanitize/empty-encrypted-search-result.ts` —— always-on 窄兜底（§7.4 矩阵第 3 行）。
- `src/lib/anthropic/sanitize/rewrite-server-tool-blocks.ts` —— 请求侧 downgrade。

### 12.3 策略更名的全部连带点（§7.5 的更名）✅

`web-search-not-found-retry` → `server-tool-not-provisioned-retry` 时必须同步：

| 位置 | 内容 |
|---|---|
| `src/lib/request/retry-registry.ts:65` | `import { createWebSearchNotFoundRetryStrategy }` |
| `src/lib/request/retry-registry.ts:147` | `RETRY_STRATEGY_ORDER.webSearchNotFound: 510` |
| `src/lib/request/retry-registry.ts:282-285` | registry entry 的 `name` / `order` / `configKey` |
| `tests/helpers/retry-strategy-names.ts:33` | 策略名清单（名字守卫） |
| `tests/anthropic/anthropic-codec.unit.test.ts:132` | 期望策略名 |
| `tests/request/retry-registry.unit.test.ts:145,149` | `needsResanitize` 列表 |
| `tests/pipeline/web-search-not-found-retry.unit.test.ts` | 文件名 + 内容一并更名 |

> `configKey` 属于**配置对外契约**：更名会破坏用户 config 里已写的键。按项目「配置哲学独立」原则（配置**不**享受代码那样的「无向后兼容负担」），必须**保留旧键作兼容层 + 打 warn 继续**，不得直接改名硬失败。

### 12.4 配置全链（新增 `anthropic.server_tool_transcript_max_chars`）✅

一个新配置字段不是「改两个文件」，实际链路是：

`src/lib/config/schema.ts`（zod + `.describe()`，**注意：`config.schema.json` 只由 `.describe()` 生成，改 TSDoc 是 no-op**）→ `config.schema.json`（由导出脚本重生成，`tests/config/config-schema-json-export.unit.test.ts` 守卫）→ `src/lib/config/config.ts`（`setAnthropicBehavior({...})` 接线）→ `src/lib/state.ts` + `src/lib/state-defaults.ts`（运行态字段与默认值）→ `config.example.yaml`（示例与说明）→ **`tests/config/config-hot-reload.it.test.ts` 的 `FIELDS` 表（或 `EXEMPT` 并写明理由）** —— 这张表是硬守卫，漏加会红。

### 12.5 synthetic 落点 ✅

见 §8.1 的四行表（`frame-origin.ts` / `model-operation-record.ts` / client-sink SSE 腿 / client-sink WS 腿），此处不复述。

### 12.6 既有测试（会因新行为而失败或需扩展）✅

| 文件 | 原因 |
|---|---|
| `tests/anthropic/response-rewrite-golden.http.test.ts` | S1 / S6Filter golden 变化（§10） |
| `tests/anthropic/server-tool-rewriting.it.test.ts` | `createServerToolBlockFilter` / `filterServerToolBlocksFromResponse` / `stripServerTools` 的既有集成测试集中在此 |
| `tests/anthropic/request-server-tool-rewrite.unit.test.ts` | 请求侧 downgrade 的渲染文案随共享渲染函数变化 |
| `tests/gemini/reverse-gemini-messages.it.test.ts` | §10-9 的 Gemini 象限 oracle |
| 新增 | 渲染穷尽单测、状态机单测（含 flush 三形态）、provenance 判据单测（含 UNRESOLVED/CYCLE/重复 id）、property 不变量、两轮 e2e、兜底 matcher 测试 |
