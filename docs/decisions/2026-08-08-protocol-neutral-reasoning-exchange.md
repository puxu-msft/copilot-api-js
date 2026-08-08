# ADR：以 protocol-neutral semantic bridge 承载 reasoning 与跨模型 fallback

- **状态**：Accepted
- **日期**：2026-08-08
- **决策人**：用户（2026-08-08 会话逐项裁决）
- **关联**：[2026-08-08 semantic bridge RFC](../rfc/2026-08-08-anthropic-responses-semantic-bridge.md)、[2026-08-06 thinking translation audit](../tmp/2026-08-06-thinking-translation-audit.md)
- **收窄**：[2026-07-14 lossless-per-pair bridge ADR](2026-07-14-lossless-per-pair-bridge.md)

## 背景

2026-07-14 ADR 正确裁决：non-CC↔non-CC 翻译应使用 per-pair direct bridge，不应经表达力更弱的 Chat Completions hub。但后续独立审计确认，当时实现把“direct”误当成“已经无损”：stream/non-stream和两方向translator仍各自维护领域语义，导致官方SDK生命周期不兼容、多个reasoning item串槽、server-tool四格丢失、Scenario B request consumer漏接和顶层能力静默裁剪。

旧 ADR 还把模型切换 opaque state 的判定完全交给 per-pair手工配置，理由是代理无法自动知道历史carrier由哪个模型签发。该理由对v1/external carrier成立，但新carrier可以携per-block source-model provenance；继续把所有新块都按request级配置整批处理，会失去混合来源history、replay、fork和并发candidate的精确性。

用户进一步提出：thinking block应成为fallback通用透明内容交换基础。协议分析确认目标正确，但Anthropic thinking本身不能作为内部通用格式；它带有Claude专属签名、redacted类型和原样回送要求。Responses reasoning同样有专属item lifecycle与encrypted_content。通用基础必须位于两者之上。

## 决策

### 1．共享语义，不共享wire

Anthropic↔Responses direct bridge采用protocol-neutral semantic mapper与keyed item ledger。Responses与Anthropic各保留独立wire emitter；non-stream与stream消费同一semantic state。不得以任一厂商wire block作为内部canonical格式。

### 2．Reasoning Exchange Envelope是fallback透明交换基础

每个reasoning item携：visible summary／omitted／redacted状态、opaque carrier、source protocol/provider/model、response/item identity、fallback boundary和partial状态。Anthropic thinking与Responses reasoning只是envelope的wire投影。

同模型工具续轮仍原样回送原生assistant content；不得先转envelope再重建Claude签名块。

### 3．Carrier v2 provenance + 配置兜底

新carrier v2携per-block source-model provenance。目标模型匹配时preserve opaque；不匹配时strip opaque并保留visible。v1、external和unknown carrier无provenance，继续由现有per-pair配置决定preserve／strip／reject。

不使用session-last-model。无provenance且无明确fallback配置时reject，不猜测。

这收窄旧ADR“代理无法自动判定，全部靠配置”：现在只有unknown provenance靠配置；v2按block自动判定。

### 4．Structured output：schema hash + configurable degradation

Anthropic→Responses将canonical schema映射为Responses `json_schema`，name由canonical schema SHA-256派生并满足Responses命名限制，设`strict:true`。Responses→Anthropic仅在目标schema dialect验证通过后映射明确`strict:true json_schema`。

默认fail-closed。`strict:false`、省略strict和`json_object`只有per-pair显式`allow-unconstrained`时可删除约束继续，并产生请求级WARN和History degradation。name／description不可逆信息进入diagnostic，不引入私有carrier。

### 5．Context management：per-pair配置化降级

默认reject。用户可per-pair显式选择：

- `warn-drop`：丢弃并记录请求级WARN／History；
- `threshold-only`：仅接受单一compaction、显式threshold、无instructions、无pause；只映射触发threshold并记录“触发意图近似、跨轮状态不等价”。

`clear_tool_uses`与`clear_thinking`不伪装成compaction；只能reject或显式warn-drop。混合/未知策略不得部分映射。暂不实现私有compaction carrier。

### 6．Typed observations与History是功能前置

所有preserved／normalized／degraded／dropped／stripped事实由semantic mapper发布typed observation。请求级日志去重、V3持久化和History API readback必须在有损能力切换前完成。History不复制opaque bytes。

## 收窄旧 ADR 的具体内容

保留：

- lossless-per-pair是默认设计轴；
- CC hub仅在一端真实为Chat Completions时合法；
- reasoning可读内容与opaque state应尽量round-trip；
- server-tool结果不得伪造Anthropic签名块；
- byte-critical客户端wire使用独立SDK oracle。

收窄：

- “reasoning全链路round-trip均已实施”改为目标不变量；当前实现未满足，须按新RFC重构。
- “稳定模型／模型切换全部靠per-pair配置”改为v2 provenance自动判定，unknown provenance配置兜底。
- “前向与反向两套carrier完全不共享”收窄为wire carrier编码仍区分方向，但共享Reasoning Exchange Envelope、provenance与policy contract。
- “六个方向腿直连即无损”改为direct只描述拓扑；保真须由semantic ledger、capability table、typed degradation和独立oracle证明。

## 后果

### 正向

- fallback／跨模型切换能逐item保留visible reasoning并精确剥opaque state。
- stream/non-stream和两方向不再各自重判语义。
- mixed provenance history、replay、fork和并发candidate有确定行为。
- capability loss可被日志、History和API观察。
- 渐进cutover可用shadow和reachability mutation证明无双发、无旧路径残留。

### 代价

- carrier wire升级为v2，并长期保留v1/external decoder和配置fallback。
- 引入request/candidate-local ledger与semantic snapshot。
- 配置schema增加互斥tagged policies。
- 需要官方OpenAI/Anthropic SDK oracle、History API集成测试和多阶段cutover。

## 未采纳方案

- 纯手工pair配置：保留作unknown provenance兜底，但不再是新carrier的唯一机制。
- session-last-model：时序污染，不采用。
- 厂商wire block作内部canonical：协议专属约束不可兼容，不采用。
- 通用wire-event bus：错误假设两协议lifecycle同构，不采用。
- structured-output私有carrier：公共wire复杂度高，不采用。
- context-management私有carrier：证据不足，推迟至独立PoC/ADR。

## 实施边界

本ADR与RFC先合master，不自动启动代码执行。实施须另有TDD计划和per-task kickoff；每个cutover按方向×transport×stream mode×History sink穷举，并在同一commit删除对应旧production dispatch。
