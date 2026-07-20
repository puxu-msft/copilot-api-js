# TUI 交互式只读面板（P1）实现计划

> **实施状态（2026-07-11）：✅ 已实施（8 task 全绿 + 各 task 过审含 opus 集成审查；Reading B 裁决 golden 零 churn）。** 依赖 P0 已 merge。P1 = 只读交互（无破坏性动作，abort/复制在 P2）。四叶子 keys/region/panel/controller + Task5 集成 + Task6 还原 scheme A + Task7 eslint 边界 + Task8 doc。承重接缝（统一 Region 消灭双路径、printLog DECSTBM 分叉、options 注入护 test-isolation、raw-mode Ctrl-C 转发 + exit-hook 还原、attempts[] 富累积、滚动数学同源对齐）均实测过审。**真终端反馈修入**：req_id 显全（`1c23e6f4`）、面板固定高度 3 行消除空行 churn（`cfc4f05e`，+ F3 联合对齐回归测试）。残留打磨（help-toggle 滚动 F1、1↔2↔3 微动 F2）见 `docs/todo/deferred-backlog.md`。**待用户真终端验收（见文末清单）**。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给终端 live query 加**只读交互面板**：折叠分组 footer ↔ 按键展开底部多行逐条表格 ↔ 单条 detail，键盘导航 + 选中高亮 + 选中滚动触达溢出请求。无破坏性动作。

**Architecture:** 把 P0 的单行 footer 模型推广为 **DECSTBM sticky 底部 region**（多行、横×竖双向 clamp、N=1 退化即 footer）。新增 `tui/input/keys.ts`（raw-mode 字节→键事件）、`tui/controller.ts`（键事件→UI 状态机）、`tui/render/{region,panel}.ts`。`TerminalUi` 从启动起常驻 raw mode（TTY 时），Ctrl-C 捕获转发 `handleShutdownSignal`，exit-hook 崩溃还原（scheme A）。

**Tech Stack:** Bun 1.3.14 + TypeScript（ESM、`verbatimModuleSyntax`）、`bun:test`、picocolors、string-width、DECSTBM/ANSI 转义序列（PoC-2 byte 级选定，`exp/tui-rawmode/`）。

## Global Constraints

- **P1 只读**：绝无破坏性动作（abort/复制/清屏改状态都不在 P1）。detail 视图纯呈现 `ActiveRequest` 累积数据。
- **collapsed 走 Region（方案 A，仅在交互实例内；对齐 RFC §4「同一套代码」）**：**交互实例**里 collapsed/panel/detail **统一经 `Region.render(lines)`**——collapsed 即 `lines.length===1`（`buildCollapsedLines` 内容 = `buildActiveFooter` + 可选 dim keybar）。panel→collapsed 是 Region 内 N:多→1 的重锚（DECSTBM 缩到 1 行）、`active.size===0` 走 `region.clear()` 拆 DECSTBM，**一个交互实例内不存在 P0 单行 + DECSTBM 双路径**（消灭 BLOCK-1 接缝）。**非交互实例**（无注入 stdin）全程走 P0 footer 路径、不建 Region——这是**实例级 mode 两分**（构造时定死、终身不变、无接缝），非会话内切换。**golden fixture 不动（Reading B，确认于 2026-07-11 Task5 集成期）**：golden/attach-order/usage 测试不注入 stdin → 非交互 → P0 路径 → 输出**逐字不变**（原计划「golden 有意变更」是 Reading-A 残留，已被 stdin-gate 加固取代）。collapsed↔panel↔collapsed **往返 seam 测试**放**新 `terminal-ui-interactive.unit.test.ts`**（注入 stdin+isTTY），断言收回时 `\x1b[r` 出现——不在 golden。
- **横×竖双向 clamp 是硬不变量**：每行 `truncateToWidth(columns-1)`（复用 `render/footer.ts` 原语）；region 高 = `min(所需, rows-预留)`，溢出显 `+K more below` + 选中滚动可达（RFC §6）。resize 时全清旧位置（`\x1b[2J` 或逐行清 orphan）+ 按新 rows 重设 DECSTBM 重锚（评审 §7：非平凡 orphan 清理）。`active.size===0` 时 region `clear()`（拆 DECSTBM、回归纯日志）。
- **raw mode 全程常驻**（**仅显式交互时**）：门控 `!silent && stdout.isTTY && typeof stdin.setRawMode === "function"`，**且仅当显式注入 `stdin` 选项或 `interactive:true`**才触碰 `process.stdin`（评审 §3：否则真终端跑 `bun test` 会让 golden 等既有测试的 `setRawMode` 打到真实 process.stdin，违反 `test-isolation`）。接管 Ctrl-C（`0x03`→注入的 `onShutdownSignal`，PoC-1 确认）；退出/崩溃/destroy/shutdown 必还原（`setRawMode(false)` + `stdin.removeListener("data")` + `stdin.pause()` + 显光标 + region `clear()` 复位 DECSTBM `\x1b[r`），exit-hook 承重（PoC-4，注入 `registerExitHook`）+ throw 点兜底。
- **`printLog` 统一经 Region 协调**（评审 §2）：交互态 region 独占底部保留区；`printLog` 只 `write(message+"\n")`（光标由上次 `Region.render()` 的 DECRC 停泊在 DECSTBM 滚动区底，日志落上方滚动区），再 `renderRegion()`。**不再 `clearFooterForLog`+`CLEAR_LINE`**（那是 P0 单路径；DECSTBM 下会错清保留区）。`Region.render()` 契约：render 结束后光标**停泊在滚动区最后一行**（DECRC）。非交互态退回 P0 的 `printLog`（无 region）。
- **非 TTY / 非交互降级**：门控不满足则退回 P0 行为（只打日志、无 footer、无输入、无 raw mode），既有 golden/attach-order 测试不注入 stdin → 永不误开 raw mode。
- **单一所有者、render 全同步**：region 临界区 render 绝不 `await`；bus 事件与键盘事件都改同一 UI 状态 + region，由 `TerminalUi` 独占渲染（reentrancy flag 照抄 `republish.ts` 守卫）。
- **ESLint 边界**：`keys/controller/render` 互不 import 内部实现；`setRawMode`/读 stdin **仅** `tui/input/`（P0 已加 tui/ 禁其它 sink 的边界，P1 补这两条 path-group + L1 守卫）。
- commit invariants（每 task 终态绿）；显式 pathspec；conventional commits、不加模型署名；不运行服务器；禁 `require()`。
- **DECSTBM 为 region 默认技术**（PoC-2 byte 级 correct-by-construction 选定；相对光标 fragile 不采纳）。

