# GHC 模型目录与能力检测（参考）

> **快照 as-of 2026-07-10（`AVAILABLE_MODELS.json` 抓取时间）**——模型目录是 GHC 最高 churn 的一面（新模型/别名/能力标志频繁变）。本目录的 `AVAILABLE_MODELS.json` 是一份**离线快照**，**live 真相**是运行期 `GET /models`（`curl -s localhost:4141/v1/models` 或上游 `src/lib/models/client.ts` 的 fetch）。核对具体模型能力**优先查 live**，快照用于离线/字段集参考。

## 这是什么

GHC 的 `GET /models` 返回**活的模型目录 + 每模型真实能力标志**——本项目 `src/lib/models/` 一整个目录镜像/消费它。本目录 `AVAILABLE_MODELS.json` 是该响应的实抓快照（~40 模型，含 Anthropic/OpenAI/Google/Azure/Microsoft/Experimental 多 vendor）。

## 字段形状（`AVAILABLE_MODELS.json` 每条 = `src/lib/models/client.ts` 的 `Model` 类型运行时实例）

一条模型 entry 的关键字段：

| 字段 | 含义 | 本项目消费点 |
|---|---|---|
| `id` / `name` / `version` | 模型标识 / 展示名 / 版本 | `resolver.ts`（别名解析）、`model-name.ts` |
| `capabilities.family` | 归一化家族（能力匹配的 `matches(family)` fallback 用） | `capabilities.ts`、`features.ts` 各 `modelSupports*` |
| `capabilities.supports.{adaptive_thinking, max_thinking_budget, min_thinking_budget, reasoning_effort, vision, tool_calls, parallel_tool_calls, structured_outputs, streaming}` | 每模型能力标志（thinking/vision/tool 等的**一手真相**） | `features.ts:modelHasAdaptiveThinking`（读 `adaptive_thinking`/`max_thinking_budget`）、`capabilities-mapper.ts` |
| `capabilities.limits.{max_context_window_tokens, max_output_tokens, max_prompt_tokens}` | 上下文/输出/提示上限 | auto-truncate 引擎、`max_output_tokens`/`max_thinking_budget` 硬上限（buffered-retry buffer 估算引它） |
| `capabilities.tokenizer` | `o200k_base` / `cl100k_base` | `tokenizer.ts`（本地 token 估算选表） |
| `supported_endpoints` | `["/v1/messages", "/chat/completions", "/responses", "ws:/responses"]` 子集 | `endpoint.ts:endpointsFor`（**present 则用，缺失才按 type 推断**）——决定路由/桥接 |
| `vendor` | Anthropic / OpenAI / Google / Azure OpenAI / Microsoft / Experimental | 路由、翻译矩阵 |
| `billing.{is_premium, multiplier, restricted_to}` | 计费（multiplier 现多为 1，warning_message 说已转 usage-based） | 成本核算（history multiplier 捕获） |
| `model_picker_category` / `model_picker_enabled` | powerful/versatile/lightweight / 是否在选择器 | 模型列表展示过滤 |
| `preview` / `policy.state` | 预览标志 / 启用状态 | 列表过滤 |

**注**：`request_headers` 是 `Model` 接口的可选字段（`client.ts`），**不出现在此快照**——它是运行期上游可能附加的模型特定 HTTP header（内部元数据），非公开字段集。

## 常见查找（grep 食谱，对本目录 `AVAILABLE_MODELS.json`）

```bash
D=.claude/skills/ghc-api-reference/references/AVAILABLE_MODELS.json
# 某模型支持哪些端点：
python3 -c "import json;d=json.load(open('$D'));print([m['supported_endpoints'] for m in d['data'] if m['id']=='gpt-5.5'])"
# 某模型能力标志（adaptive_thinking / reasoning_effort / vision）：
python3 -c "import json;d=json.load(open('$D'));m=next(x for x in d['data'] if x['id']=='claude-opus-4.8');print(m['capabilities']['supports'])"
# 所有走 /responses（含 ws）的模型（决定 CC→Responses 桥覆盖面）：
python3 -c "import json;d=json.load(open('$D'));print([m['id'] for m in d['data'] if '/responses' in (m.get('supported_endpoints') or [])])"
# 哪些模型是 Anthropic vendor（原生 /v1/messages 路径）：
python3 -c "import json;d=json.load(open('$D'));print([m['id'] for m in d['data'] if m['vendor']=='Anthropic'])"
```

## 能力检测的两个真相源

1. **`AVAILABLE_MODELS.json`（本快照 / live `/models`）**：每模型**实际声明**的能力标志（`supports.*`）。这是 GHC 对**具体模型**的一手真相——某模型是否 adaptive_thinking / 支持哪些 endpoint，**以此为准**。
2. **上游源码的 `modelSupports*`（`references/capability-matrix.md`）**：GHC 客户端**按模型名前缀**推断能力的**逻辑**（default-allow、family fallback 等）。当 metadata 缺某标志时，本项目的 `features.ts` 用名字前缀 allowlist 兜底——对照这份逻辑。

**裁决**：具体模型的能力优先信 metadata（`supports.*`，即本快照/live）；metadata 缺失或要理解「GHC 为何这样判」时查上游源码逻辑（capability-matrix.md）。二者不一致时以 live metadata 为准（本项目 `capabilities-mapper.ts` 正是「metadata 优先、名字前缀兜底」）。

## 刷新快照

```bash
curl -s localhost:4141/v1/models > .claude/skills/ghc-api-reference/references/AVAILABLE_MODELS.json   # 本代理透传上游目录
# 或直接问上游（需 copilot token，见 src/lib/models/client.ts 的 fetch 逻辑）
```
刷新后更新本文件顶部 as-of 戳。

## 本项目 `src/lib/models/` 消费地图

| 文件 | 职责 |
|---|---|
| `client.ts` | 定义 `Model` 类型（本快照的 schema）+ 拉取 `/models` + 刷新 |
| `capabilities.ts` / `capabilities-mapper.ts` | 把 metadata `supports.*` 映射为本项目能力判断（metadata 优先、名字前缀兜底） |
| `endpoint.ts` | `supported_endpoints` present 则用、缺失按 `type` 推断默认端点 |
| `resolver.ts` / `model-name.ts` / `normalize-id.ts` | 模型名/别名解析、归一化 |
| `tokenizer.ts` | 按 `capabilities.tokenizer` 选本地 token 表 |
| `refresh-loop.ts` | 周期刷新目录 |
