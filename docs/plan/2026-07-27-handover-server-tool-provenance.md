# 交接：响应侧 server-tool 块按来源分流（spec 重写）

日期：2026-07-27
状态：**spec 已被评审否决，待重写**。前置工作全部 landed。
接手方式：见文末「Kick-off 提示词」，可直接复制到新会话。

---

## 1. 一句话交接

我方无条件剥离上游返回的 server-tool 块，把原本被隔开的两个 thinking 块并拢，害客户端把非法形态 baked 进历史，此后每轮必败 400。症状层已修完并 landed；**待做的是治病灶**——一份被对抗评审判为「应重新设计」的 spec，需按 3 个 CRITICAL + 5 个 HIGH 重写。

---

## 2. 已 landed，不要重做

### 2.1 症状层修复（thinking 布局三约束）

权威文档：[docs/spec/2026-07-26-thinking-terminal-block-layout.md](../spec/2026-07-26-thinking-terminal-block-layout.md)（含三约束的实测过程、C2 触发前提的二分定位、C3 追加事故）。

实测确立的上游硬约束（**全部亲手实测，非文档推断**）：

| | 约束 | 违规形态 | 400 措辞 |
|---|---|---|---|
| C1 | 最新 assistant 消息内两 thinking 不得相邻 | `[T, T, tool]` | `cannot be modified` |
| C2 | assistant 消息末块不得是 thinking（**仅对非首个 assistant 校验**） | `[T, tool, T]` | ``final block ... cannot be `thinking` `` |
| C3 | 含 tool_use 的消息必须以 tool_use 收尾 | `[T, tool, T, text]` | `does not support assistant message prefill`（措辞误导） |

合法形态：`[T,SEP,T,tool]` / `[T,SEP,T,SEP]`（合成 marker 可合法收尾）/ `[T,tool1,T,tool2]`（tool_use 夹中间合法，C3 只管末块）。

已落地：`repairAssistantBlockLayout`（2026-07-27 由 `destackAdjacentThinking` 更名）三约束全覆盖 + `terminalRepairs`/`toolTerminalRepairs` 统计；L2 matcher 重构为 `classifyLayoutRejection`（C1/C2 一律 strip-all 治愈；C3 **有条件**治愈，仅当 thinking 正是把 tool_use 挤离末尾的原因）。探针在 [exp/thinking-terminal-block/](../../exp/thinking-terminal-block/)。

> C3 的主动修复由**并发会话**在 2026-07-27 完成（起因是一台陈旧实例产出 C3 措辞的每轮必败 400）。接手前 `git log` 确认这部分状态。

### 2.2 `tool_search` 成本收益裁决 —— **保留，不退役**

权威文档：[exp/tool-search-cost-benefit/FINDINGS.md](../../exp/tool-search-cost-benefit/FINDINGS.md)。

| 轴 | 实测 |
|---|---|
| 收益 | **16,157 prompt token/轮（62.7%）** |
| 成本 | 实际触发 tool_search 往返 **1/120 轮（0.83%）** |

**这条裁决决定了待办工作必须做**——不存在「等 tool_search 退役、问题自动消失」的退路。同时坐实了承重假设：deferred 工具的 schema 确实不进 prompt。

---

## 3. 待做：重写 [docs/spec/2026-07-26-server-tool-provenance-routing.md](../spec/2026-07-26-server-tool-provenance-routing.md)

### 3.1 病灶（已实测坐实，不必重新取证）

```
① GHC 返回  [thinking, server_tool_use{tool_search}, tool_search_tool_result, thinking, tool_use]  ← 合法
② 我方 filter 无条件剥离中间两块 + 索引压密 → 转发 [thinking, thinking, tool_use]                  ← 我方制造违规
③ 客户端 baked 进本地历史
④ 下轮回传 → C1 400 → destack 修 C1 → C2 400（每轮必败）
```

取证：`req_1785016247905_895` 两条腿逐块对比。同 session 14 轮中含 server-tool 块的仅 1 轮，**而它 100% 制造了相邻 thinking**。

三层 thinking 修复（L1/L2/L3）全是在下游收拾这个 filter 的烂摊子。