## File Structure（P1 终态）

```
src/lib/tui/
  terminal-ui.ts        # 改：raw-mode 生命周期 + 接线 keys→controller→region；单行 footer render 换成 region render（collapsed=N=1）
  input/
    keys.ts             # 新：raw-mode 字节流 → 归一化 KeyEvent（转义序列解析）
  controller.ts         # 新：KeyEvent → UiState 迁移（纯函数 reducer）
  render/
    footer.ts           # 不动（buildActiveFooter；region 的 collapsed 内容源）
    syslog.ts           # 不动
    region.ts           # 新：DECSTBM sticky 多行 region 渲染器（光标独占 + 宽×高 clamp + 选中滚动 + resize 重锚）
    panel.ts            # 新：展开逐条表格 + detail 视图串构建（纯函数，入参 active 快照 + UiState）
```

---

### Task 1: `input/keys.ts` —— raw-mode 字节 → 键事件解析

**Files:**
- Create: `src/lib/tui/input/keys.ts`
- Test: `tests/tui/input/keys.unit.test.ts`

**Interfaces:**
- Produces: `type KeyEvent = { kind: "up" | "down" | "enter" | "escape" | "space" | "tab" | "help" | "ctrl-c" | "char"; char?: string }`；`parseKeys(chunk: Buffer): Array<KeyEvent>` —— 纯函数，把一次 stdin data chunk（可能含多字节转义序列或多键）解析成 KeyEvent 数组。识别：`\x1b[A`/`\x1b[B`（↑↓，兼 `k`/`j`）、`\r`/`\n`（enter）、`\x1b`（单独=escape）、`0x20`（space）、`0x09`（tab）、`?`（help）、`0x03`（ctrl-c）、`0x04`（ctrl-d→当 ctrl-c）、其它可打印→`char`。

- [ ] **Step 1: 写 keys 单测**——断言各字节序列→对应 KeyEvent：`Buffer.from([0x1b,0x5b,0x41])`→`[{kind:"up"}]`；`Buffer.from("k")`→`[{kind:"up"}]`；`Buffer.from([0x03])`→`[{kind:"ctrl-c"}]`；`Buffer.from("\r")`→`[{kind:"enter"}]`；`Buffer.from([0x1b])`→`[{kind:"escape"}]`；`Buffer.from(" ")`→`[{kind:"space"}]`；`Buffer.from("?")`→`[{kind:"help"}]`；多键 chunk `Buffer.from("kj")`→`[{kind:"up"},{kind:"down"}]`。正样本 + 边界（空 chunk→`[]`）。

