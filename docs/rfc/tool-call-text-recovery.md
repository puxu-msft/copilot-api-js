# RFC: 上游 tool-call 文本降级的透明恢复（Tool-Call Text Recovery）

**Status:** v3 draft（2 轮 4+2 路对抗 subagent 审查 + 主线逐条对码/对字节亲验已 incorporate；§11 open questions 待用户裁决）
**Author:** Claude，grounded in 读码 + `localhost:4141` live history 字节级实测（entry `req_1781591216428_210`，2026-06-16）。
**Driver:** 用户授权——针对 GitHub Copilot 上游偶发把工具调用降级成纯文本的现象，在代理层增加透明恢复机制。

> **修订史：**
> - **v2（第 1 轮 4 reviewer）：** 引入 round-trip 校验防腰斩、按 stop_reason 分两档检测、修正 name 还原走 serverToolFilter、抽 `findDowngradeMarkPos`、加可观测。
> - **v3（第 2 轮 2 reviewer + 字节级亲验）推翻 v2 三处「以 n=1 微形态当普适不变量」的自废错误：**
>   1. **【CRITICAL 自废】v2 的「实测 entry210 即零间隔 `call<invoke`」是错的。** 字节级亲验：真实是 `）。\n\ncall\n<invoke ...>`，**标签之间全是换行**。根源是 v1 提取时用 `tr -d '\n'` 抹掉了换行、误读折叠产物。后果：v2 的「B2 零间隔」+「round-trip canonical 零空白字节重建」会**双重拒掉唯一已知真实样本**，feature 永不触发——比误报严重。v3：B2 改「残留与 `<invoke>` 间仅纯空白」；round-trip 改 **whitespace-tolerant 位置不变量**（非字节重建）。
>   2. **【CRITICAL 时序】门控的 stop_reason（档 A/B）与 P3（无 tool_use block）只在 `message_delta` 才确定，而 v2 在更早的 text block `content_block_stop` 就发合成帧——已发帧无法撤回，v2 §5.3 的「回退」是空话。** v3：发帧拆为 **CANDIDATE（content_block_stop 持帧不发）+ COMMIT（message_delta 发帧或丢弃回退）**，未提交前不发任何合成帧，回退才真正可兑现。
>   3. **【论证修正】v2 §5.3 合成 index 的「clientIndexMap 重映射一致」论证错了**（size==0 时 serverToolFilter 不重映射、原样透传）。主线亲验 `getClientIndex`：对「从未见过的合成上游 index」size==0 透传原值、size>0 分配下一个连续值，**两条路径结论都连续正确**，故无需新增 filter API（reviewer 建议的 `allocateClientIndex` 属过度设计）；仅修正论证 + 补 size>0 混合测试。

---

## 0. 问题实证

### 0.1 现象（entry `req_1781591216428_210`，字节级实测）

| 维度 | 值 |
|---|---|
| 模型 / 路径 / 传输 | claude-opus-4.8 / `/v1/messages` / http stream |
| 请求 tools | 非空，107 个（含 Write/Bash/Edit/Read…，wire 工具集） |
| 上游 content blocks | `thinking`(index 0) + `text`(index 1)，**无 `tool_use` block** |
| `message_delta.stop_reason` | `end_turn`（模型以为正常结束 → 属「变体 B / 档 B」） |
| 本地代码 | 全库 grep `antml`/`function_calls`/`<invoke` **零命中** → 纯透传 |

**text block 精确字节形态（perl 转义实测，`<LF>`=换行）：**

```
…纯拓扑数据模型）。<LF><LF>call<LF><invoke name="Write"><LF><parameter name="file_path">/home/…/conversation.ts</parameter><LF><parameter name="content">/** …整个 TS 文件，含 Array<string> 等尖括号… */<LF>}<LF></parameter><LF></invoke><LF>
```