### 3.2 已由用户拍板的决策（不要重开）

1. **不如实暴露**：我方注入的 server-tool 块不能原样转发给客户端（客户端从未声明过它）。
2. **降级而非丢弃**：保留其携带的信息。
3. **判据不是模型族**，而是「谁声明的」（用户原话是「仅对 claude models 处理」，但模型族只是代理变量）。
4. **存量坏数据必须有修复机制**（destack 保留，职责正当）。
5. `tool_search` 保留（§2.2 已裁决）。

### 3.3 评审判决：**应重新设计**（3 CRITICAL + 5 HIGH/MED）

评审者：`gpt-souls:reviewer`（异模型对抗）。**下列每条我都亲自复核过**，全部属实。

#### CRITICAL-1：现有渲染函数与目标数据形状不相容

[rewrite-server-tool-blocks.ts:70-94](../../src/lib/anthropic/sanitize/rewrite-server-tool-blocks.ts#L70) 的 `stringifyServerToolResultContent` 是 **web-search 专用**：把所有非数组 object 当错误结果 → `tool_search_tool_search_result`（形如 `{type, tool_references:[...]}`）被渲染成 **`"Web search failed: unknown"` + `isError: true`**。

**这是个现存缺陷**（请求侧 downgrade 被 learned 开启即触发，谎报失败 + 丢光真实工具引用），因 §2.2 裁决为「保留」而**升级为必修**。

修法：定义新的**穷尽式** `renderServerToolTranscript` 契约——`tool_search_tool_search_result` 逐个渲染 `tool_references[].tool_name`；`*_tool_result_error` 渲染真实 `error_code`；web_search/fetch/code_execution 按各自 union 渲染；未知未来类型保留结构化 JSON 而非静默 `unknown`。两侧可共享内容渲染，但 envelope 不同（请求侧产 `tool_result`，响应侧产 `text`）。

#### CRITICAL-2：从历史 `server_tool_use` 重建声明不可行

历史块只携带 `{id, name, input, caller}`，**没有**声明所需的带日期版本 `type`（`tool_search_tool_regex_20251119`）。web_search 同样有多个 dated variant，单凭 `name` 无法回推。现有普通-tool 安全网 [message-tools.ts:117-143](../../src/lib/anthropic/message-tools.ts#L117) 只构造 `{name, input_schema}` custom stub，不满足「必须作为 server tool 声明」。

> 这条**由我独立发现、与评审交叉验证一致**（我看真实上游帧确认，评审查 SDK 类型确认）。

修法：不重建。原样转发分支下客户端自己会重新声明；残留风险（客户端本轮不再声明但历史仍有该块）由既有反应式兜底覆盖——[server-tool-rewrite-mode.ts:18](../../src/lib/anthropic/server-tool-rewrite-mode.ts#L18) 是 **learned-only**（默认 false，撞过一次 400 后对该模型开启 downgrade），代价是一次 400 后自愈。

#### CRITICAL-3：spec 的核心卖点在现有管线下不成立 —— 必须收窄

filter 的 gate 是 [response-rewrite-adapters.ts:110](../../src/lib/codec/anthropic/response-rewrite-adapters.ts#L110) 的 `env.targetEndpoint === ENDPOINT.MESSAGES`（**出站腿**），不是 clientFormat。而 S6 跨格式翻译层**明确 drop** server-tool 块：[anthropic-to-cc.ts:99-101](../../src/lib/openai/translate/anthropic-to-cc.ts#L99)、[anthropic-to-responses.ts:122-125](../../src/lib/openai/translate/anthropic-to-responses.ts#L122)（后者注释标了 `server-tool passthrough is Phase 6 scope`）。

所以「按来源分流自动覆盖 GPT 场景」是**假的**：即使 filter 不 suppress，GPT/CC/Gemini 客户端也收不到。此外 `originalRequest.tools` 的投影本身有损——CC 只留 function name/description（[codec.ts:371-376](../../src/lib/codec/openai-cc/codec.ts#L371)）、Gemini 只留 function declarations、只有 Responses 保留完整原始 tools。

**修法（用户已选）**：收窄到 `clientFormat === "anthropic"`，GPT/Gemini 的 server-tool 语义归 Phase 6 另立 spec。

#### HIGH-4：provenance 判据不足

`server_tool_use.name` 的 union 同时含根工具与内部派生子工具（`web_search` / `code_execution` / `bash_code_execution` / `text_editor_code_execution` / tool search…），子调用经 `caller.tool_id` 指向父 server tool。按「块 name 是否在原始 tools」判定会：① 把客户端已声明能力的**内部子块**误判为代理注入；② 把客户端声明的**同名 custom function**（如 `{name:"web_search", input_schema}`）误判为已声明 server tool。

修法：判据须 ① 要求是 **typed server-tool declaration**（不能只比 name）；② 建立流内 invocation graph（`server_tool_use.id` / `caller.tool_id` / result 的 `tool_use_id`）；③ provenance 从根 invocation 传播到嵌套子调用；④ 无父节点/重复 ID/未知 caller/截断 pair 有确定 fallback（推荐降级 + 保留诊断，不猜来源）。

#### HIGH-5：N→1 流式状态机未定义

现 adapter 是**无 buffer 的逐帧 suppress/emit**（[response-rewrite-adapters.ts:317-334](../../src/lib/codec/anthropic/response-rewrite-adapters.ts#L317)）。接口**支持** buffer/flush（[rewrite-registry.ts:65-75](../../src/lib/pipeline/rewrite-registry.ts#L65)），但 spec 没定义何时 buffer、何时 emit、截断时 flush 什么。driver 只转发 rewrite 最终 emit/flush 的帧（[response-processor.ts:253-287](../../src/lib/pipeline/stream/response-processor.ts#L253)）——状态机漏掉 unpaired pair 则数据静默消失。

**我实测的真实帧形态（重要，降低了实现难度）**：

```
idx=1 server_tool_use   : start → input_json_delta ×9（累积 {"pattern":"^(Agent|Task|SendMessage)$","limit":5}）→ stop
idx=2 tool_search_result: start ← content 整块内嵌，无 delta！ → stop
idx=3 thinking          : start → signature_delta → stop
```

**`*_tool_result` 的 content 在 `content_block_start` 就全有了**，不需要等 delta 累积。故实现 = 缓存 `server_tool_use` 的 input 累积（供渲染 query）→ 在 result 的 start 帧一次性 emit text 块的 start+delta+stop。N→1 索引映射成立，无需跨帧对齐等待。

仍需在 spec 定义：多 pair、嵌套 pair、并发/交错、result-before-use、重复 result、EOF/throw 时 unpaired invocation 的 flush（必须保留信息，如发 invocation-only 降级文本并标 incomplete，不能静默 suppress）；原样分支必须保持**原 upstream index**、不进 densify。

#### HIGH-6：与既有 learned strip/downgrade 的优先级冲突

[message-tools.ts:372-391](../../src/lib/anthropic/message-tools.ts#L372) 会按 learned unsupported type 或 retry hint **删除 typed server tool**；历史 downgrade 又由 model-level learned flag 控制。当前顺序是 tool preprocess 在 sanitize 之前（[payload-rewrites.ts:80-92](../../src/lib/anthropic/payload-rewrites.ts#L80)）。若 prepare 删声明而历史未降级 → 重新形成 orphan。`deferred-tool-retry` 只处理 custom/deferred tool，**不能**修 server-tool 声明缺失。

修法：spec 给出 precedence matrix（识别历史 pairs → 按当前 typed declaration 是否存在/是否 learned-unsupported 决定「保留 pair + declaration」或「请求侧降级 pair」→ 再跑 `processToolBlocks`；`stripServerTools` 不得在留下 server-tool history 的同时删其声明）。

#### MED-7：synthetic 落点是四处，且非流式标记机制未定义

除 `SyntheticOriginKind`（[frame-origin.ts:29](../../src/lib/pipeline/frame-origin.ts#L29)）和 `OperationSyntheticKind`（[model-operation-record.ts:28](../../src/lib/context/model-operation-record.ts#L28)），client-sink 还有两个独立 literal union：SSE [client-sink.ts:196-205](../../src/lib/pipeline/client-sink.ts#L196)、WS [client-sink.ts:590-597](../../src/lib/pipeline/client-sink.ts#L590)。且 `tagFrameSynthetic` 只适用于 frame，非流式走 `transformWhole` **没有** per-block frame tag——spec 须说明非流式降级如何满足「带标记」。每个生成的 text start/delta/stop 都要带同一 kind。

#### HIGH-8：验收标准挡不住关键失败

现 §6 只要求 SDK 接受**首轮**响应——历史声明问题在**第二轮**才暴露。且现有 golden 测试仍锁「server tool 被完全删除」的旧行为（[response-rewrite-golden.http.test.ts:585-597, 803-815](../../tests/anthropic/response-rewrite-golden.http.test.ts#L585)），仓库内**没有** `req_1785016247905_895` 的冻结 fixture。

修法：① 真 SDK **两轮** e2e（第二轮回传完整 `response.content`，覆盖带声明/缺声明两分支）；② mock-upstream HTTP 测试断 client 轨 + upstream 轨 + synthetic marker + 实际 wire；③ 流式输入 JSON 按单字符/多 chunk/空 delta 三种切分证等价；④ 多 pair / nested caller / 错误 result / EOF 前缺 result；⑤ 冻结脱敏事故 fixture 进仓库，断完整块序+内容+索引，不只断「无相邻 thinking」；⑥ **positive control**（临时恢复无条件 strip 或破坏 pair routing，测试必须变红）；⑦ 交付门加 `bun run build:ui`（§4.2 自己说了它是权威门，§6 却漏了）。

### 3.4 评审确认**没有**问题的项（不必再查）

- `ctx.originalRequest.tools` 的读取时机可行：Anthropic parse 在 [codec.ts:387-423](../../src/lib/codec/anthropic/codec.ts#L387) 创建 ctx 后即设 immutable original request；response rewrite state 在 [response-processor.ts:65-72](../../src/lib/pipeline/stream/response-processor.ts#L65) 才创建，`transformWhole` 拿同一 env。**无时序障碍**。
- 逐帧接口本身支持所需缓冲（`FrameAction.buffer` / rewrite-owned state / `flush` 均已存在）。

---

## 4. 关键事实速查

| 事实 | 出处 |
|---|---|
| `tool_search` 是**我方注入**，客户端从未声明 | [message-tools.ts:177-186](../../src/lib/anthropic/message-tools.ts#L177)；实测 client tools 24 → upstream 29 |
| 注入条件 = config `anthropic.tool_search`（默认 true）× 模型能力 × **请求带 tools** | 同上；实测同 session 14/15 轮注入，例外正是 `clientTools=0` |
| 注入目的 = 开启 `defer_loading` 省 prompt token（**16,157 tok/轮**） | [FINDINGS.md](../../exp/tool-search-cost-benefit/FINDINGS.md) |
| 事故三条请求全是 `claude-opus-5`，`translated:false`，直连 `/v1/messages` | history `model` 字段 |
| 上游报的 messages 索引**不可信**（同一约束下 −1 / +1 / 越界都出现过） | thinking spec 推论 3 |

---

## 5. 踩坑清单（血泪，务必读）

1. **config 键是 `anthropic.tool_search`，不是 `tool_search_enabled`**。写错时 schema **静默 strip**、服务器照常启动、health 照常绿 → A/B 静默退化成 A/A。**任何 config-driven 实验都要在结果里断言配置真的生效了**（如 B 侧必须 `deferred=0`）。
2. **4141 是用户的主服务器，绝不 kill**。实验一律用其他端口起隔离实例（`XDG_DATA_HOME` 隔离），用后按 PID 精确 kill，**绝不 `pkill`/`killall`**。
3. **`exp/` 在 .gitignore 里**，提交探针需 `git add -f`（项目既有惯例，`git log -- exp/` 可见）。
4. **验上游对某个排列的反应必须配 `assistant_block_layout_strategy: passthrough`（旧名 `thinking_destack_strategy`，仍可用但会告警）**，否则我方 L1 会改写掉你精心构造的排列。
5. **最小构造要保留被测对象的结构性处境**（是第几个同类消息），否则阴性结果没有裁决力——C2 的坑就是这么踩的。
6. **重放 upstream body 会撞 "Tool names must be unique"**：我方注入的 5 个 tool 要先剔除（重放伪影，非缺陷）。
7. **`bun run test:backend` 会先跑 `build:history-search`（Rust）**，本机 rustup 无默认工具链时整条失败、一个测试都不跑。绕过：直接 `bun scripts/parallel-test.ts unit it http`。
8. **共享 worktree 有并发会话**：一律显式 pathspec 提交；改 `docs/memory/MEMORY.md` 这类公共文件用 `git apply --cached` 只提自己那个 hunk。

---

## 6. 未闭合问题（诚实标注，别当已解决）

- **C2 为何豁免首个 assistant 消息**：原因未知，只有现象。不猜、不写进结论。
- **L2 strip-all 可能留下 `content: []` 的 assistant 消息**：`handle` 不走 resanitize，`stripAllThinking` 只 filter 不丢空消息。已记 [docs/todo/deferred-backlog.md](../todo/deferred-backlog.md)，**code-read 定性、未实测复现**。
- **嵌套 server tool（`code_execution → bash_code_execution`）的真实帧序**：评审据 SDK 类型推断存在，本项目真实模型上**未实测**其出现频率与帧序。设计 provenance 传播前建议先探针确认。

---

## 7. Kick-off 提示词（复制到新会话）

```
在 /home/xp/src/copilot-api-js 重写一份被对抗评审否决的 spec。

先读这三份，它们是自足的上下文：
1. docs/plan/2026-07-27-handover-server-tool-provenance.md  ← 交接文档，先读它
2. docs/spec/2026-07-26-server-tool-provenance-routing.md   ← 待重写的 spec（当前版本已被判「应重新设计」）
3. docs/spec/2026-07-26-thinking-terminal-block-layout.md   ← 前置事故与三条上游约束（已 landed，只读参考）

任务：按交接文档 §3.3 的 3 个 CRITICAL + 5 个 HIGH/MED 重写 spec。用户已拍板的决策见 §3.2，不要重开。
重写的核心调整：
  - 收窄到 clientFormat === "anthropic"，GPT/Gemini 的 server-tool 语义归 Phase 6 另立 spec（CRITICAL-3）
  - 定义穷尽式 renderServerToolTranscript 契约，替代 web-search 专用的渲染函数（CRITICAL-1，且它是现存缺陷、必修）
  - 放弃「从历史重建 server tool 声明」（CRITICAL-2，信息上不可能），改用既有 learned downgrade 兜底
  - 补 provenance 的 typed-declaration 判据 + caller.tool_id 嵌套传播（HIGH-4）
  - 补 N→1 流式状态机的完整逐事件算法（HIGH-5，注意交接文档里我实测的真实帧形态大幅降低了难度）
  - 补与 learned strip/downgrade 的优先级矩阵（HIGH-6）
  - synthetic 标记四个落点 + 非流式标记机制（MED-7）
  - 验收标准补两轮 e2e、冻结 fixture、positive control、build:ui（HIGH-8）

工作纪律（项目 CLAUDE.md 的硬要求，务必遵守）：
  - 交接文档 §5 的踩坑清单先读完再动手，尤其 config 键名与 4141 主服务器
  - spec 定稿前必须派 subagent 对抗评审（异模型，gpt-souls:reviewer），并在 prompt 里显式写裁判轴：
    长远正确+完整优先于最小改动，不得用 ROI/YAGNI 否决正确方案
  - reviewer 的绝对断言（「不可达」「无消费者」「已通过」）必须亲自对照 file:line 复核后再采纳
  - 共享 worktree 有并发会话，提交一律显式 pathspec
  - 别信自己没验证过的推断——本次事故的每一条结论都是实测出来的，延续这个标准

spec 定稿并通过评审后停下来，等用户决定是否起实施。不要直接开始改代码。
```
