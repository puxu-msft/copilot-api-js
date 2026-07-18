# TUI Live Footer：宽度感知 + 按模型分组 + 穷尽性守卫

> **实施状态（2026-07-10）：已实施 + 已通过评审，待提交。** 三处改动全部落地：① `format.ts` 新增 `truncateToWidth`；② `console.ts` 的 `getColumns`/`finalizeFooter` 单一收口 + `buildFooter` 按模型分组 + 宽度驱动纳入；③ `renderFeatureTag` 穷尽守卫。新测试 `console-footer.unit.test.ts` + `format.unit.test.ts` 全绿、连跑确定。两轮 plan 评审达 consensus，1 轮 code review 无 BLOCK/MAJOR（仅修一处注释失真 + 收紧一处断言）。推迟四项记入 `docs/todo/deferred-backlog.md`。活现状见 `docs/DESIGN.md`「Console UI」节。
>
> **历史验收备注（已取代）：** 2026-07-10 曾要求用户在窄终端人工确认；2026-07-18 起由下述自动 PTY 水平 oracle 取代。

> **后续演进（2026-07-18）：** 本计划保留 2026-07-10 的历史落地形态；当前宽度原语已从 `observability/projections/format.ts` 迁到 `tui/render/width.ts`，由 grapheme-aware 单测 + Bun.Terminal/xterm 水平 PTY oracle 自动验收，不再依赖人工窄终端验证。权威现状见 [TUI PTY spec](../spec/2026-07-14-tui-pty-terminal-grid-testing.md)。

## Context（为什么做）

TUI 的「live query」信息由 [console.ts](src/lib/observability/sinks/console.ts) 的 `ConsoleSink` 渲染：底部一条 `[<-->]` footer 显示在途请求，配合逐条 `[ OK ]/[FAIL]/[RETRY]` log line。