关键字节事实（v3 全部门控/解析必须容忍这些，否则自废）：
- 残留包裹是 `call`，**与 `<invoke>` 间隔一个 `\n`**（非零间隔）；`call` 前是 `\n\n`。无 `<function_calls>` 开标签、无 `</function_calls>` 闭标签。
- **每对标签之间都有 `\n`**：`<invoke ...>\n<parameter`、`</parameter>\n<parameter`、`</parameter>\n</invoke>`。
- `</invoke>` 之后仅一个 `\n` 到 EOF——**invoke 终结于 block 尾**（无后续散文）。
- `<parameter name="content">` 值是整个 TS 文件，**含 `Array<string>` 等尖括号**（round-trip 校验的攻击面）。
- 1 个 `<invoke>` / 2 个 `<parameter>`，闭合 count 精确相等。

### 0.2 根因（非本项目 bug）

GitHub Copilot 的 Anthropic 上游偶发把工具调用渲染成命名空间剥离的纯文本塞进 text block（`antml:function_calls`→`call`、`antml:invoke`→`<invoke>`、`antml:parameter`→`<parameter>`），保留模型原始输出的换行，无标准 `tool_use` block。可能与长 thinking／流式时序相关（本 entry thinking 114s）。copilot-api 如实透传。

**两类 stop_reason 变体：**
- **变体 A（强信号）：** `stop_reason=tool_use` 但 content 零 tool_use block（memory note `req_1780679182536_30` 等观测）。上游**自相矛盾**——声称调工具却没发 tool_use block。合法响应不可能产生此组合。
- **变体 B（弱信号）：** `stop_reason=end_turn`（本 entry210）。模型以为正常结束，`<invoke>` 文本是唯一信号，需残留 + 终结性对抗散文误报。

下游 Claude Code 期望 tool_use，收到 `<invoke>` 文本 → 解析失败或当文本显示 → 工具调用丢失，对话卡死。

---

## 1. 设计哲学与不变量

1. **history 保留上游真相。** raw `sseEvents` + accumulator + history entry 永远记录上游降级原貌（含 message_delta 的 end_turn）。恢复**仅作用于 `forwardedSseEvents`（client 方向）**。已亲验：`accumulateAnthropicStreamEvent` 在 `processAnthropicStream` 内先于 `yield`（stream.ts:113→118），`sseEvents.push` 记录上游原始字节先于任何转发改写（handler.ts:711）。
2. **默认 off、彻底 no-op。** flag 默认 `false`，关闭时转发链零开销。
3. **失败回退零丢失。** 门控不过 / 解析失败 / round-trip 不符 / 流中断 → 原样透传缓冲帧，绝不改写、绝不丢字节。
4. **保守优先 + 绝不部分成功。** 「解析成功但内容腰斩/错位」比「干净失败」危险得多（客户端拿残缺工具调用执行真实副作用，用户无感）。§4.3 的 round-trip 校验专门消灭这类。漏报（退回现状）永远优于误报。
5. **合成帧必须带 `event:` 行。** 合成的 `content_block_*` 帧经 [src/lib/anthropic/sse-frame.ts](../../src/lib/anthropic/sse-frame.ts) 的 `anthropicSseFrame`（`event:` = 帧 `type`）构造——Anthropic SDK 按 SSE event 名分发，纯 `data:` 帧解码成 `event=null` 被**静默丢弃**（连 SSE `"message"` 默认都不应用）。早期 `sse()` 漏发 event 行，SDK 客户端（Claude Code）会整帧丢失合成的 tool_use；现收敛到单一 synth 入口（与 recover-refusal 共享）+ golden `assertEventLineInvariant` 守卫。详见 memory `reference-anthropic-sdk-drops-eventless-sse-frames`。

### 1.1 不做（YAGNI）
- **不重试上游**（唯一硬理由：降级概率性、无收敛上界，重试不保证不再降级）。
- **不处理非 Anthropic 路径**、**不注入 system prompt**、**不靠客户端重试**（降级是 200+end_turn，客户端视角成功、不会重试）。

---

## 2. 配置与注册链（boolean，对照 `sanitizeToolNames` 模板，7 处）