- [ ] **Step 2: 跑证 FAIL**。Run: `bun test tests/tui/input/keys.unit.test.ts` Expected: FAIL（未定义）。

- [ ] **Step 3: 实现 keys.ts**——`parseKeys` 逐字节扫描：遇 `0x1b` 前瞻 `[A/[B` 转义序列（消费 3 字节），孤立 `0x1b`（chunk 末或后续非 `[`）→escape；`0x03`/`0x04`→ctrl-c；`\r`/`\n`→enter；`0x20`→space；`0x09`→tab；`k`/`j`→up/down；`?`→help；其它 `0x20-0x7e`→char。按 code point 安全处理。

- [ ] **Step 4: 跑证 PASS**。Run: `bun test tests/tui/input/keys.unit.test.ts` Expected: PASS。

- [ ] **Step 5: typecheck + lint + commit**。`bun run typecheck` && `bunx eslint src/lib/tui/input/keys.ts`（无缓存）。
```bash
git commit -F <msgfile> -- src/lib/tui/input/keys.ts tests/tui/input/keys.unit.test.ts
# msg: feat(tui): add raw-mode key event parser (input/keys.ts)
```

---

### Task 2: `render/region.ts` —— DECSTBM sticky 多行 region 渲染器（承重）

**Files:**
- Create: `src/lib/tui/render/region.ts`
- Test: `tests/tui/render/region.unit.test.ts`

**Interfaces:**
- Produces: `class Region { constructor(opts: { stdout: NodeJS.WritableStream, getColumns: () => number, getRows: () => number }); render(lines: ReadonlyArray<string>): void; clear(): void; }` —— 独占底部 sticky region 的光标管理。`render(lines)`：把 `lines`（已是各自 ≤columns-1 宽的纯呈现串）绘制为贴底的 N 行 DECSTBM 保留区（首次 render 设滚动区 `\x1b[1;<rows-N>r`）；**契约：render 结束后光标停泊在 DECSTBM 滚动区最后一行（DECRC），供 `printLog` 落点正确**。`clear()`：拆 region、复位 DECSTBM（`\x1b[r`）、还原光标——**任何 `*→collapsed 收回`/`active 清空`/destroy 都必须先 `clear()` 再决定是否重画**（评审 BLOCK-1：转换不复位滚动区 = 接缝 bug）。**竖向 clamp**：`N = min(lines.length, getRows()-预留)`，超出末行显 `+K more below`。**resize 重锚**：render 时若 `getRows()` 变化，先清旧 region 位置的 orphan 行（`\x1b[2J` 或逐行 `\x1b[<oldRow>;1H\x1b[2K`）再按新 rows 重设 DECSTBM（评审 §7：orphan 清理非平凡）。
- Consumes: DECSTBM 序列（`\x1b[<top>;<bottom>r` 设滚动区、`\x1b[<row>;1H` 绝对定位、`\x1b7`/`\x1b8` DECSC/DECRC 存/复位光标、`\x1b[2K` 清行、`\x1b[?25l/h` 藏/显光标），源见 `exp/tui-rawmode/sticky-region-decstbm.ts`（PoC-2 已验）。

- [ ] **Step 1: 写 region 单测**——fake stdout（capture write）+ 固定 columns/rows。断言：`render(["a","b"])` 发出 DECSTBM 设置(`\x1b[1;<rows-N>r`)+ 两行绝对定位写入 + DECSC/DECRC；`render` 后 `getRows` 变小再 render → 按新底重锚（新 DECSTBM 值）；lines 超 `rows-预留` → 末行 `+K more below`、region 高 = clamp 值；`clear()` 发出 `\x1b[r` 复位 + 显光标。正样本：先证不 clamp 时会超 rows、再证 clamp 后 ≤。

- [ ] **Step 2: 跑证 FAIL**。Run: `bun test tests/tui/render/region.unit.test.ts` Expected: FAIL。

- [ ] **Step 3: 实现 region.ts**——移植 `exp/tui-rawmode/sticky-region-decstbm.ts` 的 DECSTBM 逻辑为 class：`render` 计算 `N=min(lines.length, rows-预留)`、设滚动区 `\x1b[1;${rows-N}r`、DECSC → 逐行 `\x1b[${panelTop+i};1H\x1b[2K` + 写第 i 行（第 N 行若溢出写 `+K more below`）→ DECRC；追踪上次 N 以便 rows 变化时重设滚动区；`clear` 发 `\x1b[r\x1b[?25h` 并复位内部状态。**不含业务逻辑**（只画传入的 lines）。

- [ ] **Step 4: 跑证 PASS + 连跑 10 次确定性**。Run: `bun test tests/tui/render/region.unit.test.ts`（×10）Expected: 全 PASS。

