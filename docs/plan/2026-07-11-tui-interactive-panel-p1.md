# TUI 交互式只读面板（P1）实现计划

> **实施状态（2026-07-11）：待实施（待 subagent 审 + 用户确认；Q2 真终端视觉复验建议先做但不阻塞）。** 依赖 P0 已 merge。P1 = 只读交互（无破坏性动作，abort/复制在 P2）。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给终端 live query 加**只读交互面板**：折叠分组 footer ↔ 按键展开底部多行逐条表格 ↔ 单条 detail，键盘导航 + 选中高亮 + 选中滚动触达溢出请求。无破坏性动作。

**Architecture:** 把 P0 的单行 footer 模型推广为 **DECSTBM sticky 底部 region**（多行、横×竖双向 clamp、N=1 退化即 footer）。新增 `tui/input/keys.ts`（raw-mode 字节→键事件）、`tui/controller.ts`（键事件→UI 状态机）、`tui/render/{region,panel}.ts`。`TerminalUi` 从启动起常驻 raw mode（TTY 时），Ctrl-C 捕获转发 `handleShutdownSignal`，exit-hook 崩溃还原（scheme A）。

**Tech Stack:** Bun 1.3.14 + TypeScript（ESM、`verbatimModuleSyntax`）、`bun:test`、picocolors、string-width、DECSTBM/ANSI 转义序列（PoC-2 byte 级选定，`exp/tui-rawmode/`）。

## Global Constraints

- **P1 只读**：绝无破坏性动作（abort/复制/清屏改状态都不在 P1）。detail 视图纯呈现 `ActiveRequest` 累积数据。
- **横×竖双向 clamp 是硬不变量**：每行 `truncateToWidth(columns-1)`（复用 `render/footer.ts` 已有原语）；region 高 = `min(所需, rows-预留)`，溢出显 `+K more below` + 选中滚动可达（RFC §6）。region 渲染任何情况不破屏。
- **折叠 footer 行为等价**：`collapsed` 态输出与 P0 footer **逐字相同**（golden-fixture `tests/tui/__fixtures__/console-golden.txt` 复跑不变）——P1 只在**展开时**改变输出，非 TTY / 未展开路径零变化。
- **raw mode 全程常驻**（TTY 时从构造起）：接管 Ctrl-C（`0x03`→`handleShutdownSignal("SIGINT")`，PoC-1 确认）；退出/崩溃/destroy 必还原终端（`setRawMode(false)` + 显光标 + 拆 region + DECSTBM 复位 `\x1b[r`），exit-hook 承重（PoC-4 确认 Bun 同步 flush 有效）+ throw 点兜底。
- **非 TTY 降级**：`typeof stdin.setRawMode==="function" && stdout.isTTY` 才启用交互；否则退回 P0 行为（只打日志、无 footer、无输入）。
- **单一所有者、render 全同步**：region 临界区 render 绝不 `await`；bus 事件与键盘事件都改同一 UI 状态 + region，由 `TerminalUi` 独占渲染（reentrancy flag 照抄 `republish.ts` 守卫）。
- **ESLint 边界**：`keys/controller/render` 互不 import 内部实现；`setRawMode`/读 stdin **仅** `tui/input/`（P0 已加 tui/ 禁其它 sink 的边界，P1 补这两条 path-group + L1 守卫）。
- commit invariants（每 task 终态绿 + golden 绿）；显式 pathspec；conventional commits、不加模型署名；不运行服务器；禁 `require()`。
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
- Produces: `class Region { constructor(opts: { stdout, getColumns: () => number, getRows: () => number }); render(lines: ReadonlyArray<string>): void; clear(): void; }` —— 独占底部 sticky region 的光标管理。`render(lines)`：把 `lines`（已是各自 ≤columns-1 宽的纯呈现串）绘制为贴底的 N 行 DECSTBM 保留区；`clear()`：拆 region、复位 DECSTBM（`\x1b[r`）、还原光标。**竖向 clamp**：`N = min(lines.length, getRows()-预留)`，超出末行显 `+K more below`。resize 时下次 render 读活 rows 重锚。
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
- Produces: `buildPanelLines(args: { active: ReadonlyArray<ActiveRequestView>, now, columns, selectedIndex, scrollOffset, rows }): Array<string>` —— 逐条表格行（req_id 短形 / model / method+path 截断 / elapsed / ↑req↓resp bytes / events / tags 摘要），选中行反色（`\x1b[7m...\x1b[27m`），每行 `truncateToWidth(columns-1)`，按 `scrollOffset` 取可见窗口。`buildDetailLines(args: { entry: ActiveRequestView & 累积字段, now, columns }): Array<string>` —— 单条全 ctx 快照多行（req_id/method+path/client→resolved model/multiplier/state/elapsed/queueWait/↑↓bytes/events/blockType/tags/thinking requested→effective/attempts），各行截断。
- Consumes: `truncateToWidth`/`formatDuration`/`formatBytes`（projections/format）、`ActiveRequestView`（扩展含 tags/thinking/attemptCount，来自 terminal-ui 的 `ActiveRequest`）、`pc`。

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
- Produces: `type UiState = { view: "collapsed" | "panel" | "detail"; selectedIndex: number; scrollOffset: number }`；`INITIAL_UI_STATE: UiState`；`reduce(state: UiState, key: KeyEvent, ctx: { activeCount: number, visibleRows: number }): UiState` —— 纯函数状态机。规则：`collapsed` + `space`/`tab`→`panel`；`panel` + `up`/`down`→移 `selectedIndex`（clamp `[0,activeCount-1]` + 调 `scrollOffset` 使选中进可见窗口，RFC §6 溢出滚动）；`panel` + `enter`→`detail`；`panel`/`detail` + `escape`→逐级返回（detail→panel→collapsed）；`panel`/`collapsed` + `space`/`tab`→切；`help` 切 keybar（可加 `showHelp` 位）。**P1 无破坏性**：`x`/`c`/`char` 在 P1 忽略（不 abort/不复制，留 P2）。`ctrl-c` 不在 reduce 里（terminal-ui 直接转发关闭）。

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
- Test: `tests/tui/terminal-ui-interactive.unit.test.ts`（新增交互集成测试）+ 既有 `tests/tui/golden-fixture.unit.test.ts`（collapsed 等价回归）

