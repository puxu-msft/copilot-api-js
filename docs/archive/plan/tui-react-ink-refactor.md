# 重构 src/tui（React-Ink 监控应用）：拆组件 + 修复 cache 双色显示

> **实施状态：未实施（reverted）**
> **落地**：曾 d09cc79/38687b4 落地，后 52e50eb 移除
> **现状锚点**：现由 `src/lib/observability/projections/` 取代（原 src/tui 已删）
> **备注**：React-Ink TUI 曾短期落地，后随 observability 重写整体移除；本 plan 的重构目标随之失效

## Context

`src/tui/app.tsx`（511 行单文件 React-Ink 应用，`ink@6.3.1` + `react@19.2.0`，经 `startTui()` 启动，轮询 `/api/status` + `/history/api/entries?limit=20`）当前有三个真实 bug + 视觉朴素：

1. **token 显示丢失 cache（核心）**：`formatTokens`（app.tsx:84-90）只输出 `${input} in / ${output} out`，完全忽略 `cache_read_input_tokens` / `cache_creation_input_tokens`。三处调用（224/324/363）都走它，修一处全修。
2. **类型用错**：`formatTokens(entry: HistoryEntry)` 访问 `entry.usage`，但 `HistoryEntry`（types.ts:126）**没有 usage 字段**——接口实际返回的是 `EntrySummary`（types.ts:425，含顶层 `usage` + `durationMs`/`multiplier`/`previewText` 等丰富字段）。运行时能 work 纯属侥幸，类型层是错的。
3. **StatusResponse 字段名错**：app.tsx 的 `StatusResponse` 定义 `{copilotToken, githubToken, models}` 三个 bool，但实测 `/api/status` 返回的是 `account.hasCopilotToken` / `models.count` / `requests.active` / `history.total`——字段名对不上，status bar 大概率一直显示红 x。

已与用户确认的方向：
- **视觉**：保持 request log line 单行风格（**不**改成表格/仪表盘），每行 = 一条请求的紧凑 log line；重点是 token 的 **↑（input 方向）双色**——fresh input 与 cache 分色。
- **cache 价格语义靠分色体现**（与 console sink 的 format.ts 一致）：fresh input 默认色（全价 1×）、cache_read 暗色 `dimColor`（命中 ≈0.1× 便宜）、cache_creation 青色 `cyan`（写入 ≈1.25× 略贵）、output 默认色。
- **拆多文件 + 组件**。

后端 history/status 接口已实现，usage 四字段（`EntrySummary.usage`，types.ts:449-453）完整，**不改后端**。

## 目标文件结构

```
src/tui/
  app.tsx                    入口 startTui + App 容器（轮询 status/history、useInput 键盘、布局组装）
  format.ts                  纯函数 + 类型（可 bun test，无 ink 依赖）
  components/
    StatusBar.tsx            状态栏（对齐真实 /api/status 字段）
    RequestRow.tsx           单行 log-line（含 ↑双色 token），RequestList 渲染每条
    TokenUsage.tsx           token 分色渲染组件（↑fresh +cacheRead<dim> +cacheCreation<cyan> ↓out），列表行 + detail 共用
    DetailPanel.tsx          选中项详情（分类 token + 命中率 + duration + multiplier）
```

## 改动要点

**`src/tui/format.ts`（新，纯函数可测）**
- 从 `~/lib/history/store` import **`EntrySummary`**（取代 `HistoryEntry`），及 `StatusResponse` 对齐 `/api/status` 真实结构（`account.hasCopilotToken`/`hasGithubToken`、`models.count`、`requests.active`/`queued`、`history.total`/`diskBytes`）。
- `formatTime(startedAt)`、`formatState(state)`、`formatModel(model)`（padEnd 对齐，复用 app.tsx:425 `formatRowFull` 的思路）。
- `cacheHitRate(usage)`：`cache_read / (cache_read + cache_creation + input)`（沿用本会话诊断口径），返回比率 + 标志（如大 fresh input 异常）。
- `tokenParts(usage)`：返回结构化分段 `{ input, cacheRead, cacheCreation, output }`（供 TokenUsage 组件分色渲染；纯数据，不含颜色——便于单测）。

**`src/tui/components/TokenUsage.tsx`（新，核心 cache 双色）**
- 入参 `usage`，渲染相邻 `<Text>`：`↑{input}`（默认）`+{cacheRead}`（`dimColor`）`+{cacheCreation}`（`color="cyan"`）`↓{output}`（默认）。缺失段省略（对齐 console format.ts:64-71 的 `if (cacheRead)` 语义）。这是「↑双色」落点。

**`src/tui/components/RequestRow.tsx` + RequestList**
- 单行 log-line：`{time} {status} {model} <TokenUsage/>`，selected 行 `>` 前缀 + 高亮。取代 app.tsx 的 `formatRow`（71-77，`${status} ${model}` 太简）。

**`src/tui/components/StatusBar.tsx`**
- 用真实字段渲染：Copilot/GitHub ●（`account.hasCopilotToken`）、`models.count`、`requests.active`、`history.total`。可附全局 cache 命中率（聚合 entries 或读 `/api/status` 的 requestTelemetry model 维度）。

**`src/tui/components/DetailPanel.tsx`**
- 选中 entry 的分类 token（Input fresh / CacheR hit / CacheW / Output）、`cacheHitRate`、`durationMs`、`multiplier`。取代 app.tsx 内联 detail（230-375）。

**`src/tui/app.tsx`（瘦身为容器）**
- 保留 `usePolledData`、`useInput`(↑↓/q)、`useStdout`、`startTui`/`import.meta.main`。`history` 泛型改 `EntrySummary`。组装 StatusBar + RequestList + DetailPanel。删除内联 format/重复渲染。

## 测试

- **`tests/tui/format.unit.test.ts`（bun，主力）**：`cacheHitRate`（命中/全 fresh/无 cache）、`tokenParts` 分段、`StatusResponse` 字段映射、`formatTime`/`formatState`。纯函数，不依赖 ink。
- **组件渲染（可选）**：装 `ink-testing-library`（dev，纯 JS、Bun 兼容；`bun add -d ink-testing-library`）后加 `tests/tui/token-usage.test.tsx` 等，断言 `<TokenUsage>` 渲染含 fresh/cacheRead/cacheCreation 各段且着色（ANSI）、缺失段省略；`<StatusBar>` 用真实字段。若不装，则核心 cache 逻辑由 format.ts 纯函数测试覆盖（双色仅靠组件结构保证）。

## 验证

- `bun run typecheck`（确认 `EntrySummary`/`StatusResponse` 类型修正后无错）。
- `bun test tests/tui/`。
- 不启动服务器 / 不碰生产 4141（全程只读探测已完成）。需肉眼看实际 TUI 渲染时，由用户本地跑 `startTui()` 观察列表行出现 `↑<fresh> +<cacheRead暗> +<cacheCreation青> ↓<out>` 与修复后的 status bar。

## 范围外（记录备查）

- console sink（`src/lib/observability/sinks/console.ts`）的 `onTerminal` 同样不显示 token（本会话最初发现），是另一个 TUI（server stdout 日志），本次聚焦 src/tui ink 应用，未一并处理——若需可另开。
- dashboard/telemetry 的 cost 对所有 token 统一乘 model multiplier（不应用 Anthropic cache 倍率），premium-request 语境下的有意选择，不动。
