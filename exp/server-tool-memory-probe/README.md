# PoC 探针：CAPI 路径对 `memory_20250818` server tool 的接受性实测

## 这是什么

一个一次性 PoC 探针，判定：**本项目经 CAPI（GitHub Copilot 非-BYOK 路径）**发原生
`memory_20250818` server tool + `context-management-2025-06-27` beta header，**上游到底接不接受**。

GHC 官方只在 **BYOK 直连**时注入这个 server tool，CAPI 路径从不注入，所以这条路的接受性
从未被实测——本项目的 `anthropic.server_tool_memory` 配置开关正因此**默认关闭**。本探针把它
临时打开，跑一次真实请求，从响应判定。

背景权威：skill `ghc-api-reference`；本项目实现见 `src/lib/anthropic/features.ts`
（beta header 构建）、`src/lib/anthropic/request-preparation.ts`（`rewriteMemoryTool` 改写）。

## 跑前提（凭据）

- **真实的 GitHub Copilot 凭据**。探针走本项目自己的 token 逻辑（`initTokenManagers`），与
  `bun run start` 完全一致。若你还没登录过，先跑 `bun run dist/main.js auth`（或项目文档里的
  auth 流程）拿到 GitHub token；探针会用它换 Copilot token。
- 若你是 **business / enterprise** 账户，必须设 `PROBE_ACCOUNT_TYPE`，否则上游 base URL 不对
  会在拉模型/发请求阶段失败。individual 账户无需设置。

## 怎么跑

```bash
# individual 账户，默认模型 claude-sonnet-4.5
bun run exp/server-tool-memory-probe/probe.ts

# 指定模型（必须是支持 memory 的 Claude，见下）
PROBE_MODEL=claude-opus-4.5 bun run exp/server-tool-memory-probe/probe.ts

# business / enterprise 账户
PROBE_ACCOUNT_TYPE=business bun run exp/server-tool-memory-probe/probe.ts
```

> ⚠️ 会**发一次真实上游请求**（max_tokens=64 的最小请求，成本极低，但确实消耗一次 Copilot 交互额度）。
> 在 `no-auto-server` 语境下 AI agent 不会替你跑——**由你手动执行**。

`PROBE_MODEL` 必须落在 `memoryModels` 允许列表内（否则 `rewrite-memory-tool` 不触发，探针会前置
报错并提示）。当前支持 memory 的 Claude 前缀：`claude-sonnet-4/4.5/4.6`、`claude-opus-4/4.1/4.5/4.6/4.7/4.8`、
`claude-haiku-4-5`、`claude-fable-5`（见 `src/lib/state.ts` 的 `memoryModels`）。

## 看什么

探针分 5 阶段打印。重点看两处：

1. **「实际发出的 wire」段**——确认生产管线确实产出了官方形状：
   - `wire.tools` 里出现 `{ "name":"memory", "type":"memory_20250818" }`（由 `rewriteMemoryTool` 改写）。
   - `anthropic-beta` header 含 `context-management-2025-06-27`（由 `forceMemoryContextBeta` 强制）。
2. **「结果」+「判据」段**——上游 HTTP status + 响应体 + 探针给出的接受/拒绝结论。

## 如何判定接受 / 拒绝

| 观测 | 结论 |
|---|---|
| 上游 **2xx**（无 HTTPError） | **接受**。上游未硬拒绝该 wire 形状。⚠️ 2xx 只证明「不拒绝」，不证明 memory 被真正启用——若要确认工具是否被激活（而非静默忽略），需查响应里有无 `server_tool_use` / memory 内容块，或在 history 的 `sseEvents` 里核对上游原始帧。 |
| **400** 且响应体点名 `memory` / `memory_20250818` / `context-management` / unknown tool `type` / `beta` 不支持 | **拒绝**。CAPI 不接受该特性 → `server_tool_memory` 应保持默认关闭。 |
| **400** 但响应体未点名上述关键词 | **需人工判读**。可能是别的字段问题（thinking / effort / schema），逐字读 response body 判根因，别误判成 memory 被拒。 |
| 非 400（401/403/429/5xx） | 多半**与 memory 无关**（鉴权 / 额度 / 模型 / 网络）。排除干扰后重跑，确认凭据与 account-type 正确。 |

判据逻辑已内联在 `probe.ts` Phase 5，会自动打印命中的信号（`memory=… toolType=… beta=…`）。

## 结论回填模板

跑完后把下面这段的结论从「待跑」改成实测结果，并把关键响应体粘进来：

---

## 结论：待跑

- 跑的日期 / 模型 / account-type：
- 上游 HTTP status：
- `anthropic-beta` 实际值：
- `wire.tools` 里的 memory 工具形状：
- 响应体关键片段（400 时贴拒绝原因；2xx 时贴是否出现 memory / server_tool_use 内容块）：
- 判定（接受 / 拒绝（原因） / 需人工判读）：
- 后续动作（例：若接受 → 可评估把 `server_tool_memory` 默认开；若拒绝 → 保持默认关，记入 backlog）：
