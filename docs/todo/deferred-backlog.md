# 暂缓 backlog（从记忆库归位）

从记忆库降为引用层（2026-07-05）时归位的活 backlog。每条：现状 / 暂缓原因 / 若做需改什么。

## GHC memory_tool 默认关 — CAPI 接受性待探针

- **现状**：`anthropic.memory_tool` 默认关。GHC 只在 BYOK 直连注入 `memory_20250818`、CAPI 路径不注入，故本项目经 CAPI 发该 server-tool 类型 + `context-management` beta 的**接受性未实测**。
- **若做**：先用探针 / history `sseEvents` 实测 CAPI 是否接受（见 skill `empirical-verification`）；被拒时 `unsupported-beta-retry` 只自愈 beta、body 里的 tool 类型无自愈（属未来工作）。保持关直到实测接受。
- **权威现状**：skill `ghc-api-reference` + `docs/plan/ghc-feature-alignment-tool-search-cache-ttl-memory.md`。

## context-edits 回执 telemetry（7d 分布）

- **现状**：`applied_edits` 诊断回执已落地（commit f55fd93，`src/lib/anthropic/applied-context-edits.ts`，流式经 accumulator `message_delta` / 非流式经 handler 顶层，两路发 `recordFeature("context-edits-applied", {count, clearedInputTokens, types})`），进 observability feature 维度计数。
- **暂缓**（用户 2026-06-29"暂时不做"）：接进 `request-telemetry` 做 7d 持久分布（现只 feature 维度计数，无 cleared token 量直方图）；实证开启 `protectStreamingEscalateContext` / `contextEditingMode` 后真有非空 `applied_edits`（当前样本 req_1782713407242_1 全空回执）。
- **原因**：命中率 / 价值未知，先收集 feature 计数再决定是否加 telemetry 维度（YAGNI）。遥测架构见 skill `telemetry-architecture`。

## setup-claude-code CLI 尊重已有配置（+/~/- diff）

- **现状**：`src/setup-claude-code.ts` 写 `~/.claude.json`/`~/.claude/settings.json`。config-respect UX（检测已存在的自定义配置、破坏性覆盖前展示直观 `+/~/-` diff 并确认、区分 essential=默认写 vs extension=仅 opt-in）**未实现、未文档化**——此设计意图原挂在记忆 `feedback_tests_never_touch_real_env` 的一条 How-to 里（该记忆的主旨是测试隔离、此条属跑题内容），记忆降 stub 时归位至此以免丢失。
- **若做**：给 `writeClaudeCodeConfig()` 加 merge/diff 层（读现有 config → 计算 essential/extension 分类 → 展示 diff → 确认再写）；无 CI/守卫，属独立 UX 特性。
- **原因**：非承重、无用户明确需求，先记录待用户决定优先级。

## RFC 数据模型裁剪审计 — 剩余低信号

- **现状**：12 个优先 RFC 已审（2026-06-24，4 并行 subagent + 主线核验）零 richest-data-flow 裁剪违规，3 个 SHOULD-BUILD 全实现（非流式语义残缺检测 / 顶层 `failureReason` 投影 / HTTP2 trailers 捕获，commit `0284935`/`6fd6d4d`/`e30ca33`）。判据已内化进 ADR `docs/decisions/2026-07-05-richest-data-flow.md`。完整审计叙事见 `docs/archive/memory/project-audit-rfcs-data-model-pruning.md`。
- **未审（低信号）**：非优先 RFC（p2.6 / upstream-http2 / tool-call-text-recovery）、observability sinks 的 filter 逻辑、dry-run `fidelity.caveats`（subagent 判为诚实文档非裁剪，可复核）。
- **判据**：字段 / 腿 / per-attempt 描述真实可观测阶段即须完整存（前端可不展示）；区分「裁剪数据模型」（禁止）vs「收敛捕获机制 / 单一 owner」（允许）。

## 前端 lint 未启用 react-hooks / jsx-a11y 规则（全仓 tooling 缺口）

- **现状**：`eslint.config.js` 调 `config({ prettier })` 未开 `reactHooks` / `jsx`（a11y）/ `react` 任一开关；预设 `@echristian/eslint-config` 默认三者 `enabled:false`（插件 `eslint-plugin-react-hooks@5` / `eslint-plugin-jsx-a11y` / `@eslint-react` 已装但未接线）。`eslint --print-config` 实测 resolved rules 里 `react-hooks/rules-of-hooks`、`react-hooks/exhaustive-deps`、`jsx-a11y/*` 全缺，仅 16 条 `react/jsx-*` 排版规则且都 off。
- **根因 / 当前行为**：hooks 依赖数组完整性、受控 state、a11y 标记全无自动化护栏——靠手写 + subagent review 兜底（如 ModelsTable TanStack 重写的 `select` useCallback 缺失是 subagent 抓的，非 lint）。ui-v4 是 hooks 密集子项目，长远正确性应把这类正确性固化为门禁。
- **暂缓原因**：跨切面 tooling 改动，牵动全 monorepo（含存量 Vue `ui/` + React `ui-v4/`）；整仓启用会牵出大量存量告警，需独立审计分批修，不宜塞进单个功能提交（会掩盖功能 diff + 有连累 sibling 包 lint 的风险）。属独立工作项而非「因范围大降级」。
- **若做**：`eslint.config.js` 的 `config({...})` 传 `reactHooks:{enabled:true}` + `jsx:{enabled:true, a11y:true}`（可选 `react:{enabled:true}`）；建议先用 `files` glob 限定 `ui-v4/**/*.{tsx,jsx}` 启用（实测本 PR 新代码零报错），再逐步扩到 `ui/`，逐包清存量告警。发现方：ModelsTable TanStack 重写的 subagent code review（2026-07-07）。
