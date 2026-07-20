# 把 Anthropic token 计数改成镜像官方结构开销算法（纯本地，无配置开关）

> **实施状态：未实施（未采纳）**
> **落地**：—
> **现状锚点**：现状仍走 `src/lib/anthropic/auto-truncate/token-counting.ts` 的 contentToText 拍平计数
> **备注**：结构化开销算法未移植（grep BASE_TOKENS_PER_MESSAGE 空、token-counting.ts:14 仍 contentToText）；注：同名 -review.md 是错配的无关文件

## Context（为什么做这个改动）

用户洞察被实测+源码证实：**Copilot 后端不用 gpt-tokenizer 拍平文本计数**。当前 auto-truncate 的 `contentToText`（[token-counting.ts:14](src/lib/anthropic/auto-truncate/token-counting.ts#L14)）把 Anthropic message 的 block 拍平成纯文本喂 tiktoken，对 tool 密集 payload 只估出真实值的 ~1/2（factor 2x）。

**已查证（microsoft/vscode 最新源码 `refs/vscode-copilot-chat-upstream/extensions/copilot/src/platform/tokenizer/node/tokenizer.ts`）：**
1. **GHC API 没有 count_tokens 端点**（零结果）；Copilot 后端只用 tiktoken（o200k/cl100k），claude 模型也是 o200k——**没有 Anthropic 原生 tokenizer**。所以 factor 2x 100% 来自结构开销，不是 tokenizer 差异。我们的 base tokenizer 已对（claude→o200k）。
2. 官方客户端**本地**用 tiktoken + 一套结构开销算法（BaseTokensPerMessage=3、tool_calls×1.5、tools base16+8/tool×1.1、name+1、image tiles）。

**用户决策（最新）：纯本地方案，不要配置开关，直接用最佳方案。** 所以**不做** `token_counting` config 项、不保留 flat 模式、不加 dispatch 分支——直接把 `contentToText`/count 家族改成结构化算法。

**实测基准**：1274-msg payload（601 tool_use + 601 tool_result + 53 tools，0 image）当前估 494139，Anthropic 真实 1033154（factor 2.09）。目标：结构化后 factor → ~1.0（|factor−1| ≤ 0.10）。

## 权威算法（refs 源码，逐条移植）

```
BASE_TOKENS_PER_MESSAGE = 3      // 每 message
BASE_TOKENS_PER_COMPLETION = 3   // 每 payload 一次（回复引导）
BASE_TOKENS_PER_NAME = 1         // 每个 name 字段
TOOL_CALLS_MARGIN = 1.5          // tool_use 子树 ×1.5
TOOLS_BASE = 16; TOOLS_PER_TOOL = 8; TOOLS_MARGIN = 1.1   // tools 定义
```
官方递归 `countMessageObjectTokens`：逐 key/value 算 token，`tool_calls` 子树 ×1.5，`name` +1。注意官方算 OpenAI 格式（key=tool_calls/content），我们是 Anthropic block（content 数组，block.type ∈ text/tool_use/tool_result/thinking/image/server_tool_use）——按 block 类型映射等价开销。

---

## 改动点

### 1. token-counting.ts：结构化计数（替换 contentToText 拍平逻辑）

新增常量 + 按 Anthropic block 类型的结构公式。**直接替换**（不保留 flat 分支）：

**per-block `countBlockStructured(block, model, opts)`：**
- `text` → `tokenLen(block.text)`（无附加）
- `tool_use` / `server_tool_use` → `floor((tokenLen(name) + BASE_TOKENS_PER_NAME + tokenLen(JSON.stringify(input))) × 1.5)` —— Anthropic tool_use = OpenAI tool_calls 等价，套 ×1.5
- `tool_result` → `tokenLen(tool_use_id)` + content 计数（string→tokenLen；array→逐 inner：text→tokenLen(text)、image→imageCost、else→tokenLen(JSON.stringify(inner)))。**不乘 1.5**（官方只对 tool_calls 乘）
- `thinking` → `includeThinking ? tokenLen(block.thinking) : 0`
- `redacted_thinking` → 0
- `image` → `imageCost(block.source)`（见下）
- 未知/`*_tool_result` → `tokenLen(JSON.stringify(block))`（避免静默低估，当前 contentToText 只发 `[type]`）

**per-message** `countMessageTokens`：`BASE_TOKENS_PER_MESSAGE(3)` + Σblock（string content 直接 tokenLen）。（旧的 +4 改成 +3，对齐官方；缺口由 per-block 附加补上。）

**system** `countSystemTokens`：text + `BASE_TOKENS_PER_MESSAGE`。