清行只用 `CLEAR_LINE = "\x1b[2K\r"`（[console.ts:42](src/lib/observability/sinks/console.ts#L42)），**只清一条物理行**。但 footer 是任意长的单字符串——终端把超宽内容软换行成 2+ 物理行，下一次 `CLEAR_LINE` 只清最后一行，上半截 footer **滚进日志区变残影**。窄终端 + 多并发请求必现。根因：渲染器隐含假设「一次写 = 恰好一物理行」，而 footer 宽度完全不受控。

用户诉求：**footer 要感知行宽**；且**多请求时按模型分组**（比逐条列举更紧凑，天然契合宽度收敛）。经确认，范围**仅收敛 footer**——历史 log line 保持自然换行、信息零丢失。

预期结果：footer 恒为 **1 物理行**（截断到 `columns-1`），永不留残影；多请求按模型聚合、宽度驱动纳入组数（宽屏多、窄屏收进 `+K more`）。

## 硬不变量

- **footer 恒 ≤ 1 物理行**：任意 `columns`、任意并发数、任意 model 名/path **内容**（含内嵌换行/控制字符）下，footer 单次渲染的物理行数恒为 1——由「截断到 `stringWidth ≤ columns-1` + 先 strip 控制字符」在**单一收口处**结构性保证，非靠调用纪律。
- **log line 不动**：`formatLogLine` 与 `printLog` 的 `message + "\n"` 原样，长行照旧软换行、信息零丢失。
- **非 TTY 零行为变化**：`renderFooter` 已在 `!isTTY` 早返回，非 TTY 下 footer 代码不产字节。

## 依赖（实施须实跑，非手改 package.json）

- `bun add string-width@^7.2.0` —— 测宽原语（CJK/emoji/箭头正确计宽）。**必须钉 `@^7.2.0`**：`string-width@7.2.0` 已在 `bun.lock`（经 yargs/cliui 传递），钉版号使其仅**提升为直接依赖、dedupe 无新版本**；裸 `bun add string-width` 会拉 registry 最新 8.2.2 与既有 7.2.0 双版本共存（功能无碍但违「无版本变动」意图）。
- **不引入 `cli-truncate`**（考虑后不采纳 → 见下）。首要理由：footer 内层在最外 `pc.dim` 前是**纯文本**（`formatStreamInfo`/`formatDuration` 无色），无需 cli-truncate 的 ANSI-aware 截断能力；且 cli-truncate 不在 `bun.lock`（是 `bun install` 会 prune 的游离产物、真·新依赖）。手写纯文本截断更轻、天然免疫「切断 ANSI reset」风险。

## 改动（全在 [console.ts](src/lib/observability/sinks/console.ts) + [format.ts](src/lib/observability/projections/format.ts)）

### 1. 宽度感知（承重，消灭残影根因）

- `ConsoleSinkOptions` 增 `columns?: number | (() => number)`（可测；默认运行期读活值 `(this.stdout as any).columns ?? 80`）；新增私有 `getColumns()`。
- `format.ts` 新增纯函数 `truncateToWidth(plain: string, maxCols: number): string`：**按 code point 迭代**（`for (const ch of plain)` / `[...plain]`，绝不用 `.charAt`/索引——否则 surrogate pair emoji 被劈半）；用 `string-width` 逐字累加显示宽度，某字符加入会超预算则**整字排除**并接 `…`（`…` 宽 1、计入 `maxCols` 预算）。退化边界 `maxCols <= 0` 夹取返回 `""`（不返回 `"…"`，守住「≤ maxCols」契约）。仅接**纯文本**（无 ANSI），故无切断转义码之虞。附单元测试（CJK/emoji 宽 2、`…` 预算、短于上限原样、空串、`maxCols<=0→""`）。
- **单一收口**：`buildFooter()` 只负责组装**纯文本内层**（各 return 分支返回未着色串）；新增唯一出口 `finalizeFooter(inner)`：`inner.replace(/[\r\n\t\x00-\x1f]+/g, " ")`（strip 控制字符/换行）→ `truncateToWidth(_, getColumns()-1)` → `pc.dim(_)`。所有分支经此出口，新增分支无法绕过 → 不变量结构性成立。
- resize：**不加监听器**（考虑后不采纳 → 见下）。`renderFooter` 每次读活 `columns` + 100ms timer 活跃期持续重渲，resize 后 ≤100ms 自动重截。

### 2. 多请求按模型分组（新需求）

重写 `buildFooter()` 的 `count > 1` 分支（产出纯文本内层，交 `finalizeFooter`）：

- 按 `entry.ctx.resolvedModel ?? "(resolving)"` 分组（未解析模型落 `(resolving)` 桶）。
- 每组一 segment：`<model> ×N ↓<sumBytes> <maxElapsed>`——`N`=组内数、`sumBytes`=组内 `streamBytesIn` 求和（有流才显）、`maxElapsed`=组内最老请求 elapsed（`formatDuration`）。
- 组按 `N` 降序、再按最老 startTime 升序。
- **宽度驱动纳入**（替代硬编码 `MAX_SHOWN = 3`）：用 `string-width` 实测贪心累加 segment，预留 ` | +K more` 尾巴；放不下的组计入 `+K more`——由 `columns` 决定显示几组。末端 `finalizeFooter` 的截断是安全网兜底（最坏少显 1 组，绝不溢出）。
- `count === 1` 分支保留现状语义（method/path/model/elapsed/stream），同经 `finalizeFooter` 截断。

### 3. `renderFeatureTag` 穷尽性守卫（独立安全修复，与 footer 无关）

- 形参 `feature: string` → `feature: Exclude<FeatureKind, "thinking">`（利用调用点 [console.ts:148](src/lib/observability/sinks/console.ts#L148) 已把 `thinking` 收窄剔除，switch 天然无需 thinking case）。
- 删 `default: return feature`，改 `default: assertNever(feature)`——新增 `FeatureKind` 编译期暴露，杜绝静默泄裸标签。
- **行为等价约束**：以下 8 个当前落 `default: return feature` 的 case 显式 `return feature`（本轮不改渲染语义，detail 富化留 backlog）：`tool-call-recovered` / `refusal-recovered` / `refusal-errored` / `tool-input-decode-failed` / `protect-streaming-retry` / `context-edits-applied` / `tool-input-repaired` / `tool-input-unrepairable`。既有显式 case（truncated / beta-stripped / transport / via-* / dropped-params / stream-*）不动。

### 附：注释声明不变量依赖

`clearFooterForLog`（[console.ts:392](src/lib/observability/sinks/console.ts#L392)）加注释：其单行 `CLEAR_LINE` 正确性依赖「footer 恒 ≤1 物理行」不变量（§改动 1 保证），防未来放开截断致多行 footer 清除失配。

## 考虑后不采纳（record-not-adopted）

- **cli-truncate**：技术审查实测确认其直接截 dim-wrap 串安全、无 off-by-one，但它不在 `bun.lock`（`bun install` 会 prune 的游离产物、真·新依赖）；而 footer 内层是纯文本、无需其 ANSI-aware 截断能力 → 手写纯文本截断更轻更稳。
- **resize 监听**：与 100ms timer 的活值重渲冗余（resize 后 ≤100ms 自愈）；且缩窄时单行 `CLEAR_LINE` 本就清不掉已回流的上行（终端固有限制），监听器给不了这层。删之并消除监听泄漏隐患。
- **footer 重绘去抖（原 fix-6/7）**：footer 是**活的计时指示器**，elapsed 每 tick 推进、串本就该变，字符串相等缓存近乎永不命中；且带 `footerVisible` 谓词耦合易引入「footer 每条 log 后消失」的正确性 bug。每 100ms 重画单行廉价且期望，不做去抖。
- **fix-8 单请求 footer 富化** / **fix-9 外部直写撞 footer** / **renderFeatureTag detail 富化** / **`(resolving)` 桶丢 path 的补偿**：均记 [docs/todo/deferred-backlog.md](docs/todo/deferred-backlog.md)（footer-only 瞬时损失，完成态 log line 补回，可接受）。

## 测试（新建 `tests/observability/console-footer.unit.test.ts`）

现有 console 测试全 `isTTY:false`（footer 早返回），footer 路径**当前零覆盖**。用 `isTTY:true` + 固定 `columns` 的 capture stdout。oracle 一律用 **`stringWidth(stripAnsi(footer))`** 度量（非 `.length`，避免 CJK 低估）。

**时钟确定性（承重）**：footer 恒含 `elapsed = formatDuration(Date.now() - startTime)`，其渲染宽度随时间抖动（`0ms`→`123ms`→`10.5s` 字符数不同）。凡断言**精确宽度**的用例（边界 columns-1/columns、count===1 截断），必须让 elapsed 渲染到已知宽度——固定 `ctx.startTime` 相对一个冻结的 `Date.now()`（Bun `setSystemTime` / 注入时钟），否则 off-by-one 断言 flaky。新用例连跑 ≥10 次确认确定性（empirical-verification 纪律）。

- **width 正样本**：先证不截时 footer 会超宽（`> columns`），再证经渲染后 `stringWidth ≤ columns-1`。
- **边界**（冻结时钟）：内容恰好 `columns-1`（不截）与恰好 `columns`（截 1）——off-by-one 高发处。
- **grouping**：3 请求 2 同 model + 1 异 model → footer 含 `modelA ×2`、`modelB ×1`，无逐条列举。
- **width-driven count**：多组 + 窄宽 → 溢出组进 `+K more`，K 随 `columns` 变（非固定 3）。
- **两极**：全同 model（单 segment 大 N）、全异 model（N 个 `×1` 压 width-driven 溢出）。
- **`(resolving)` 桶**：无 `resolvedModel` 的请求归 `(resolving)`。
- **控制字符**：`resolvedModel`/`path` 含 `\n` → footer 仍单物理行（strip 生效；正样本先证不 strip 时产多行）。
- **count===1 截断**：单请求 + 超长 path/model + 窄宽 → `stringWidth ≤ columns-1`。
- **0 请求**：footer=""、`CLEAR_LINE` 且 `footerVisible→false`。
- **truncateToWidth 单测**：CJK/emoji（宽 2）、`…` 预算、短于上限原样、空串。
- **回归**：跑既有 `tests/observability/console-*.unit.test.ts`、`tests/pipeline/pipeline-retry-tui.unit.test.ts` 确认非 TTY 路径与 log line 字节不变。

命令（非服务器，允许跑）：`bun test tests/observability/ tests/pipeline/pipeline-retry-tui.unit.test.ts`、`bun run typecheck`、`bunx eslint src/lib/observability/sinks/console.ts src/lib/observability/projections/format.ts`（无缓存）。

## 端到端人工验证（需用户启动服务器，no-auto-server）

窄开一终端（如 60 列），并发打 3+ 请求（含同模型≥2），肉眼确认：footer 恒 1 行不留残影、按模型分组显示 `model ×N`、拖窗变窄时 footer ≤100ms 内自动收窄不溢出。

## 收尾

subagent 复审（consensus）→ 实现 → subagent code review → doc-sync（[docs/DESIGN.md](docs/DESIGN.md) 活的架构现状若有 console sink 行则更新；backlog 增条目）→ 细粒度提交（feat: footer 宽度感知+按模型分组；refactor: renderFeatureTag 穷尽守卫）→ 归档本计划到 `docs/plan/`。
