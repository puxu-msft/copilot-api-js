# Plan: 补全 CC 2.1.207 工具清单（F28 + F32，F30 已收敛进 F28）

> 状态：执行中（隔离 worktree `feat/cc-tool-inventory-ssot`，BASE 1828a71d）。
> 源：`docs/todo/cc-client-2.1.207-behavior-audit.md` 的 F28/F32（F30 实现期证伪、收敛进 F28）。

## 背景 / 根因

CC 客户端相关审计发现两处名单陈旧（`src/lib/anthropic/message-tools.ts`）：
- **F28**：`CLAUDE_CODE_OFFICIAL_TOOLS`（16 个）漏 CC 2.1.207 真工具 `WebSearch`/`BashOutput`/`NotebookRead`（+ MCP 资源工具）。此清单双用途：① stub 注入安全网（历史 tool_use 引用当前 tools 缺失的工具时注入空 schema 声明，否则 GHC 拒无声明 tool_use）；② **经 `NON_DEFERRED_TOOL_NAMES` 第 86 行 `...CLAUDE_CODE_OFFICIAL_TOOLS` spread**，同时决定哪些工具不被 tool-search 延迟。故补全此清单**一处修两个症状**（stub + 非延迟）——这也是 F30「CC 核心工具无静态保护」证伪后的真实残余（只有不在此清单的工具两处都缺保护）。
- **F32**：`API_DEFINED_TOOL_TYPE_PREFIXES`（6 个前缀）漏 CC 2.1.207 server-tool 类型 `advisor_`/`agent_toolset_`/`memory_`。这些 typed server 工具被误分类为 custom → 失去「不 sanitize 名/不延迟」保护（server 工具名是 upstream 协议契约，改了上游不认）。

## 全局约束（Global Constraints）

- **只改** `src/lib/anthropic/message-tools.ts` 的两个常量 + 对应新增测试文件；不动其他逻辑、不重构延迟/stub 流程。
- **权威源**：CC 2.1.207 源码 `~/.claude/refs/claude-code-2.1.207/app.pretty.js` 的工具名常量（`X = "Name"`）与 server-tool `type` 值（`type: "X_20YYMMDD"`）。**源码常量证「CC 内部有此工具」，不证「每次都发进 tools 数组」**——但补进清单是**加法安全**：stub 仅在被历史引用时注入、非延迟仅让工具保持加载，都不会破坏正常请求。
- **保留既有注释**（`// VSCode Copilot Chat original tool names` / `// Claude Code official tool names` 分组注释、`prettier-ignore`）。
- 新工具项按现有风格（PascalCase 字符串、每行一个）；新前缀保持 `<category>_` 形式 + 末尾下划线。
- **不引入新模块**：`CLAUDE_CODE_OFFICIAL_TOOLS` 已是客户端工具名的单一来源（已被 `NON_DEFERRED_TOOL_NAMES` spread 消费）；server 类型前缀是正交轴，留在原地。
- 测试用 **bun test**（后端）；文件放 `tests/`（就近 message-tools 测试）；断言正样本先证检查触达目标（[[feedback-pass-null-clean-not-self-validating]]）。
- typecheck（`bun run typecheck`）+ lint（`bunx eslint <改动文件>` 无缓存）+ 相关测试必须绿。

## Task 1（唯一任务）：补全两个清单 + 回归测试

### 1a. 补 `CLAUDE_CODE_OFFICIAL_TOOLS`（message-tools.ts:44-61）

追加（在 PascalCase 数组内，末尾或语义合适处）：
- `"WebSearch"`（`app.pretty.js:147746` `Hee="WebSearch"`；≠ 已有 `WebFetch`）
- `"BashOutput"`（后台 shell 输出工具）
- `"NotebookRead"`（≠ 已有 `NotebookEdit`）
- `"ListMcpResources"`、`"ReadMcpResource"`（MCP 资源工具；CC 真工具，仅 MCP server 在场时发，但作为 stub 候选加法安全）

**不加**（faithful，避免加非工具）：`MultiEdit`（源码 freq 1，疑已废弃）、`Agent`（`hi="Agent"` 常量存在但不确定是否作为 tool 进 tools 数组——subagent 派发是 `Task`；留 TODO 注释，待真实抓包确认）。

