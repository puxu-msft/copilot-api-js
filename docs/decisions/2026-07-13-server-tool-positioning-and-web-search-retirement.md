# ADR: server_tool 的理解与定位，及 web_search 双跳退役

- **状态**：Accepted
- **日期**：2026-07-13
- **决策人**：用户（2026-07-13 会话）
- **相关**：CLAUDE.md `long-term-wins` / `architecture-health-first` / `empirical-verification`；[docs/tool-use.md](../tool-use.md)、[docs/DESIGN.md](../DESIGN.md)「活的架构现状」（web_search `[bypass]` 行、tool_search 行）；RFC [2026-07-13-retire-web-search-double-hop](../rfc/2026-07-13-retire-web-search-double-hop.md)（本 ADR 的实施切换计划）；探针 `exp/server-tool-web-fetch-poc/`、`exp/web-search-double-hop-live/`；backlog [server_tool proxy 推广条目](../todo/deferred-backlog.md)

## 背景

`copilot-api` 是一个把 GitHub Copilot（GHC）模型能力暴露为 Anthropic/OpenAI/Gemini 兼容端点的代理。围绕「server tool」我们积累了三套机制：web_search 双跳编排、config 的 `server_tool_strip`/`server_tool_rewrite`/`server_tool_web_search`、以及响应侧的 server-tool 块过滤器。但这些机制建立在一个**从未被审视的隐含假设**上——「客户端会向我们声明原生 Anthropic server tool，且期待服务端执行」。本 ADR 先厘清 server tool 的准确概念模型，再据实证裁决这些机制的去留。

## Part 1：server tool 到底是什么（概念定位）

### 不是「两套系统」，是「一个声明面 + 两条执行环」

所有工具——server 或 client——都在同一个 `tools[]` 数组声明，模型**决定调用**的机制完全相同（发出一个 use 块）。分岔只在**「谁执行、结果从哪来」**：

- **真·server tool**：模型发 `server_tool_use` 块 → **Anthropic 服务端就地执行** → 同一次响应里紧跟 `*_tool_result` 块 → **单轮闭环**，客户端只旁观。
- **普通/内置 client tool**：模型发 `tool_use` 块（`stop_reason:tool_use`）→ 把控制权交回**客户端** → 客户端执行、**下一轮**发 `tool_result` 回来 → **跨轮闭环**。

### 关键陷阱：`type:` 字段不决定谁执行——是三类而非两类

最易误判处：以为「有 `type:` 就是 server tool」。实际三类：

| 类别 | 声明形状 | 谁执行 | 块类型 |
|---|---|---|---|
| 自定义 client tool | `{name, input_schema}` 无 type | 客户端 | `tool_use` |
| **内置 client tool**（易混） | `{name, type}` 如 `memory_20250818` / `computer_20250124` / `text_editor_*` / `bash_*` | **客户端** | `tool_use` + `caller:{type:"direct"}` |
| **真·server tool** | `{name, type}` 如 `web_search_20250305` / `web_fetch_*` / `code_execution_*` | **服务端** | `server_tool_use` |

`memory`/`computer`/`text_editor`/`bash` 带 `type:`、长得像 server tool，但由**客户端执行**（实测：memory 产 `type:"tool_use"` + `caller:{type:"direct"}`，见 backlog 探针结论）。我们的 `SERVER_TOOL_TYPE_PREFIXES` 把这四个和真 server tool 混在一张前缀表里，**概念上是错位的**。判据不是「有没有 type」，而是「Anthropic 有没有把这个具体工具划为服务端执行」——只有 **web_search / web_fetch / code_execution** 是。**据此本 ADR 附带一项决策（决策 6）：全面纠正项目内把 client-executed 工具误称 server tool 的措辞/命名。**

### wire 上如何一眼认出（实测锚点）

三个 tell：① 块是 `server_tool_use` 还是 `tool_use`；② 结果在**同一响应**里（server）还是**下一轮才回来**（client）；③ `usage.server_tool_use` 计数器（仅 server tool 有）。

### server tool 的根本特殊性：签名结果通道（proxy 冒充不了）

server tool 不只是「执行位置不同」——它有一条**服务端签名的结果通道**：`web_search_tool_result` 的每项带 `encrypted_content`，一段服务端签名、客户端无法伪造的 blob，上游校验它必须是真实非空 string（空/null/占位全拒 400，实测 `exp/encrypted-content-400`）。这揭示 server tool 的本质：**它是「模型 ↔ 模型宿主服务端」之间的可信内循环**，结果被服务端背书、计入模型自己的输出、客户端无从插手也无从伪造。client tool 相反——结果是客户端提供的、模型须当「外部输入」处理。

**推论**：proxy 要「实现」一个 server tool，只能自己冒充那个服务端（双跳），且**拿不到签名通道**——合成的 `encrypted_content` 只能填 `""`、靠降级兜底。**冒充永远不彻底。**

## Part 2：实证——支持 server tool 是否有意义

用 4141 History API 只读扫**整个真实语料**（15GB 库，2026-07-13）：

- **原生 server tool 声明 = 0 命中**：`"type":"web_search_2025"` / `web_fetch_2025"` / `code_execution` / `bash_2025"` / `text_editor_2025"` **全部 0 条**。**没有任何真实客户端发过原生 Anthropic server tool。**
- **真实客户端（Claude Code）用的是 client tool**：`WebSearch`/`WebFetch` 都是 `type:"tool_use"`、Claude Code **自己执行**（实测真实请求，如抓 `code.claude.com/docs/hooks.md`，`state:completed`）。
- **OpenAI/Responses 路径**：`web_search_preview` 早已原样透传给上游 gpt-5.5、gpt-5.5 **原生支持**——与双跳无关。