| 项 | 值 |
|---|---|
| config key | `anthropic.recover_tool_call_text`（boolean，默认 `false`） |
| state 字段 | `state.recoverToolCallText: boolean` |
| 热重载 | 是（顶层标量，`setAnthropicBehavior`） |

1. **`src/lib/config/schema.ts`** `AnthropicConfigSchema` 加 `recover_tool_call_text: nullableBoolean()`（**第一必改点**——schema `.strict()`@line287 亲验，漏此项用户写该 key 会 config 解析崩溃；镜像 `decode_all_tool_input_fields`@line271）。
2. `src/lib/config/config.ts` `applyConfigToState`（~523）：`if (a.recover_tool_call_text !== undefined) setAnthropicBehavior({ recoverToolCallText: a.recover_tool_call_text })`。
3. `state.ts` `State` interface 字段（~141）。
4. `state.ts` `setAnthropicBehavior` patch union（~754）加 `| "recoverToolCallText"`。
5. `state.ts` `CONFIG_MANAGED_DEFAULTS`（~944）`recoverToolCallText: false`。
6. `state.ts` `resetConfigManagedState`（~999）。
7. `state.ts` `mutableState` 初始化（~1060）。
- boolean 浅拷贝即可，**无需改 cloneState/cloneStatePatch**（那是引用类型如 decodeToolInputFields 才需要，亲验）。
- 外加 `config.yaml` 默认 + `docs/DESIGN.md` 配置表行 + `config-hot-reload.it.test.ts` `FIELDS` 矩阵行（否则 `enumerateLeafKeys`@line664 完整性守卫 fail）。

---

## 3. 检测门控（按 stop_reason 分两档）

> 依据：`stop_reason=tool_use ∧ 零 tool_use block` 是协议级矛盾（合法响应不可能），是最强信号；end_turn 变体缺此铁证，需文本残留 + 终结性。

对一个**已组装完整的 text block 文本** `T` + 请求上下文 + **响应级终态**（stop_reason、全响应 block 清单）：

### 公共前置
- **P1** flag on。
- **P2** `effectiveRequest.tools` 非空（**wire tools**——`sanitize_tool_names` 开启时模型写 wire name，§7.2 亲验）。
- **P3** 本响应 content **无任何标准 `tool_use` block**。**时序：流式下此项与 stop_reason 一样，直到 `message_delta`（COMMIT 点，§5.3）才最终确认**——若本轮已有真实 tool_use block 则非全降级，不处理（§11.4「部分降级」另议）。
- **P4** `T` 含 `<invoke name="X">`，X 精确命中 P2 工具集某 name（逐字）。
- **P5** invoke 区间内 `count("<parameter name=")==count("</parameter>")` 且 `count("<invoke")==count("</invoke>")`（精确相等）。
- **P6（硬门控）** §4 解析 + **whitespace-tolerant 位置不变量校验通过**（§4.3）——消灭部分成功。

### 档 A（强）
- **A1** `stop_reason=="tool_use"`。触发：P1–P6 ∧ A1。**不要求残留包裹、不要求终结性**（协议矛盾已足够保守）。覆盖 memory note 的 tool_use 变体。

### 档 B（弱）
- **B1** `stop_reason=="end_turn"`。
- **B2（残留包裹，纯空白间隔）** 至少一个 `<invoke>` 紧前的残留 token（`call` / `function_calls` / `<function_calls>`）与 `<invoke>` 之间**仅有空白**（`\s*`，含换行；实测真实是 `call\n<invoke`），且该残留 token 前也是空白/标点边界。**判别英文散文 `call the function … <invoke>`：其 `call` 与 `<invoke>` 间隔的是实义词而非纯空白 → 不命中。**
- **B3（终结性）** 最后一个 `</invoke>` 之后**仅有空白**（实测 entry210 `</invoke>` 后仅 `\n`）。用途：劈开「真降级（模型发出调用即停）」vs「元讨论（讲解后继续写散文）」——这是 tier B wire 层不可消除歧义（同字节两种意图）的最佳廉价启发式。**天花板：非密不透风**——「恰以干净示例结尾的讲解」仍会过 B3（罕见；feature opt-in；tier A 协议矛盾兜底）。按 §11.1 哲学**不**推测容忍 `</function_calls>` 等残留闭合（entry210 无，遇到变体再加）。用户 2026-06-16 采纳「接受残余误报 + 简化 B3 为仅空白」。
- 触发：P1–P6 ∧ B1 ∧ B2 ∧ B3。