**tools** `countToolsStructured`（替换 countFixedTokens 里的 `JSON.stringify(tools)` 一把梭）：`TOOLS_BASE(16)` + 每 tool（`TOOLS_PER_TOOL(8)` + 逐 key/value：name/description/parameters(=input_schema) 的 key token + value token），最后 `floor(× TOOLS_MARGIN(1.1))`。（Anthropic tool 字段是 `input_schema`，[anthropic.ts:99](src/types/api/anthropic.ts#L99)。）

**total** `countTotalTokens`/`countTotalInputTokens`：system + tools + Σmessage + **`BASE_TOKENS_PER_COMPLETION(3)` 一次性**（**只在 total，绝不进 per-message**——否则 binary search 累加双计）。

### 2. image tiles 算法（`imageCost`）
移植官方 `calculateImageTokenCost`：detail 缺省按 high；缩放到 2048 box → 768 短边 → `tiles = ceil(w/512)*ceil(h/512)` → `tiles*170+85`。Anthropic `Base64ImageSource` 无宽高，需 `decodeImageDimensions`（从 base64 头解 PNG IHDR/JPEG SOF/GIF/WebP）；解不出→保守 fallback `85+170`（单 tile）。**probe payload 0 image，先 ship fallback，图多再细化解码器。**

### 3. 公共签名不变，消费者零改动
所有 `count*` 函数**保持原签名**，内部换算法。消费者（反应式 strategy 的 countTokens 闭包、binary search 的 perMessageTokens、autoTruncateAnthropic 内部、debug route、count-tokens route）**无需改**。
- **per-message 含结构开销**（tool_use ×1.5、tool_use_id framing）→ binary search 累加与 structured tokenLimit/fixedOverhead 同口径，自洽。`contextReserveTokens=160` 不变。
- 反应式 strategy 的 `gptCount` 现在=结构化值 → `ratio = reportedCurrent/gptCount` 从 ~2.0 降到 ~1.0（正确且自洽，同一计数器喂 ratio 和 pre-check）。

### 4. calibration 迁移（engine.ts）
旧 learned-limits.json 的 calibrationFactor（~1.98）基于 flat 学的，结构化后会**重复计**结构开销 → 过度截断。
- `LearnedLimitsFile.version` 1→2（[engine.ts:198](src/lib/auto-truncate/engine.ts#L198)），`persistLimits` 写 version 2。
- `loadPersistedLimits`：v1 当**迁移**——保留 `tokenLimit`（tokenizer 无关，仍有效），但 `calibrationFactor` 重置 1.0、`sampleCount` 0；v2 原样加载。
- calibration 机制**保留**（不在本次删），结构化后它趋近 1.0 idle，吸收残余 per-model 漂移（如 cache_control token），零成本。反应式 per-request ratio 每次自适应，calibration 实际可有可无但留作安全网。

---

## 测试

| 改动 | 文件 | 后缀 | 断言 |
|------|------|------|------|
| per-block 公式 | tests/anthropic/structured-token-counting.unit.test.ts（新） | `.unit` | tool_use=floor((nameTok+1+inputJsonTok)×1.5)；tools=floor((16+Σ)×1.1)；text 无附加；thinking includeThinking=false→0 |
| 一致性不变式 | 同上 | `.unit` | Σper-message + fixed + completion-base == total（防 BASE_TOKENS_PER_COMPLETION 双计）|
| image tiles | 同上 | `.unit` | 1×1 PNG→单 tile 成本；>2048→正确缩放；无宽高→fallback |
| 端到端 factor | tests/pipeline/auto-truncate.it.test.ts（扩展）或新 it | `.it` | 用真实大 payload 形态（高 tool 密度），结构化估算 / 已知真实 ≈ 1.0（|factor−1|≤0.10）|
| calibration 迁移 | tests/?（engine） | `.unit` | v1 fixture load → calibrationFactor 重置 1.0、tokenLimit 保留 |
| 无回归 | 现有 auto-truncate.it / pipeline | 既有 | 截断仍正确（结构化下 token 更大、target 换算自洽）|

验证探针：`/debug/dry-run-truncate` replay 真实 payload（refs/ 下的 1274-msg dump 或 history），确认 `gptTokenizer` 从 ~494k 升到 ~950-1050k、与 reported.current 1033154 比 ≈ 1.0。

---

## 实现顺序

1. token-counting.ts：常量 + countBlockStructured + system/tools/image/total 结构函数，**直接替换** contentTotext 拍平逻辑（纯函数，先 unit 测）。
2. 确认公共签名不变、消费者编译通过。
3. calibration 迁移（engine.ts version 1→2 + 旧 factor 重置）。
4. 端到端 + 探针验证 factor≈1，微调 tool_use_id framing / margin。
5. typecheck + lint + test:backend 全绿。

每阶段 `bun run typecheck` + 对应 `bun run test:*`。

---

## 风险与注意

1. **过估方向安全**：×1.1/×1.5 是官方安全 margin，结构化倾向略高估 → 略早截断，比低估 ship 超长 → 400 安全。
2. **image 解码器**：保守 fallback 兜底，0-image payload 无风险，图多再细化。
3. **BASE_TOKENS_PER_COMPLETION 双计**：靠一致性不变式 unit 测守门。
4. **性能**：结构化 per-block 多调 countTextTokens，但 encoder 有 cache，1274 msg 可接受；热则加 per-string memo（官方有 LRU）。
5. **不做 config 开关**（用户明确）：纯本地最佳算法，不保留 flat 模式。
6. **calibration 不删**（本次只迁移），独立 cleanup 另议。

---

## Verification（端到端）

1. `bun run typecheck` + `bun run lint:all` 干净。
2. `bun run test:backend` 全绿（新结构计数测试 + 无回归）。
3. 探针：`/debug/dry-run-truncate` replay 真实大 payload → `gptTokenizer` ≈ Anthropic 真实（factor 0.9-1.1），对比修复前 ~0.48。
4. 用户重启服务器后：超长请求的反应式 ratio 日志从 ~1.98 降到 ~1.0；截断决策更准，learned calibration 趋近 1.0。