**Interfaces:**
- Consumes: `parseKeys`（Task1）、`Region`（Task2）、`buildPanelLines`/`buildDetailLines`（Task3）、`reduce`/`UiState`/`INITIAL_UI_STATE`（Task4）、既有 `buildActiveFooter`（collapsed 内容）。
- Produces: `TerminalUi` 内部行为变化（无新公开 API；`attachTerminalUi` 签名不变）。

- [ ] **Step 1: 写交互集成测试**——fake stdin（可 `emit("data", Buffer)`）+ fake stdout（capture）+ `isTTY:true` + 固定 columns/rows + 冻结时钟。断言：① 构造时若 TTY 则 `setRawMode(true)` 被调；② 喂 `space` 后有活跃请求时 region 渲染 panel（含逐条行）；③ 喂 `down` 移动选中（反色行变）；④ 喂 `enter` → detail；⑤ 喂 `escape` 逐级回 collapsed；⑥ 喂 `ctrl-c`(`0x03`) → mock `handleShutdownSignal("SIGINT")` 被调；⑦ `destroy()` → `setRawMode(false)` + region `clear()`（DECSTBM 复位）；⑧ 非 TTY 构造 → 不设 raw mode、无 region、退回日志。

- [ ] **Step 2: 跑证 FAIL**。Run: `bun test tests/tui/terminal-ui-interactive.unit.test.ts` Expected: FAIL。