任一不满足 → 不改写，原样透传，`consola.debug("[recover] gate miss …")`。

> **诚实标注：** P2 + stop_reason 在 agent 流量近恒真；档 B 有效判别压在 B2（纯空白残留）+ B3（终结）+ P6（位置不变量）。档 B 残余误报（模型粘贴完整、纯空白、终结的降级样本）由 B3 阈值（§11.2）+ 用户裁决兜底；档 A 无此问题。

---

## 4. 解析器核心 `recover-tool-call-text-core.ts`（零依赖）

### 4.1 契约（流式/非流式共享）

```typescript
/** 找降级 tool-call 区起点（残留 token 或 <invoke> 的最靠前起点），无则 -1。tier B 要求纯空白残留。 */
export function findDowngradeMarkPos(text: string, toolNames: ReadonlySet<string>, tier: "A" | "B"): number

/** 解析 markPos 起的尾部，位置不变量校验后按 schema 定型，产出 block 序列。 */
export function recoverDowngradeTail(tail: string, toolSchemas: Map<string, ToolParamTypes>): RecoverResult

type ToolParamTypes = Record<string, "string" | "number" | "integer" | "boolean" | "array" | "object">
type RecoveredBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; name: string; input: Record<string, unknown> }   // id 由调用方注入（§4.4）
interface RecoverResult { recovered: boolean; blocks: Array<RecoveredBlock> }
```

> core 永远只吃 `text.slice(markPos)`，不感知 markPos 前散文。流式：markPos 前散文已实时转发；非流式：helper 先 `findDowngradeMarkPos` 切刀。流式/非流式共用同一 core 调用形态。

### 4.2 解析算法
1. 跳过开头残留 token（`call`/`function_calls`/`<function_calls>` + 周边空白）。
2. 显式扫描（非贪婪正则——值含尖括号/斜杠）定位每个 `<invoke name="...">…</invoke>`：找开标签 → 找配对 `</invoke>`（计数嵌套防御）。
3. 区间内扫 `<parameter name="K">V</parameter>`，V 为标签间**原始文本，不 trim**（§11.3 定「不 trim」保真——与位置不变量校验一致）。
4. **位置不变量校验（§4.3）**——失败即 `{recovered:false}`。
5. 通过后按 schema 定型（§4.4）。
6. 产出：每 invoke 一个 tool_use（保序）；末尾残留散文（档 A 可能有）作 text block。

### 4.3 位置不变量校验（防腰斩，whitespace-tolerant，取代 v2 canonical 字节重建）

**问题（实证）：** `<parameter name="content">` 值是任意源码，可能含 `</parameter>`/`<parameter>`/`<invoke>` 字面量。朴素扫描在值内字面量处提前闭合 → content 腰斩 → 产出结构合法但内容残缺的 tool_use。

**为何不用 canonical 字节重建（v2 错误）：** 真实降级文本标签间全是 `\n`（§0.1），而 canonical 重建是零空白形态 → 字节比对对**唯一真实样本就失败** → feature 自废。canonical 形态依赖 n=1 微形态假设，不可靠。

**v3 解法——区间内结构/位置不变量（对标签间空白形态免疫）：**
1. invoke 区间内 `count("<parameter name=") == count("</parameter>")`（已由 P5 保证）。
2. **非贪婪配对**：每个 `<parameter name="K">` 配其后**第一个** `</parameter>`。
3. **覆盖性断言**：每个 `</parameter>` 之后第一个非空白 token 必为 `<parameter name=` 或 `</invoke>`；区间内不存在任何「落在已配对值内部」的游离 `</parameter>`（即非贪婪配对覆盖区间内全部 `</parameter>`，无残留）。
4. `</invoke>` 是区间末标签。