- [ ] **Step 5: typecheck + lint + commit**。
```bash
git commit -F <msgfile> -- src/lib/tui/render/region.ts tests/tui/render/region.unit.test.ts
# msg: feat(tui): add DECSTBM sticky multi-line region renderer
```

---

### Task 3: `render/panel.ts` —— 展开表格 + detail 视图串构建

**Files:**
- Create: `src/lib/tui/render/panel.ts`
- Test: `tests/tui/render/panel.unit.test.ts`

**Interfaces:**
- Produces: `buildCollapsedLines(args: { active, now, columns, showHelp }): Array<string>` —— collapsed 态单行：`buildActiveFooter(...)` 内容 + 可选 dim keybar 提示（`showHelp` 或默认极简 ` · space: expand`，RFC §5 可发现性）；返回**单元素数组**（Region N=1）。`buildPanelLines(args: { active: ReadonlyArray<ActiveRequestView>, now, columns, selectedIndex, scrollOffset, rows, showHelp }): Array<string>` —— 逐条表格行（req_id 短形 / model / method+path 截断 / elapsed / ↑req↓resp bytes / events / tags 摘要），选中行反色（`\x1b[7m...\x1b[27m`），每行 `truncateToWidth(columns-1)`，按 `scrollOffset` 取可见窗口，`showHelp` 时末行加 dim keybar（`↑↓ nav · enter detail · esc back · q quit`）。`buildDetailLines(args: { entry: DetailView, now, columns }): Array<string>` —— 单条全 ctx 快照多行（req_id/method+path/client→resolved model/multiplier/state/elapsed/queueWait/↑↓bytes/events/blockType/tags/thinking requested→effective/**attempts 明细**），各行截断。
- Consumes: `truncateToWidth`/`formatDuration`/`formatBytes`（projections/format）、`ActiveRequestView`（扩展含 tags/thinking/attemptCount，来自 terminal-ui 的 `ActiveRequest`）、`pc`。
- **`DetailView` 富数据（评审 §5，richest-data-flow）**：detail 要显 per-attempt 明细，但 P0 `ActiveRequest` 只累积 `attemptCount`（一个数）。**P1 在 `ActiveRequest` 累积 `attempts: Array<AttemptSnapshot>`**（Task 5 从 `request.attempt_started`/`attempt_failed` 事件累积，`AttemptSnapshot` 见 `events.ts:106`），`buildDetailLines` 消费完整 attempts[]（每 attempt 的 strategy/error/waitMs）。不做「只显 attemptCount」的静默收窄。

- [ ] **Step 1: 写 panel 单测**——冻结时钟 + 固定 columns/rows。断言：`buildPanelLines` 每行 `stringWidth ≤ columns-1`；`selectedIndex` 行含反色码；`scrollOffset` 取窗口正确（选中在窗口内）；超长 path 截断。`buildDetailLines` 含 req_id/model/thinking `requested→effective` 等字段、各行截断。正样本先证不截会超宽。

- [ ] **Step 2: 跑证 FAIL**。Run: `bun test tests/tui/render/panel.unit.test.ts` Expected: FAIL。

- [ ] **Step 3: 实现 panel.ts**——两个纯函数，复用 footer.ts 的截断原语；选中行反色；detail 逐字段成行。`ActiveRequestView` 若需扩展字段，在 footer.ts 的类型上加可选字段（tags/thinking/attemptCount）或新定义 `DetailView`。

- [ ] **Step 4: 跑证 PASS**。Run: `bun test tests/tui/render/panel.unit.test.ts` Expected: PASS。

- [ ] **Step 5: typecheck + lint + commit**。
```bash
git commit -F <msgfile> -- src/lib/tui/render/panel.ts tests/tui/render/panel.unit.test.ts
# msg: feat(tui): add expanded panel + detail view builders
```

---

### Task 4: `controller.ts` —— UI 状态机（纯 reducer）

**Files:**
- Create: `src/lib/tui/controller.ts`
- Test: `tests/tui/controller.unit.test.ts`

**Interfaces:**
- Produces: `type UiState = { view: "collapsed" | "panel" | "detail"; selectedIndex: number; scrollOffset: number; showHelp: boolean }`；`INITIAL_UI_STATE: UiState`；`reduce(state: UiState, key: KeyEvent, ctx: { activeCount: number, visibleRows: number }): UiState` —— 纯函数状态机。规则：`collapsed` + `space`/`tab`→`panel`；`panel` + `up`/`down`→移 `selectedIndex`（clamp `[0,activeCount-1]` + 调 `scrollOffset` 使选中进可见窗口，RFC §6 溢出滚动）；`panel` + `enter`→`detail`；`panel`/`detail` + `escape`→逐级返回（detail→panel→collapsed）；`panel`/`collapsed` + `space`/`tab`→切；`help`（`?`）→翻转 `showHelp`。**P1 无破坏性**：`x`/`c`/`char` 在 P1 忽略（不 abort/不复制，留 P2；reduce 返回原 state）。`ctrl-c` 不在 reduce 里（terminal-ui 直接转发关闭）。

- [ ] **Step 1: 写 controller 单测**——断言状态迁移：collapsed→(space)→panel；panel selectedIndex 随 up/down 移动 + clamp 边界（0 不再减、activeCount-1 不再加）；选中移出可见窗口 → scrollOffset 跟随（选 activeCount-1 时窗口滚到底）；panel→(enter)→detail；detail→(escape)→panel→(escape)→collapsed；P1 中 `x`/`c` 是 no-op（状态不变）。纯函数、无 IO。

- [ ] **Step 2: 跑证 FAIL**。Run: `bun test tests/tui/controller.unit.test.ts` Expected: FAIL。

- [ ] **Step 3: 实现 controller.ts**——`reduce` switch on `state.view` × `key.kind`，返回新 state（不可变）。selectedIndex/scrollOffset clamp 逻辑：选中移动后若 `selectedIndex < scrollOffset` 则 `scrollOffset = selectedIndex`，若 `≥ scrollOffset + visibleRows` 则 `scrollOffset = selectedIndex - visibleRows + 1`。

- [ ] **Step 4: 跑证 PASS**。Run: `bun test tests/tui/controller.unit.test.ts` Expected: PASS。

- [ ] **Step 5: typecheck + lint + commit**。
```bash
git commit -F <msgfile> -- src/lib/tui/controller.ts tests/tui/controller.unit.test.ts
# msg: feat(tui): add read-only UI state machine (controller reducer)
```

---

### Task 5: `terminal-ui.ts` 集成 —— raw-mode 生命周期 + region 渲染 + 接线

本 task 把 Task 1-4 接进 `TerminalUi`，是 P1 的集成核心。**collapsed 态输出须与 P0 逐字等价**（golden 复跑）。

**Files:**
- Modify: `src/lib/tui/terminal-ui.ts`
- Test: `tests/tui/terminal-ui-interactive.unit.test.ts`（新增交互集成测试）+ 既有 `tests/tui/golden-fixture.unit.test.ts`（collapsed 经 Region 后的**有意更新**）

**Interfaces:**
- Consumes: `parseKeys`（Task1）、`Region`（Task2）、`buildCollapsedLines`/`buildPanelLines`/`buildDetailLines`（Task3）、`reduce`/`UiState`/`INITIAL_UI_STATE`（Task4）。
- Produces: `TerminalUiOptions` **新增字段**（评审 §3/§6，依赖注入 + 隔离）：`stdin?: NodeJS.ReadStream`（默认 `process.stdin`）、`rows?: number | (() => number)`（默认读 stdout 活 `rows`，fallback 24；Region 需要）、`onShutdownSignal?: (sig: string) => void`（默认 `handleShutdownSignal`）、`registerExitHook?: (fn: () => void) => void`（默认 `process.on("exit", fn)`）。`attachTerminalUi` 透传这些。`ActiveRequest` 新增 `attempts: Array<AttemptSnapshot>` 累积（评审 §5）。

- [ ] **Step 1: 写交互集成测试**——fake stdin（`EventEmitter` 子类，可 `emit("data", Buffer)` + 有 `setRawMode`/`resume`/`pause`/`removeListener` spy）+ fake stdout（capture）+ `isTTY:true` + 注入 `rows`/`columns`/`onShutdownSignal`(spy)/`registerExitHook`(捕获 fn) + 冻结时钟。断言：① 构造时 `stdin.setRawMode(true)` 被调（**仅当注入 stdin**）；② 喂 `space` + 有活跃请求 → region 渲染 panel（含逐条行 + DECSTBM `\x1b[1;Nr`）；③ 喂 `down` 移动选中（反色行变）；④ 喂 `enter`→detail；⑤ 喂 `escape` 逐级回 collapsed，**收回时发 `region.clear()` 的 `\x1b[r`**（seam 断言，评审 BLOCK-1）；⑥ 喂 `ctrl-c`(`0x03`)→注入的 `onShutdownSignal("SIGINT")` 被调；⑦ `destroy()`→`setRawMode(false)` + `stdin.removeListener("data")` + `stdin.pause()` + `region.clear()`；⑧ **不注入 stdin**（模拟既有 golden/attach-order 测试）→ 不触碰 `process.stdin`、不设 raw mode、退回 P0 日志路径。

- [ ] **Step 2: 跑证 FAIL**。Run: `bun test tests/tui/terminal-ui-interactive.unit.test.ts` Expected: FAIL。

- [ ] **Step 3: 实现集成**：
  - **门控**：`interactive = !silent && stdout.isTTY && typeof stdin.setRawMode === "function"`，**且仅当 options 显式给了 `stdin`**（或未来 `interactive:true`）才读它——否则不触碰 `process.stdin`（评审 §3：既有测试不注入 → 永不误开 raw mode）。生产 attach 时 start.ts 显式传 `process.stdin`。
  - 构造时若 `interactive`：`stdin.setRawMode(true)`、`stdin.resume()`、存 `this.onData = chunk => this.onInput(chunk)`、`stdin.on("data", this.onData)`、藏光标 `\x1b[?25l`、`registerExitHook(() => this.restoreTerminal())`（PoC-4 承重）；新建 `this.region = new Region({ stdout, getColumns, getRows })`。
  - `onInput(chunk)`：`parseKeys(chunk)` → 逐 key：`ctrl-c`→`this.onShutdownSignal("SIGINT")`；其它→`this.uiState = reduce(this.uiState, key, {activeCount: this.active.size, visibleRows: this.getRows()-预留})` → `this.renderRegion()`。
  - `renderRegion()`（**统一入口**，取代 P0 `renderFooter`）：按 `uiState.view` 组 lines——`collapsed`→`buildCollapsedLines(...)`（N=1）；`panel`→`buildPanelLines(...)`；`detail`→`buildDetailLines(选中 entry, ...)`；空 lines（`active.size===0` 且 collapsed）→ `this.region.clear()`（拆 DECSTBM 回归纯日志）；否则 `this.region.render(lines)`。100ms timer + bus 事件 + onInput 都调 `renderRegion`。**render 全同步 + reentrancy flag**（照抄 `republish.ts`）。**统一 Region 路径消灭双路径接缝**（评审 BLOCK-1）；collapsed↔panel↔detail 转换由 `Region.render`/`clear` 内部管 DECSTBM 设/拆。
  - **`printLog` 分叉**（评审 §2）：`interactive` 态——`this.region` 独占底部，`printLog` **只** `write(message+"\n")`（光标由上次 `Region.render()` DECRC 停泊在滚动区底、日志落上方滚动区），再 `renderRegion()`；**不用** P0 的 `clearFooterForLog`+`CLEAR_LINE`（DECSTBM 下会错清保留区）。非 `interactive` 态走 P0 原 `printLog`（无 region）。
  - **attempts 累积**（评审 §5）：`request.attempt_started`/`attempt_failed` 事件里往 `entry.attempts` push `AttemptSnapshot`（供 detail 富显）。
  - `restoreTerminal()`（**幂等**）：`if (!interactive || restored) return; restored=true;` `stdin.removeListener("data", this.onData)` + `stdin.pause()` + `setRawMode(false)` + `this.region.clear()`（`\x1b[r` + 显光标 `\x1b[?25h`）。`destroy()` 调它。

- [ ] **Step 4: 全回归 + golden 有意更新**。先跑 `bun test tests/tui/golden-fixture.unit.test.ts` 看 collapsed 经 Region 后的新输出，**确认视觉等效**（单行 region 与 P0 footer 观感一致）后更新 `console-golden.txt` 为有意变更（commit message 说明）。再 `bun run typecheck` && `bun test tests/tui/ tests/observability/ tests/pipeline/pipeline-retry-tui.unit.test.ts` Expected: 全 PASS。

- [ ] **Step 5: lint + commit**。
```bash
git commit -F <msgfile> -- src/lib/tui/terminal-ui.ts tests/tui/terminal-ui-interactive.unit.test.ts tests/tui/__fixtures__/console-golden.txt tests/tui/golden-fixture.unit.test.ts
# msg: feat(tui): wire raw-mode input + unified region rendering into TerminalUi (P1)
```

---

### Task 6: 终端还原鲁棒性（exit-hook + throw 兜底 + shutdown scheme A）

Task 5 已接 exit-hook + destroy detach；本 task 补**崩溃/退出/shutdown 各路径的还原鲁棒性**（评审 §4：从 Task5 抽出，让 Task5 专注输入接线）。

**Files:**
- Modify: `src/lib/tui/terminal-ui.ts`、`src/main.ts`（若 throw 兜底需在 uncaughtException 前还原）
- Test: `tests/tui/terminal-restore.unit.test.ts`

**Interfaces:**
- Produces: 无新公开 API；`restoreTerminal` 覆盖 exit-hook / destroy / shutdown-drain / throw 四路径，幂等。

- [ ] **Step 1: 写还原测试**——① exit-hook：触发注入的 exit fn → `restoreTerminal` 调（setRawMode(false) + removeListener + region clear）；② scheme A：发 `system.shutdown_phase_changed{phase:"draining"}` → `restoreTerminal()` + 停 region 渲染（后续 Ctrl-C 回归真 SIGINT 走既有 phase 升级）；③ 幂等：连调 restoreTerminal 两次只还原一次；④ 非 interactive → restoreTerminal no-op。

- [ ] **Step 2: 跑证 FAIL**。

- [ ] **Step 3: 实现**——① 订 `system.shutdown_phase_changed`：`draining` 起调 `restoreTerminal()` + 置 `this.shuttingDown=true`（`renderRegion` 此后 no-op，drain 期回归纯日志流，scheme A，RFC §7）；② throw 兜底：确认 `main.ts` 的 `uncaughtException` handler 在 `process.exit(1)` 前，exit-hook 会触发还原（PoC-4 已证 Bun 同步 flush）——若需更早，可在 uncaughtException handler 里先调还原（评审建议 belt-and-suspenders）；③ 文档化 SIGKILL 不可拦截窗口 + Ctrl-Z(SIGTSTP) raw mode 下失效（Task 7 doc）。

- [ ] **Step 4: 全回归**。Run: `bun test tests/tui/` && `bun run typecheck` Expected: 绿。

- [ ] **Step 5: commit**。
```bash
git commit -F <msgfile> -- src/lib/tui/terminal-ui.ts tests/tui/terminal-restore.unit.test.ts
# msg: feat(tui): robust terminal restore across exit/crash/shutdown (scheme A)
```

---

### Task 7: ESLint 边界 + L1 守卫（P1 层）

**Files:**
- Modify: `eslint.config.js`、`tests/tui/layer-boundaries.unit.test.ts`

- [ ] **Step 1: 写/改边界测试**——L1 守卫：`setRawMode`/`process.stdin` **仅** `tui/input/` 允许（放开 P0 的「tui 无 setRawMode」断言，改为「只有 input/ 有」+ 正样本自证）；`keys/controller/render` 互不 import 内部实现。

- [ ] **Step 2: 实现**——`eslint.config.js` 的 tui/ 块补 path-group：`tui/render/**` 禁 import `tui/input`/`tui/controller`（渲染不依赖输入）；`tui/input/**` 禁 import `tui/render`/`tui/controller`；`setRawMode`/`process.stdin` 仅 `tui/input/**`（`no-restricted-syntax` 或靠 L1 守卫）。改 L1 守卫断言。

- [ ] **Step 3: 全 lint + 守卫**。Run: `bun test tests/tui/layer-boundaries.unit.test.ts` && `bunx eslint src/lib/tui/ --no-cache` Expected: 绿（tui/ 净、边界不误伤）。

- [ ] **Step 4: commit**。
```bash
git commit -F <msgfile> -- eslint.config.js tests/tui/layer-boundaries.unit.test.ts
# msg: chore(tui): P1 eslint boundaries (input isolation) + L1 guard update
```

---

### Task 8: P1 收尾 —— doc-sync + 人工验收清单

**Files:**
- Modify: `docs/DESIGN.md`（Console UI 节补交互面板）、`docs/rfc/2026-07-10-interactive-tui-live-panel.md`（P1 标已实施）、本计划头部状态、`docs/todo/deferred-backlog.md`

- [ ] **Step 1: 全套件回归**。Run: `bun test tests/tui/ tests/observability/` && `bun run typecheck` Expected: 绿。
- [ ] **Step 2: doc-sync**——DESIGN.md「Console UI」补：折叠/展开/detail 三态 + 键位（含 `?` help、`q`/Ctrl-C 退出）+ DECSTBM region + **raw mode 下 Ctrl-Z(SIGTSTP) 失效 + SIGKILL 不可拦截窗口**（评审 §7）；RFC P1 标「已实施」；backlog 记 P1 期发现的暂缓项（如 P2 才做的 abort/复制）；跨文档 grep 验证。
- [ ] **Step 3: 人工验收清单**（写进本计划末，交用户真终端跑）：窄/宽终端 × 多请求，验展开/导航/detail/**溢出滚动选中可达**/resize 不破屏无 orphan/Ctrl-C 能停/**退出终端还原（光标可见、echo 正常）**/collapsed↔panel 往返不留 DECSTBM 残留。**这些 pty 证不了、须真人**（呼应 RFC Q2 残留 + Q3 剪贴板留 P2）。
- [ ] **Step 4: commit**。
```bash
git commit -F <msgfile> -- docs/DESIGN.md docs/rfc/2026-07-10-interactive-tui-live-panel.md docs/plan/2026-07-11-tui-interactive-panel-p1.md
# msg: docs(tui): sync DESIGN/RFC for P1 interactive panel + verification checklist
```

