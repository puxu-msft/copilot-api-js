# PoC 结论：GHC `cache_write_tokens` 净公式

日期：2026-07-12 · 门控 spec `docs/spec/2026-07-12-ghc-usage-details.md` §3 · 计划 `docs/plan/2026-07-12-ghc-usage-details/plan-0-poc.md`

## 实测尝试与结果

在运行中的 live server（`localhost:4141`，7.8G history.db）上通过 History API 探测，**未能取到真实的 OpenAI 家族 cache-write 样本**：

- `endpointDistribution`：`anthropic-messages` 9788、`openai-chat-completions` **1**、`openai-responses` **1**、gemini 0。本服务器几乎只服务 Claude Code（Anthropic 原生腿）。
- 唯二的 OpenAI 家族历史行（`req_1783803532280_122` / `req_1783803590840_127`）都是无缓存的小请求（`{input_tokens:392/54, output_tokens:66/18}`），既无 `cached_tokens` 也无 `cache_write_tokens`，无法校准。
- 搜索 `cache_write_tokens` 命中的全是 anthropic-messages 行（是本次讨论的对话内容被 history 记录、文本里出现该字面量，非 usage 字段）。

结论：live DB 无法实测子集 vs additive。按计划 fallback 采**保守子集假设**，依据如下。

## 采纳：**子集**（`cache_write_tokens ⊂ prompt_tokens`）

净公式：`input = prompt_tokens − cached_tokens − cache_write_tokens`

oracle：`input + cache_read + cache_creation == prompt_tokens`

### 依据（非实测，推理链）

1. **用户实测样本自洽**：`prompt_tokens(437256) = cached_tokens(436157) + 净(1099)`，证 `cached_tokens` 确是 `prompt_tokens` 的**子集**（该样本 cache_write 为 null）。
2. **GHC 官方参考实现**：`refs/ghc-api-py/ghc_api/translator.py:286` `input_tokens = prompt_tokens - cached_tokens`——GHC 把 `prompt_tokens` 当作「含 cached 的总提示」。
3. **语义**：cache_write = 处理并写入缓存的输入 token，本就是被处理的 prompt 的一部分，与 cached 同属 `prompt_tokens`。
4. **Anthropic 映射**：GHC 代理的底层是 Anthropic 模型（其 input/cache_read/cache_creation 三者 disjoint）；转 OpenAI 格式时把三者并进 `prompt_tokens` 是唯一一致的映射。

### 残余风险与双重防护

若真相是 additive（cache_write 独立于 prompt_tokens），子集公式会**少算** `input_tokens`（多减了 cache_write）。但风险被两层防护限制：

- **backfill 的 per-row oracle 自校验**（关键）：backfill 从原始帧拿到真实 `prompt_tokens`/`cached`/`cache_write`，若子集 oracle（`input+cache_read+cache_creation == prompt_tokens`）对某行不成立，该行**被跳过并计入 errors、不被改写**——错误假设不会损坏历史数据，只会漏补。这使净公式的错误在 backfill 侧**不可能造成静默损坏**。
- **场景限制**：cache_write 仅出现在缓存创建请求（会话首访）。该场景下这些 token 确实是被处理的 prompt 一部分，子集几乎必然正确。

### 后续实证（当条件具备时）

当本服务器出现真实的 OpenAI 家族 cache-create 流量后，用 History API 复验一条：取其上游原始 usage 帧，核对 `prompt_tokens == fresh + cached + cache_write`。若发现 additive 反例，改 `usageFromTotalInput` 与 backfill 为 additive 分支（spec §3 已留），并重跑 backfill（幂等标记列支持）。

## 对下游 Phase 的指令

- **Phase 1**：`usageFromTotalInput` 采子集分支 `netInputTokens(totalInput, cacheRead, cacheCreation)`（减 cache_write）。
- **Phase 2**：backfill 采子集重算 + 子集 oracle 自校验；additive 分支代码保留但不启用。