实测：entry210（标签间 `\n`）**通过**；content 含 `</parameter>` 字面量的腰斩样本——值内 `</parameter>` 被当 content 闭合后，剩余 ` …</parameter></invoke>` 违反断言 3（出现无配对 open 的游离闭合或覆盖不全）→ **拒绝**。这对空白形态免疫，仍挡住所有腰斩。

> **权衡（reviewer 确认）：** content 含**裸** `</parameter>` 字面量的合法 Write 会被漏报（无法与腰斩区分，信息论不可判）——**漏报这类罕见 Write 是对的**，绝不误报腰斩（§1.4 红线）。

### 4.4 参数定型与合成 id
**定型（按 input_schema 精确转换）：** 查 `toolSchemas.get(name)?.[K]`：`string`/缺失→字符串；`number`/`integer`→`Number(V)`（NaN 回退）；`boolean`→`true`/`false`（其它回退）；`array`/`object`→`JSON.parse(V)`（抛错回退字符串）。schema 整缺→全字符串。

**合成 id（实测真实 = `toolu_`+24 base62）：** 用 `toolu_` + 24 位**确定性** base62（哈希 `name+响应级序号+tail`）——满足 CLAUDE.md 可重现 + 格式同构。序号用**响应级单调计数器**（非 block 内序号，防多 block 碰撞）。
> **实现前必做探针（§11.5）：** empirical-probe 法 splice 带合成 id 的 tool_use POST，确认上游不因 id 格式 echo-back 400。

---

## 5. 流式恢复器 `recover-tool-call-text.ts`（推测缓冲 + CANDIDATE/COMMIT 两阶段）

### 5.1 接口与实例语义
```typescript
export interface ToolCallTextRecoverer {
  processEvent: (parsed: StreamEvent | undefined, raw: ServerSentEventMessage) => Array<ServerSentEventMessage>
  flush: () => Array<ServerSentEventMessage>
}
```
**per-stream 单实例**（同 toolInputDecoder，handler.ts:549）。状态：
- **message 级**：`maxUpstreamIndexSeen`（合成 index 基准，§5.4）；`candidate`（持帧期数据，见下）。
- **block 级**（每个 `content_block_start{text}` 重置）：`PASSTHROUGH | BUFFERING`、`seen` 累积文本、`bufferedFrames: Array<ServerSentEventMessage>`（**原始帧**，供回退/flush 无损回放）、markPos。

`maxUpstreamIndexSeen` 在 **processEvent 入口、任何分支/early-return 之前无条件更新**：`if (parsed?.type` 是 `content_block_*) maxUpstreamIndexSeen = max(maxUpstreamIndexSeen, parsed.index)`——覆盖 thinking/tool_use/server tool 等所有透传块。

### 5.2 PASSTHROUGH / BUFFERING（block 级，每个 text block 独立；非 text block 透传）
- **PASSTHROUGH（初始）**：text_delta 累积进 `seen` 并实时转发，**保留 lookahead 尾巴**（≥ 最长残留 token 长 + 余量，约 32 字符）不转发，防标记跨 delta 切分泄漏。**标记检测对 `seen` 全量尾部**用 `findDowngradeMarkPos`。检出 markPos → 转 BUFFERING：markPos 前文本确保已转发（含暂扣的 lookahead 中确认在 markPos 前的部分立即补发），markPos 起停止转发（残留 token 也不转发，避免客户端散文尾留 `call` 噪声）。
- **BUFFERING**：markPos 后所有 text_delta 的**原始帧**入 `bufferedFrames`、累积进 `seen`，不转发，直到 `content_block_stop`。

### 5.3 CANDIDATE（content_block_stop 持帧）/ COMMIT（message_delta 发帧）—— 修复时序矛盾