三种客户端，web_search 双跳一个都不真正服务：Claude Code 自理（双跳若开还会劫持它）、Responses 路径原生透传、裸 Anthropic 客户端从没来过。

**证据强度的诚实边界**：History 语料是**单部署**（本用户）的流量，不能外推成「全世界没有客户端发原生 server tool」。但退役决策**不只**靠语料——更靠不依赖语料的**概念论据**：Claude Code 结构性地自执行 WebSearch/WebFetch（client tool）、Responses 路径原生透传给 gpt-5.5。即便将来出现发原生 server tool 的裸客户端，决策 3 保留的反应式自愈网仍兜底（strip 降级不硬失败），且知识留在 git + exp/ 可按需重建（见后果节）。故结论对语料代表性不敏感。

## 定夺

### 决策 1：退役 web_search 双跳（Anthropic 路径的服务端 web_search 冒充）

web_search 双跳服务 0 真实流量、默认关、是遗留 `[bypass]`，且 DESIGN.md 里几乎每条 v4 driver 迁移行都挂着「web_search 旁路例外/暂缓/别删」——它是压在整个 driver 收敛上的**永久税**。这是一次 **Spec 失败**（建得称职，但建了没人要的东西——把「让 web_search 能用」错等于「有人需要服务端执行 web_search」）。**退役它，并连带修复/删除为它推迟的工作。**

### 决策 2：保留 gpt-5.5 的 `web_search_preview`（OpenAI/Responses 路径原生透传）

它与双跳解耦（OpenAI 路径原生透传给上游 gpt-5.5），是真实可用能力，**保留不动**。

### 决策 3：删除 config 的 server_tool 拦截/支持键，但保留反应式自愈骨架

- **删**：`server_tool_web_search`（顶层 section）、`anthropic.server_tool_strip`、`anthropic.server_tool_rewrite` 三个 **config 键**（schema/compat/config.ts/state 定义 + config 驱动分支）。
- **保留反应式自愈安全网**（用户 2026-07-13 决策）：`stripServerTools`/`rewriteServerToolBlocks` 的**函数骨架**及其 **learned-cache / per-attempt-hint 源**、`server-tool-rejection-retry` / `web-search-not-found-retry` 策略。语义：客户端若真发原生 server tool 被 GHC 400，仍自动 strip 重试、不硬失败。保留一张零流量但低成本的安全网。

### 决策 4：保留 tool_search 整套 + `server-tool-filter`（与双跳无关的活特性）

`tool_search`（默认开、真实活跃使用）让客户端几十个工具 defer_loading 省 token；`server-tool-filter.ts`（响应侧**无条件常驻**、`appliesTo:ANTHROPIC` 无 config 门控）滤掉 `server_tool_use`/`*_tool_result` 块——**tool_search 强依赖它**。**绝对保留**，不随双跳删。

### 决策 5：保留 `server_tool_memory`（client-tool 透传，不属退役范围）

memory 是 client-executed（实测三绿），`rewriteMemoryTool` 是「注入声明供上游驱动、client 执行」的透传助手，**与服务端执行无关**。保留。

### 决策 6：全面纠正项目内对 server tool 的错误说法（用户 2026-07-13）

Part 1 立了正确的三类模型后，据此清扫项目内把 client-executed 工具（memory/computer/text_editor/bash）误称 server tool 的措辞与命名（`compat.ts`/`schema.ts`/`config.yaml`/`state.ts` 的 memory「server tool」表述、`message-tools.ts` 的「server tool prefix」注释、`isServerToolType`/`SERVER_TOOL_TYPE_PREFIXES` 误导性符号名）。**行为零变化**，纯认知/命名正确性。保持 `isServerToolBlock`/`isServerToolResultType`（判 `server_tool_use`/`*_tool_result` 真产物）不变。实施见 RFC Commit 5。

## 后果

- **正向**：删掉 web_search 双跳后，可连带清退一批「web_search 旁路暂缓」的 backlog 项（L3 未覆盖 hop、tool-field 学习缺口等变 moot）、简化 v4 driver 收敛、删除整条 legacy `runAnthropicPipeline`。
- **能力变化**：Anthropic 路径不再「冒充服务端执行 web_search」。裸 Anthropic 客户端若发原生 web_search，将被自愈网 strip（降级为无 web_search 能力）而非双跳合成——鉴于 0 真实流量，可接受。
- **知识不丢**：双跳的可行性与实现留在 git 历史 + `exp/web-search-double-hop-live/`（live 验证过）+ `exp/server-tool-web-fetch-poc/`。将来真出现需服务端执行 server tool 的客户端（如 universal-translation-matrix 把 Anthropic-native 客户端路由到 GHC），按需重建，且届时形状可能不同。

## 未采纳的方案

- **全面清退 server tool 机制（含反应式自愈 + strip/rewrite 函数）**：更彻底、代码更少，但失去对假想裸客户端的容错。用户选择保留安全网（决策 3），故不采纳。
- **一并删除 `server_tool_memory`**：memory 是独立 client-tool 特性、与双跳无关，删它破坏已实测特性。用户明确保留（决策 5），不采纳。
- **保留双跳作休眠 opt-in**：维持现状最省事，但永久 bypass 税不消除、driver 收敛持续受阻，违背 `architecture-health-first`。不采纳。