---

## Self-Review

- **Spec 覆盖**：RFC §4（region→Task2）、§5（交互/键位/detail/help→Task1/3/4/5）、§6（溢出滚动→Task3/4）、§7（Ctrl-C/还原/scheme A/非 TTY/SIGTSTP/SIGKILL→Task5/6/8）、§8（keys/controller/render 分层 + ESLint→Task1-7）全映射。P2（abort/复制/user-abort provenance/drain 期渲染）**明确排除**。
- **占位符扫描**：无 TBD；各 Task 有具体接口签名 + 测试断言。
- **类型一致**：`KeyEvent`（T1）、`Region`（T2）、`buildCollapsedLines`/`buildPanelLines`/`buildDetailLines`（T3）、`UiState`/`reduce`（T4）、`TerminalUiOptions` 新字段 + `ActiveRequest.attempts`（T5）跨 task 引用名一致。
- **承重接缝已规格化（吸收评审）**：BLOCK-1 collapsed 统一走 Region（消灭双路径 + golden 有意更新 + seam 测试）；§2 printLog 分叉 + Region 光标停泊契约 + DECSTBM 设拆绑 view 转换；§3/§6 options 枚举 stdin/rows/onShutdownSignal/registerExitHook + gate 仅显式注入才碰 process.stdin + destroy detach 监听器；§5 attempts[] 富累积；§7 collapsed keybar（golden 有意变更后可加）+ resize orphan 清理 + SIGTSTP/SIGKILL 文档化。
- **等价 oracle 校准（`large-refactor` §7）**：golden 不再是「字节等价」而是「collapsed 视觉等效」的有意更新 + 新增 collapsed↔panel 往返 seam 测试（补 P0 golden 对交互转换的盲区）。