**为何两阶段（实证）：** 门控的 stop_reason（A1/B1）+ P3（无 tool_use block）只在 `message_delta` 才确定（stream-accumulator.ts:157/373 亲验），而合成帧一旦 `writeSSE` 不可撤回。故**未到 message_delta 不发任何合成帧**。

- **text block 的 `content_block_stop`**：
  - 若 BUFFERING 且**结构性预检通过**（P4 invoke 命中、P5 闭合 count、§4 round-trip——这些只依赖 block 文本，此刻可算）→ 进 **CANDIDATE**：**持住**该 `content_block_stop` 帧 + 已累积的 `bufferedFrames` + 预备好的合成 block 序列（`recoverDowngradeTail` 结果），**一律不发**。记 candidate 的 block index N。
  - 否则 → 非降级：发该 `content_block_stop`（及 BUFFERING 中误扣的 `bufferedFrames` 原样补发），无 candidate。
- **CANDIDATE 持帧期收到下一上游事件：**
  - **`content_block_start`（又来块）**：candidate 作废（text 非终结 / P3 可能有后续 tool_use）→ 发持住的 `content_block_stop` + `bufferedFrames`（**原始，未改写**），清 candidate，透传新块。
  - **`message_delta`（COMMIT 点）**：stop_reason 与 P3 已定。跑档 A/B 终判（A1/B1 + 档 B 的 B2/B3 + P3）：
    - **通过** → 发：持住的 text `content_block_stop`（index N 不变）→ 每个合成 tool_use 的 `content_block_start{tool_use, name:<wire>, index=maxUpstreamIndexSeen+1+k}` + `input_json_delta`(整 JSON 一次) + `content_block_stop` → 改写后的 `message_delta`（end_turn→tool_use；档 A 已是 tool_use 不改）。这些帧经 `forwardToClient → serverToolFilter`（name 还原 + index 分配，§5.5/§7.2），合成 tool_use **绕过/无害透传 decoder**（§7.1）。
    - **不通过** → 发：持住的 `content_block_stop` + `bufferedFrames`（原始）+ 原始 `message_delta`。
- **不变量**：candidate 的 text `content_block_stop`（index N）在 COMMIT 与回退两条出口**都必发、index 不变**——保证已转发的 markPos 前散文有合法闭合。

### 5.4 合成 index（论证修正）
合成块用 `maxUpstreamIndexSeen + 1 + k` 作**上游 index**，经 serverToolFilter。亲验 `getClientIndex`（server-tool-filter.ts:107-114/145-153）：对「从未见过的上游 index」——size==0 原样透传（已 dense，因无过滤）、size>0 分配 `nextClientIndex++`（下一个连续 client index，因 size==0 透传分支也调 getClientIndex 推进计数，nextClientIndex 始终同步）。**两路径都产连续 client index**，同一合成 index 的 start/delta/stop 命中同一 clientIndexMap 缓存 → 三帧一致。无需新增 filter API。`maxUpstreamIndexSeen` 入口更新保证不与任何上游块碰撞。

### 5.5 name 还原 / decoder / flush / heartbeat
- **name 还原**在 serverToolFilter（server-tool-filter.ts:121-129，亲验），合成 tool_use 用 wire name 经 forwardToClient → serverToolFilter 自动还原 wire→client。**恢复器不自还原**。
- **decoder**：合成 tool_use 经 toolInputDecoder 时靠 reference-equality no-op（decode-tool-input.ts:97，亲验；§4.4 已定型，decode 找不到可改字段 → 回放原帧）无害。
- **flush**（流中断）：
  - BUFFERING 中（未 CANDIDATE）abort → 回放 `bufferedFrames`。
  - **CANDIDATE 持帧期 abort → 回放持住的 text `content_block_stop` + `bufferedFrames`（原始），绝不发合成帧**（COMMIT 未发生、stop_reason 未确认）。