- [ ] **Step 3: 实现集成**：
  - 构造时若 TTY：`stdin.setRawMode(true)`、`stdin.resume()`、`stdin.on("data", chunk => this.onInput(chunk))`、藏光标 `\x1b[?25l`；注册 `process.on("exit", () => this.restoreTerminal())`（PoC-4 承重）。
  - `onInput(chunk)`：`parseKeys(chunk)` → 逐 key：`ctrl-c`→`handleShutdownSignal("SIGINT")`（注入依赖便于测试）；其它→`this.uiState = reduce(this.uiState, key, {activeCount, visibleRows})` → `this.renderRegion()`。
  - `renderRegion()`（替代/包装现有 `renderFooter`）：按 `uiState.view` 组 lines——`collapsed`→`[buildActiveFooter(...)]`（**N=1、逐字等价 P0**）；`panel`→`buildPanelLines(...)`；`detail`→`buildDetailLines(...)`；交 `this.region.render(lines)`。100ms timer 与 bus 事件都调 `renderRegion`。render 全同步 + reentrancy flag。
  - `restoreTerminal()`：`setRawMode(false)` + `region.clear()`（`\x1b[r` + 显光标 `\x1b[?25h`）；`destroy()` 调它 + exit-hook 调它（幂等）。
  - `printLog` 协调：日志行仍在 region 上方（DECSTBM 滚动区内），region 由 `Region` 独占 → `printLog` 写日志后调 `renderRegion` 重画。
  - **collapsed 单行仍走 Region（N=1）**：确认 Region 对单行的输出与 P0 `CLEAR_LINE + footer` **字节等价**——若 DECSTBM 单行序列与旧 `\x1b[2K\r` 不同，golden 会变。**处理**：collapsed 态可保留旧单行 `CLEAR_LINE` 路径（Region 仅 panel/detail 用），或更新 golden 为**有意变更**（需评审确认 collapsed 视觉不劣化）。默认走前者（collapsed 保旧路径，最小惊扰），Region 仅多行态启用。

- [ ] **Step 4: 全回归 + golden 等价**。Run: `bun run typecheck` && `bun test tests/tui/ tests/observability/ tests/pipeline/pipeline-retry-tui.unit.test.ts` Expected: 全 PASS，**collapsed golden 逐字不变**。

- [ ] **Step 5: lint + commit**。
```bash
git commit -F <msgfile> -- src/lib/tui/terminal-ui.ts tests/tui/terminal-ui-interactive.unit.test.ts
# msg: feat(tui): wire raw-mode input + region rendering into TerminalUi (P1)
```

---

### Task 6: 终端安全收尾 —— exit-hook 还原 + shutdown scheme A + ESLint 边界

**Files:**
- Modify: `src/lib/tui/terminal-ui.ts`（若 Task5 未含 shutdown 协调）、`eslint.config.js`、`tests/tui/layer-boundaries.unit.test.ts`
- Test: `tests/tui/terminal-restore.unit.test.ts`

**Interfaces:**
- Produces: 无新公开 API；补终端还原鲁棒性 + 结构边界。

- [ ] **Step 1: 写还原/边界测试**——① exit-hook：mock `process.on("exit")` 触发 → `restoreTerminal` 调（setRawMode(false) + region clear）；② scheme A：shutdown 开始（`system.shutdown_phase_changed`）→ TerminalUi 还原 cooked + 拆 region（后续 Ctrl-C 回归真 SIGINT）；③ L1 边界：`tui/input/` 外无 `setRawMode`、`keys/controller/render` 互不 import 内部（正样本自证）。

- [ ] **Step 2: 跑证 FAIL**。

- [ ] **Step 3: 实现**——① `restoreTerminal` 幂等（已 Task5，补 exit-hook 若缺）；② 订 `system.shutdown_phase_changed`：draining 起调 `restoreTerminal()` + 停 region 渲染（scheme A，RFC §7）；③ `eslint.config.js` 的 tui/ 块补：`keys/controller/render/*` path-group 互不 import 内部 + `setRawMode`/`process.stdin` 仅 `tui/input/`（用 `no-restricted-syntax` 或 L1 守卫）；L1 守卫测试放开 P0 的「tui 无 setRawMode」断言（改为「仅 input/ 有」）。