补全后 `NON_DEFERRED_TOOL_NAMES`（第 86 行 spread）**自动**获得这些工具的非延迟保护——无需改 NON_DEFERRED 定义（验证 spread 生效即可）。

### 1b. 补 `API_DEFINED_TOOL_TYPE_PREFIXES`（message-tools.ts:332-339）

追加前缀：
- `"advisor_"`（`advisor_20260301`）
- `"agent_toolset_"`（`agent_toolset_20260401`）
- `"memory_"`（`memory_20250818`；注意：memory 另有 rewrite 成 native，但 typed 工具经 `isApiDefinedToolType` 仍须识别为 API-defined 以免被当 custom sanitize/延迟）
- `"tool_search_"`（`tool_search_tool_regex_20251119`；项目自注入的 tool-search 工具走独立路径，但客户端若发 tool_search-typed 工具须识别——robustness）

### 1c. 测试（新增 `tests/message-tools-cc-tool-inventory.test.ts` 或就近扩展现有 message-tools 测试）

**正样本先证**（防空洞断言）：
1. `CLAUDE_CODE_OFFICIAL_TOOLS` 含新增 WebSearch/BashOutput/NotebookRead/ListMcpResources/ReadMcpResource（且仍含原 16 个——防误删）。
2. **stub 注入**：构造一条「历史 assistant tool_use 引用 `WebSearch`、当前 `tools` 不含 WebSearch」的 payload，经 `processToolPipeline`/stub 注入路径（`state.injectClaudeCodeOfficialTools=true`），断言输出 tools 含 `WebSearch` 的 stub（空 schema）。**正样本对照**：先跑一个「引用一个既不在清单、也不在 tools 的假工具」的负例，证 stub 注入确实按清单注入（而非无条件注入所有）。
3. **非延迟 spread**：断言 `NON_DEFERRED_TOOL_NAMES.has("WebSearch")` 为真（经 spread 自动获得）——即补清单确实同时修非延迟保护。
4. `isApiDefinedToolType`：`isApiDefinedToolType("advisor_20260301")`/`("agent_toolset_20260401")`/`("memory_20250818")`/`("tool_search_tool_regex_20251119")` 全为 `true`；一个 custom 名（如 `"my_custom_tool"`）为 `false`（负样本，证不是恒真）。
5. **server 工具不被 sanitize/延迟**：若能低成本构造，断言带 `type:"advisor_20260301"` 的工具经 `buildAnthropicToolNameMapper` 的 `customNames` 过滤后**不在** custom 集（即被 `isApiDefinedToolType` 排除）。

### 验收标准（Acceptance）

- 两清单补全，原有项无删。
- 新测试全绿；正样本对照证检查触达目标。
- `bun run typecheck` 绿；`bunx eslint src/lib/anthropic/message-tools.ts <test>` 无缓存净。
- 相关既有测试（message-tools / tool 相关）仍绿——不回归。

## 备注：未纳入本 plan 的相邻 findings（后续独立）

- **F23**（vision 检测漏 tool_result 内嵌 image）：不同文件（request-preparation.ts），独立任务。
- **F27**（tool-search 关时不剥孤儿 defer_loading）：行为改动，需 e2e 验证，独立任务。
- **F19/F20**（richest-data-flow 捕获）：较大设计，独立。
- Agent/MultiEdit 是否补：需真实 CC 抓包（skill `client-proxy-e2e-testing`）确认后再定。

---

## Task 2（修订，取代 Task 1 的 F28 落地）—— 根因修复 + 回退清单

> 缘起：Task 1 实现后，主会话 deep-read + task-reviewer 探针揭示 F28/F32 的真实机制比原 plan 窄。用户裁决：**F28 走根因修复 + 回退清单**；F32 前缀保留但校正审计文案。

### 已核实的真实机制（读码 + reviewer 探针）