## Execution Handoff

见会话——P1 建议 subagent-driven 执行（同 P0）。Task2（DECSTBM region）+ Task5（集成）是承重、须仔细审。**强烈建议实施 Task2 前用户先真终端跑 Q2 视觉复验**（`bun exp/tui-rawmode/sticky-region-decstbm.ts`）确认 DECSTBM 观感 + collapsed 单行 region 视觉 OK——虽 byte 级已选定，视觉是 pty 盲区、也是 golden 有意更新的前提。

---

## 用户真终端验收清单（pty 盲区，须真人）

P1 全绿 + 逐 task 过审，但以下是 pty 证不了、须在真终端跑 `bun run start`（或你的启动方式，交互面板仅在真 TTY + stdin 下激活）观察的项。逐项打勾：

- [ ] **展开/收回**：`space`/`Tab` 折叠 footer ↔ 展开面板，无残影、无破屏。
- [ ] **导航 + 选中**：`↑↓`/`k`/`j` 移动，选中行反色高亮跟随。
- [ ] **detail**：`enter` 进单条详情（req_id 全 / model / attempts 明细），`esc` 逐级返回。
- [ ] **面板固定高度**：在途 >3 时面板恒 3 行、`↑K ↓M more` 双向指示，上下键滚动能触达所有在途请求。
- [ ] **空行 churn 已消除**：在途请求数量大幅变动（如并发涌入/退去）时，面板与日志之间**不再冒空行**（本轮根因修复的验收）。
- [ ] **req_id 显全**：面板逐条行的 req_id 完整（如 `req_1783706112773_1180`）、非 `req_1783` 前缀。
- [ ] **resize**：拖动终端改大小，面板贴底重锚、不破屏、无 orphan 行。
- [ ] **Ctrl-C 能停**：raw mode 下按 `Ctrl-C` 服务器优雅关闭（不卡死）。
- [ ] **退出还原**：退出后终端正常——光标可见、echo 正常、可正常打字。
- [ ] **崩溃还原**（可选）：若遇崩溃，退出后终端仍还原（exit-hook）。

**已知残留（非阻塞，见 backlog）**：① 按 `?` 开 help 时选中行可能瞬时脱窗、下次导航自愈；② 在途在 1↔2↔3 之间小幅变时面板高度仍会微动一下（大摆幅已消除）。若这两项实测困扰，告知即修。

**P2 待做**（本清单不含）：`x` abort 在途请求、`c` 复制 req_id（OSC52）。