- [ ] **Step 4: 全回归 + lint:all**。Run: `bun test tests/tui/` && `bun run typecheck` && `bunx eslint src/lib/tui/ --no-cache` Expected: 绿。

- [ ] **Step 5: commit**。
```bash
git commit -F <msgfile> -- src/lib/tui/terminal-ui.ts eslint.config.js tests/tui/layer-boundaries.unit.test.ts tests/tui/terminal-restore.unit.test.ts
# msg: feat(tui): terminal restore (exit-hook + shutdown scheme A) + P1 eslint boundaries
```

---

### Task 7: P1 收尾 —— doc-sync + 人工验收清单

**Files:**
- Modify: `docs/DESIGN.md`（Console UI 节补交互面板）、`docs/rfc/2026-07-10-interactive-tui-live-panel.md`（P1 标已实施）、本计划头部状态、`docs/todo/deferred-backlog.md`（若有 P1 期发现的暂缓项）

- [ ] **Step 1: 全套件回归**。Run: `bun test tests/tui/ tests/observability/` && `bun run typecheck` Expected: 绿。
- [ ] **Step 2: doc-sync**——DESIGN.md「Console UI」补：折叠/展开/detail 三态 + 键位 + DECSTBM region；RFC P1 标「已实施」；跨文档 grep 验证无残留旧状态词。
- [ ] **Step 3: 人工验收清单**（写进本计划末，交用户真终端跑）：窄/宽终端 × 多请求，验展开/导航/detail/溢出滚动/resize 不破屏/Ctrl-C 能停/退出终端还原。**这些 pty 证不了、须真人**（呼应 RFC Q2 残留）。
- [ ] **Step 4: commit**。
```bash
git commit -F <msgfile> -- docs/DESIGN.md docs/rfc/2026-07-10-interactive-tui-live-panel.md docs/plan/2026-07-11-tui-interactive-panel-p1.md
# msg: docs(tui): sync DESIGN/RFC for P1 interactive panel
```

---

## Self-Review

- **Spec 覆盖**：RFC §4（region→Task2）、§5（交互/键位/detail→Task1/3/4/5）、§6（溢出滚动→Task3/4）、§7（Ctrl-C/还原/scheme A/非 TTY→Task5/6）、§8（keys/controller/render 分层 + ESLint→Task1-6）全映射。P2（abort/复制/user-abort provenance/drain 期渲染）**明确排除**。
- **占位符扫描**：无 TBD；各 Task 有具体接口签名 + 测试断言。
- **类型一致**：`KeyEvent`（T1）、`Region`（T2）、`buildPanelLines`/`buildDetailLines`（T3）、`UiState`/`reduce`（T4）跨 task 引用名一致；`ActiveRequestView` 复用/扩展 footer.ts 的类型。
- **承重风险显式**：Task5 Step3 的「collapsed 是否走 Region（N=1）会否改 golden」已给默认解（collapsed 保旧单行路径、Region 仅多行态）+ 备选（有意更新 golden 需评审）——这是 P1 最可能踩的等价陷阱，须实施时确认。
- **等价 oracle 贯穿**：golden-fixture（P0 建）在 Task5/6 复跑，collapsed 逐字不变。

## Execution Handoff

见会话——P1 建议 subagent-driven 执行（同 P0）。Task2（DECSTBM region）+ Task5（集成）是承重、须仔细审。**建议实施前用户先真终端跑 Q2 视觉复验**（`bun exp/tui-rawmode/sticky-region-decstbm.ts`）确认 DECSTBM 观感 OK，再动 Task2——虽 byte 级已选定，视觉是 pty 盲区。