三条 stub 注入路径（`message-tools.ts`）：
- **Path 1**（226）：`injectClaudeCodeOfficialTools` 门控，无条件为**每个缺失的官方工具**注入 stub（不看 history）。**非** tool-search 门控。
- **Path 2**（243）：为**任意** history 引用但当前缺失的工具注入 stub（name-agnostic 安全网）——**但被 tool-search 门控**（176 `historyToolNames = toolSearchEnabled ? … : undefined`）。**这是 bug**：孤立历史 tool_use 无论 tool-search 开关都会被 GHC 拒，安全网不该门控。
- **Path 3**（300）：请求**完全无 tools** 时按 history 注入（无 tool-search 门控）。

F28 真实 gap（比原判窄）：**tool-search OFF + 有 tools + 孤立的非官方工具在 history**（如禁用的 MCP 工具 / WebSearch）→ Path 1 只覆盖官方、Path 2 被门控关、Path 3 只在无 tools → 无人兜底 → GHC 硬拒。

F32 校正（reviewer 探针实测）：`shouldDefer`（199-204）**只按 `tool.name`** 匹配 `NON_DEFERRED_TOOL_NAMES`，**从不查 `tool.type`/`isApiDefinedToolType`** → typed server 工具（含原有 6 前缀 web_search_/text_editor_ 等）在 tool-search 下**仍可能被 `defer_loading:true`**。故 F32 前缀补全**只修 sanitize 保护**（`buildAnthropicToolNameMapper` 的 customNames 过滤经 isApiDefinedToolType 排除 server 工具），**不修延迟保护**。原 plan 1b「以免被延迟」+ 审计 F32「可被延迟(F30同机制)」表述**错误**。

### Task 2 改动（精确）

1. **回退** Task 1 对 `CLAUDE_CODE_OFFICIAL_TOOLS` 的 5 项追加（WebSearch/BashOutput/NotebookRead/ListMcpResources/ReadMcpResource）——根因修好后 Path 1 不再需要它们，且避免无条件注入这些条件性工具（空 schema stub 进不用它们的请求）。保留原 16 项 + 那段 MultiEdit/Agent TODO 注释可删（连同回退）。
2. **根因修复**：`message-tools.ts:176` 解除 Path 2 的 tool-search 门控 —— `const historyToolNames = collectHistoryToolNames(messages)`（总是计算）。核实副作用：`shouldDefer`（204 `!historyToolNames?.has`）仍受其自身 `toolSearchEnabled &&` 首条件门控 → tool-search off 时 shouldDefer 恒 false、无行为变化；仅 Path 2（243）现在总运行 → 安全网 name-agnostic 覆盖任意孤立历史工具。
3. **F32 前缀保留**（advisor_/agent_toolset_/memory_/tool_search_ 已加，正确——修 sanitize 保护）。
4. **测试改**：F28 测试从「测 CLAUDE_CODE_OFFICIAL_TOOLS 追加」改为「测 Path 2 解除门控」——正样本对照：构造「history 有 assistant tool_use 引用某非官方工具（如 `some_mcp_tool`）+ 当前 tools 不含它 + tool-search OFF（用一个不支持 tool-search 的模型或显式关）」，断言输出 tools 含该工具的 stub；负样本：tool-search OFF 且 history 无孤立引用时不乱注入。F32 测试保留（isApiDefinedToolType 4 前缀 + 负样本），但**删/改**那条「typed 工具不被延迟」的错误期望（若有）——改为只断言 sanitize 排除（hasOriginal 不命中），并注释说明延迟保护是独立未修 gap。
5. **文档校正**：
   - `docs/todo/cc-client-2.1.207-behavior-audit.md` F32 节（~928/934 行）：删「可被延迟(F30同机制)」错误断言，改为「前缀补全修 sanitize 保护；**延迟保护是独立 gap**——`shouldDefer` 只按 name、typed server 工具（含原 6 前缀）在 tool-search 下仍可能被 defer，记入 deferred-backlog」。
   - `docs/todo/deferred-backlog.md`：新增条目「typed server 工具可被 tool-search 延迟」（根因 `shouldDefer` name-only、当前行为 advisor_/web_search_ 等 type 工具 defer_loading:true、理想 shouldDefer 排除 isApiDefinedToolType、为何暂缓=需确认 GHC 对 deferred server 工具的实际反应 + 独立于本任务范围）。
6. 验收：typecheck 绿 + eslint（改动文件，无缓存）净 + 新测试绿 + 既有 message-tools 相关测试不回归。