- **heartbeat**：持帧期 heartbeat（handler.ts:570）仍按 `lastRealMs` 注入 client ping——合法无害（持帧窗口 = content_block_stop 到 message_delta，通常毫秒级，因 invoke 终结于 block 尾、message_delta 紧随）。实现不暂停 heartbeat。

---

## 6. 非流式 helper
`recoverToolCallTextInResponse(response, { toolSchemas, enabled })`：对每个 `text` block，`findDowngradeMarkPos` 切 markPos，前缀留 text、尾部喂 `recoverDowngradeTail`，命中替换为 `[text前缀?, ...tool_use, text尾部?]`，按档修正 `response.stop_reason`。整块在手，无缓冲/时序问题（P3/stop_reason 直接可读 `response`）。镜像 `decodeToolInputBlocksInResponse`。

---

## 7. 接入点与 ordering
### 7.1 流式转发链（`processOneStreamEvent`）
顺序：`thinkingSignatureCompat` → **`toolCallTextRecoverer.processEvent`** →（其输出每帧）→ `toolInputDecoder.processEvent` → `forwardToClient`(内含 serverToolFilter)。
- 透传帧（散文/非 text/CANDIDATE 持帧期透传的后续块）正常过 decoder。
- 合成 tool_use 帧：§4.4 已定型，过 decoder 靠 reference-equality no-op 无害透传；**必经 forwardToClient → serverToolFilter** 拿 name 还原 + index 分配。

### 7.2 tool name（亲验纠正）
P4/G3 匹配 **wire tools**；合成 tool_use `name`=wire name，经 serverToolFilter `restoreToolUseName` 自动还原 wire→client。**恢复器不持 toolNameMapper、不自还原**（v1/v2 §10.4 删除）。

### 7.3 非流式（handler.ts ~955-964）重排
`filterServerTools → recoverToolCallText → restoreToolNames → decodeToolInput → setForwardedResponse`。recoverToolCallText 在 restoreToolNames **前**（合成 wire name 让 restore 一并还原）；decode 仍在 restore 后，client-name 依赖不破坏（亲验 958/961）。

---

## 8. 可观测性（改响应语义必须可审计）
- **改写发生时** `reqCtx.recordFeature("tool-call-recovered", { tier, invokeCount, toolNames, stopReasonRewritten })`——history entry sticky tag，UI 可筛出所有被恢复请求审计（对照 handler.ts:351/404）。
- **console** 固定宽前缀 `[RECOVER] HH:MM:SS model (tier A/B, N tools)`（与 `[RETRY-n]` 同级、非 debug——代理主动改了响应，运营者应见；对齐 DESIGN.md「诚实展示 retry」）。
- **forwardedSseEvents vs sseEvents** 改写时天然分叉，UI 可对比上游原貌 vs 转发版（handler.ts:535）。
- gate miss 仍 debug；**gate hit+改写**必须持久可审计。

---

## 9. 测试矩阵
### 9.1 core `recover-tool-call-text-core.unit.test.ts`
- `findDowngradeMarkPos`：档 A（无残留命中）、档 B（`call\n<invoke` 纯空白命中、`call the func … <invoke>` 实义词间隔**不**命中、英文 `call` 散文不命中）。
- **entry210 真实字节 fixture**（标签间含 `\n`）→ 1 tool_use{Write,{file_path,content}}，**位置不变量校验通过**（防回归 v2 canonical 自废）。
- **round-trip 防腰斩**：content 含 `</parameter>` 字面量 → `{recovered:false}` 干净失败；content 含 `Array<string>` 尖括号（entry210 真实）→ recover；嵌套 `<invoke>` 字面量、截断 JSON 巧合合法 → 拒绝。
- schema 定型：array→JSON.parse、number→Number、非法→回退、缺失→全字符串。
- 合成 id：`toolu_`+24base62 格式、确定性、响应级序号不碰撞。
- 误报：本 RFC 自身讲解 `<invoke>` 的散文 → 不改写。

