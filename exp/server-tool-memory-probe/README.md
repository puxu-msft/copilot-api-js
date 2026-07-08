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

## 结论：接受（enterprise 账户实测）

- 跑的日期 / 模型 / account-type：2026-07-08 / `claude-sonnet-4.5`→resolved `claude-sonnet-5` / **enterprise**（`PROBE_ACCOUNT_TYPE=enterprise`；token `sku=copilot_enterprise_seat_quota`）。
- 上游 HTTP status：**2xx（接受）**。`stop_reason: end_turn`，正常完成。
- `anthropic-beta` 实际值：`context-management-2025-06-27,advanced-tool-use-2025-11-20`。
- `wire.tools` 里的 memory 工具形状：`[{"name":"memory","type":"memory_20250818"}]`（生产 `rewriteMemoryTool` 改写正确）。
- 响应体关键片段：`{"content":[{"text":"probe ok","type":"text"}], "context_management":{"applied_edits":[]}, ...}` ——**响应体回显了 `context_management` 字段**（`applied_edits:[]`，本次无可编辑内容故空），证明上游**主动识别并处理了** context-management 特性，而非静默忽略。无 `server_tool_use` 块（memory 工具未被调用——最小 prompt 不触发存取，属预期）。
- 判定：**接受**。CAPI（enterprise）不拒绝 `memory_20250818` server tool 声明 + `context-management-2025-06-27` beta；`context_management` 回显进一步证明特性被激活。
- 后续动作 / 边界：
  - 已确认的是 **wire 接受性**（工具声明 + beta 被上游接纳并处理）；端到端 memory 调用**已在后续实测确认**（见下节）。
  - **仅在 enterprise 账户 + enterprise 端点确认**。首跑用默认 individual base URL（`api.githubcopilot.com`）时请求**挂起无响应**（enterprise token 路由到 individual 端点的行为不明），故 individual/business 端点的接受性**未确认**、不可外推。
  - **可评估**把 `anthropic.server_tool_memory` 默认开（至少对 enterprise）——但建议先补 individual/business 端点确认，再决定是否翻默认。
  - 探针进程发完请求打完判据后现已 `process.exit` 干净退出（改前残留 keepalive/token-refresh timer 被外层 timeout 杀）。

---

## 端到端调用实测（2026-07-08，enterprise）：**memory 工具真被调用 · 确认**

参数化探针加了 `PROBE_PROMPT` / `PROBE_MAX_TOKENS` env（不传时逐字保持默认行为）+ `scanE2e()` 扫描 + `process.exit`。用会诱导 memory 使用的 prompt、`PROBE_MAX_TOKENS=1024` 跑，结果：

- 两个诱导 prompt（"检查你的 memory" / "把这条存进 memory"）**都**让上游产出真实的 memory 工具调用块：
  `{"name":"memory","type":"tool_use","input":{"command":"view","path":"/memories"},"caller":{"type":"direct"}}`，`stop_reason:"tool_use"`。
- 这不是文本敷衍（"我记住了"），是结构化 `tool_use`——**端到端激活确认**。
- **关键细节：memory 是 client-executed 工具（`type:"tool_use"`，非 `server_tool_use`）。** 符合 Anthropic 官方协议：上游只**驱动**工具（发起 view/create/… 命令），实际存取由 **client 侧**（如 Claude Code）执行 `/memories` 后端并 tool_result 喂回，多轮至 `end_turn`。故不会有 memory 相关的 `server_tool_use` 或 `applied_edits`（`applied_edits` 属同 beta 下的 context-editing 特性，与 memory 正交）。本项目侧只需**透传**该 tool_use、不拦截即可，无需自建 memory 后端。

复跑：
```bash
timeout 90 bash -c 'PROBE_ACCOUNT_TYPE=enterprise \
  PROBE_PROMPT="Check your memory for any notes about me, then tell me what you find. Use the memory tool to look." \
  PROBE_MAX_TOKENS=1024 bun run exp/server-tool-memory-probe/probe.ts'
```

完整报告：`.superpowers/sdd/memory-e2e-report.md`。