### 9.2 流式 `recover-tool-call-text.it.test.ts`
- 推测缓冲：散文实时转发、markPos 后停转、lookahead 跨 delta 不泄漏、`call` 残留不入客户端散文。
- **CANDIDATE/COMMIT**：content_block_stop 持帧不发 → message_delta COMMIT 发合成帧 + 改 stop_reason；持帧期 abort → 回放原始 content_block_stop + bufferedFrames、**不发合成帧**。
- **§5.3 防御**：CANDIDATE 后又来 content_block_start → 发持住 stop + bufferedFrames 原样、清 candidate、透传新块。
- 误报缓冲后 COMMIT gate miss → 原样补发。
- 合成帧经 serverToolFilter：name wire→client 还原（配 sanitize_tool_names）；**size>0（有 server tool 被 filter）+ 恢复并存 → 合成 index 连续**（补 v2 缺失测试）。
- 合成 AskUserQuestion tool_use 经 decoder no-op（回归）。
- 非 text block 透传 + `maxUpstreamIndexSeen` 入口更新正确。

### 9.3 非流式 `recover-tool-call-text.unit.test.ts`
整 response 改写 + stop_reason 修正 + 误报不改 + round-trip 拒绝。

### 9.4 config 热重载：`FIELDS` 加 `recover_tool_call_text`。
### 9.5 不变量回归：改写时 raw `sseEvents`（含 message_delta=end_turn）保留；`forwardedSseEvents` message_delta=tool_use；`recordFeature` 出现。

---

## 10. 失败回退矩阵
| 情况 | 行为 |
|---|---|
| flag off | 不构造，零开销 |
| gate miss（P/A/B 任一不满足，COMMIT 终判） | 发持住 content_block_stop + bufferedFrames 原样 + 原始 message_delta |
| round-trip 不符 / 解析失败（CANDIDATE 预检） | 不进 candidate，原样透传 |
| BUFFERING 中 abort | flush 回放 bufferedFrames |
| **CANDIDATE 持帧期 abort** | flush 回放持住 content_block_stop + bufferedFrames，**不发合成帧** |
| CANDIDATE 后又来 content_block_start | 发持住 stop + bufferedFrames 原样，清 candidate |
| schema 缺失/定型失败 | 全字符串/该字段回退 |

---

## 11. Open Questions（已裁决，2026-06-16）
1. **B2 残留 token 枚举**：**已定**——只支持 `{call, function_calls, <function_calls>}` + 纯空白间隔（已观测变体）；遇新变体再加。漏报安全。
2. **B3 终结性判据**：**已定**——「最后 `</invoke>` 后仅空白」（不推测容忍残留闭合包裹）。接受残余误报（「以干净示例结尾的讲解」，罕见 + opt-in + tier A 兜底）。详见 §3 B3 + 上文。
3. **§4.4 trim**：**已定**「不 trim」（保真 + 与位置不变量一致）。
4. **「部分降级」变体**（部分真实 tool_use + 部分文本降级）：P3 当前只处理「全降级」；支持部分降级是更大改动，本轮不做，登记待未来。
5. **合成 id 格式**：**已实证关闭**（2026-06-16 POC）——真实 echo-back 探针确认上游不深校验 id 格式，`toolu_`+24base62 与 `toolu_recovered_0` 均 200 接受。保留 `toolu_`+24base62（同构 + 防客户端校验，零成本双保险）。

---

## 12. Commit 切分计划（invariants）
1. **core（findDowngradeMarkPos + recoverDowngradeTail + 位置不变量 + schema 定型）+ unit 测试**。结束态：纯函数独立可测，无消费者。
2. **config 全 7 注册点（schema.ts 起）+ state + 热重载测试**。结束态：flag 可配、no-op。
3. **非流式 helper + 接线（§7.3）+ 测试**。结束态：非流式生效，流式仍透传。
4. **流式恢复器（CANDIDATE/COMMIT）+ 接线（§7.1）+ 可观测（§8）+ 测试**。结束态：双路径生效。
5. **DESIGN.md 配置表 + 文档**。结束态：文档同步。

每步 `bun run typecheck` + 相关 `bun run test:*` 绿。
