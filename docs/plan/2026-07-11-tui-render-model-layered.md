# TUI 渲染模型分层 —— 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐 task 实施。步骤用 checkbox（`- [ ]`）追踪。

**Goal:** 消除 TUI 交互面板的 DECSTBM 几何 churn（视图切换吃日志行 / 留空行 / footer 泄漏），把渲染协调改为「交互实例恒定高度区 + detail 备用屏 + 自愈 + 全协调」。

**Architecture:** 交互实例始终经 `Region.render` 且滚动区高度恒定 `MAX_PANEL_ROWS`（collapsed 补空行）→ 视图切换几何不变、零 churn；detail 迁到备用屏幕（进入 reset 边距、退出/崩溃 alt-screen-aware、有上界回放）；panel 每拍重申明 DECSTBM 自愈；单一 region 感知协调点收编旁路写。

**Tech Stack:** TypeScript / Bun test / 纯 ANSI escape（无第三方 TUI 框架）。

## Global Constraints

- **恒定几何**：交互实例 DECSTBM 滚动区高度 = `min(panelRows(), MAX_PANEL_ROWS)`，只在首次建立 / resize / detail 往返重建时变，**绝不随视图或在途数变**（spec INV-2）。
- **保留 BLOCK-1**：交互实例始终走 `Region.render`；非交互实例始终走 P0 内联 footer。实例级 mode 两分、无会话内切换（[terminal-ui.ts:668](../../src/lib/tui/terminal-ui.ts#L668)、P1 plan line 16）。**不引入第二套渲染模型进交互实例**。
- **collapsed 保留可发现性**：collapsed 复用 `buildCollapsedLines`（含 `space: expand` hint + `?` help），**不退回裸 footer**（spec I3）。
- **golden 逐字不变**：非交互 P0 路径（不注入 stdin）输出字节不变（Reading B）；`tests/tui/golden-fixture.unit.test.ts` 必须持续通过。
- **常量**：`MAX_PANEL_ROWS = 3`（`src/lib/tui/render/panel.ts` 导出）、`RESERVED_LOG_ROWS = 1`（`region.ts`）、`REPLAY_CAP = 200`（新增）。
- **测试隔离**：交互测试用注入的 FakeStdin（EventEmitter + `setRawMode`/`resume`/`pause`/`removeListener` spy）+ 捕获 chunks 的 fake stdout，**绝不碰真实 `process.stdin`**（[terminal-ui-interactive.unit.test.ts](../../tests/tui/terminal-ui-interactive.unit.test.ts) 既有手法）。
- **无 Claude 署名提交、conventional commits、细粒度 pathspec**。
- **不启服务器 / 不 kill**（`no-auto-server-no-kill`）；真终端行为靠 `exp/tui-rawmode/log-coordination-regression.ts` 由用户手动复验（INV-4 唯一 oracle）。

## File Structure

**P0 修改：**
- `src/lib/tui/render/region.ts` —— `render()` 加 fix A（几何不变时重申明 DECSTBM）。
- `src/lib/tui/terminal-ui.ts` —— `renderRegion()` 把 collapsed/panel 视图补空行到恒定高度 `interactivePanelHeight()`。
- `tests/tui/render/region.unit.test.ts` —— fix A 字节断言。
- `tests/tui/terminal-ui-interactive.unit.test.ts` —— 恒定几何 + 往返内容保全断言。

**P1 修改：**
- `src/lib/tui/terminal-ui.ts` —— render 分发 detail 特判（绕过 Region）；detail 进/退备用屏；detail 期日志入 `replayQueue`（有上界）；`restoreTerminal` alt-screen-aware。
- `tests/tui/terminal-ui-interactive.unit.test.ts` + `tests/tui/terminal-restore.unit.test.ts` —— detail 备用屏字节序列、回放、崩溃退屏断言。

**P2 新增 + 修改：**
- `src/lib/tui/terminal-coordinator.ts`（新）—— 模块级单例，region 感知的 `emergencyWrite`。
- `src/lib/observability/republish.ts` + `src/lib/observability/sinks/file.ts` —— reentrant/error stderr 直写改走 `emergencyWrite`。
- `src/lib/tui/terminal-ui.ts` —— 向 coordinator 注册自身的 region 状态查询 + 原子写。
- `eslint.config.js` —— 确认 coordinator 接线不破坏 `src/lib/tui/**` 边界。
- `tests/tui/terminal-coordinator.unit.test.ts`（新）+ 相关 sink 测试。

---

# Phase P0：恒定高度区 + fix A（消除核心 churn）

**交付物**：collapsed↔panel 切换零 churn（用户报告的默认场景 bug 主修复）+ panel 自愈。detail↔panel churn 暂留（P1 修）。

### Task P0.1：Region 每拍重申明 DECSTBM（fix A 自愈）

**Files:**
- Modify: `src/lib/tui/render/region.ts`（`render()` 方法，按符号 grep 定位）
- Test: `tests/tui/render/region.unit.test.ts`（**须更新既有对立断言，见 Step 4**）

**Interfaces:**
- Consumes: 现有 `Region.render(lines)` / `established` / `setScrollRegion` / `SAVE_CURSOR`/`RESTORE_CURSOR`。
- Produces: 几何不变时 `render()` 也发 `DECSC + \x1b[1;<bottom>r + DECRC` 重申明。

- [ ] **Step 1: 写失败测试**

在 `region.unit.test.ts` 加：
```ts
test("fix A: a same-geometry re-render re-asserts the DECSTBM scroll region", () => {
  const { stdout, chunks } = makeStdout() // 复用文件内既有 helper
  const region = new Region({ stdout, getColumns: () => 80, getRows: () => 24 })
  region.render(["line-a"])       // 首建（geometryChanged=true）
  chunks.length = 0               // 清掉首建字节
  region.render(["line-b"])       // 同几何重绘
  const out = chunks.join("")
  // 关键正样本：同几何重绘也必须重申明滚动区（否则扰动无法自愈）。
  // 24 rows, panelHeight=1 → bottom=23 → SET_REGION(1,23)。
  expect(out).toContain("\x1b[1;23r")
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/tui/render/region.unit.test.ts -t "re-asserts"`
Expected: FAIL —— 现有同几何分支不发 SET_REGION。

- [ ] **Step 3: 实现（region.ts `render()` 的 else 分支）**

在 `render()` 里，`if (geometryChanged) { … }` 之后、`out += SAVE_CURSOR`（画面板）之前，加同几何重申明：
```ts
    if (geometryChanged) {
      // …既有首建/重锚逻辑不变…
      this.established = { rows, panelHeight }
    } else {
      // fix A（spec INV-4）：几何不变时也重申明 DECSTBM，使任何未预期扰动
      // （旁路写 / 终端 quirk）在下一拍自愈。DECSC/DECRC 包裹抵消 DECSTBM 的
      // cursor-home 副作用（VT510），不移停泊光标、无闪烁、幂等。
      const bottom = rows - panelHeight
      out += SAVE_CURSOR + setScrollRegion(1, bottom) + RESTORE_CURSOR
    }
```

- [ ] **Step 4: 更新既有对立测试 + 跑测试确认通过**

**（C3 承重）** `region.unit.test.ts` 有一条既有 steady-state 断言（按名 grep "steady-state" / "does NOT re-issue"）断言同几何重绘 `.not.toMatch(/\x1b\[1;\d+r/)`——它编码的正是 fix A 要推翻的旧行为，必须**更新为断言同几何重绘 now 重申明**（即改成正向 `toContain("\x1b[1;23r")`，与本 task 新测试合并或替换）。

Run: `bun test tests/tui/render/region.unit.test.ts`
Expected: PASS（新测试 + 更新后的 steady-state 断言 + 其余既有全绿）。

- [ ] **Step 5: 提交**

```bash
git add -- src/lib/tui/render/region.ts tests/tui/render/region.unit.test.ts
git commit -F <msgfile>   # feat(tui): Region re-asserts DECSTBM every render (fix A self-heal)
```

### Task P0.2：交互实例恒定高度（collapsed 补空行、消 collapsed↔panel churn）

**Files:**
- Modify: `src/lib/tui/terminal-ui.ts`（`renderRegion()`，按符号 grep 定位；加私有 `interactivePanelHeight()`）
- Test: `tests/tui/terminal-ui-interactive.unit.test.ts`

**Interfaces:**
- Consumes: `buildViewLines()`、`panelRows()`（= `max(1, getRows()-RESERVED_LOG_ROWS)`）、`MAX_PANEL_ROWS`（从 `./render/panel` 导入）、`this.uiState.view`。
- Produces: collapsed/panel 视图交给 `region.render` 的行数恒等 `interactivePanelHeight()`；detail 视图暂不补（P1 迁走）。

- [ ] **Step 1: 写失败测试**

在 `terminal-ui-interactive.unit.test.ts` 加（用真实 helper：`new FakeStdin()` / `.asReadStream()` / `makeStdout()` 返回 `{stdout, chunks, text}` / `makeCtx(id, model, offsetMs)` 三参）：
```ts
test("constant geometry: collapsed↔panel toggle never resizes the DECSTBM region", () => {
  const stdin = new FakeStdin()
  const { stdout, chunks } = makeStdout()
  const bus = createBus()
  const ui = new TerminalUi(bus, { stdout, isTTY: true, columns: 80, rows: 24, stdin: stdin.asReadStream(), registerExitHook: () => {} })
  bus.scope("request").publish({ kind: "request.created", ctx: makeCtx("r1", "claude-opus-4-8", 1000) } as never)
  // 触发 collapsed 渲染（footer 定时器异步，改用 system.log 同步触发 printLog→renderRegion，
  // 既有 golden 测试手法，不新增测试专用方法）
  bus.scope("system").publish({ kind: "system.log", logType: "info", message: "x", time: Date.now() } as never)
  chunks.length = 0
  stdin.emit("data", Buffer.from(" ")) // collapsed→panel
  stdin.emit("data", Buffer.from(" ")) // panel→collapsed
  const regions = (chunks.join("").match(/\x1b\[1;(\d+)r/g) ?? [])
  const bottoms = new Set(regions.map((r) => /1;(\d+)r/.exec(r)![1]))
  expect(bottoms.size).toBe(1) // 变异：collapsed 用 1 行区、panel 用 3 行区 → size≥2 → 红
  ui.destroy()
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/tui/terminal-ui-interactive.unit.test.ts -t "constant geometry"`
Expected: FAIL —— 当前 collapsed 传 1 行、panel 传 3 行 → `bottoms.size===2`（区高 1 vs 3）。

- [ ] **Step 3: 实现（terminal-ui.ts）**

加私有方法 + 在 `renderRegion` 补空行：
```ts
/** 交互实例的恒定面板高度（spec INV-2）：视图切换绝不改变它。 */
private interactivePanelHeight(): number {
  return Math.min(this.panelRows(), MAX_PANEL_ROWS)
}
```
在 `renderRegion()` 里，`const lines = this.buildViewLines()` 之后、`region.render(lines)` 之前：
```ts
    const lines = this.buildViewLines()
    // 恒定高度（spec INV-2）：collapsed/panel 补空行到恒定 H，使滚动区几何
    // 跨视图切换不变 → 零 churn。detail 走独立路径（P1），此处不补。
    if (this.uiState.view !== "detail" && lines.length > 0) {
      const h = this.interactivePanelHeight()
      while (lines.length < h) lines.push("")
    }
    if (lines.length === 0) this.region.clear()
    else this.region.render(lines)
```
（`buildViewLines` 返回 `Array<string>`，`while push` 就地补；`buildPanelLines` 已返回 H 行故对 panel 是 no-op。）确认 `MAX_PANEL_ROWS` 已从 `./render/panel` import（`panelContentRows` 同源已 import，追加即可）。

- [ ] **Step 4: 更新既有对立断言 + 跑测试确认通过 + 全回归**

**（C4 承重）** `terminal-ui-interactive.unit.test.ts` 有一条既有断言（按名 grep "SCROLL_RESET" / escape 收回）：escape 收回 collapsed 时 `collapseOut` `toContain(SCROLL_RESET)`（`\x1b[r`）。恒定高度后 collapsed 与 panel 同为 N=3、`geometryChanged=false` → **不再发 `\x1b[r`**——这条断言必须**更新**（改为断言收回后**不**出现 `\x1b[r`、几何不变；这正是 INV-2 想要的行为）。

Run: `bun test tests/tui/ && bun test tests/tui/golden-fixture.unit.test.ts`
Expected: PASS（新测试 + 更新后的 round-trip 断言 + golden 逐字不变 —— 非交互路径不受影响）。

- [ ] **Step 5: 提交**

```bash
git add -- src/lib/tui/terminal-ui.ts tests/tui/terminal-ui-interactive.unit.test.ts
git commit -F <msgfile>   # feat(tui): constant-height interactive region (collapsed pads to MAX_PANEL_ROWS, kills collapsed↔panel churn)
```

### Task P0.3：往返内容保全断言（INV-1 直接正样本）

**Files:**
- Test: `tests/tui/terminal-ui-interactive.unit.test.ts`

**Interfaces:** 无源码改动 —— 纯补测试锁死 INV-1（几何 N 恒定证不了"日志未被覆写"，须直接断言 collapsed↔panel 往返**不覆写**已上屏日志的物理行）。

- [ ] **Step 1: 写测试（负向覆写断言，非同义反复）**

```ts
test("INV-1: collapsed→panel→collapsed round-trip does not overwrite prior log rows", () => {
  const stdin = new FakeStdin()
  const { stdout, chunks } = makeStdout()
  const bus = createBus()
  const ui = new TerminalUi(bus, { stdout, isTTY: true, columns: 80, rows: 24, stdin: stdin.asReadStream(), registerExitHook: () => {} })
  bus.scope("request").publish({ kind: "request.created", ctx: makeCtx("r1", "claude-opus-4-8", 1000) } as never)
  bus.scope("system").publish({ kind: "system.log", logType: "info", message: "SENTINEL", time: Date.now() } as never)
  chunks.length = 0
  stdin.emit("data", Buffer.from(" ")) // → panel
  stdin.emit("data", Buffer.from(" ")) // → collapsed
  const out = chunks.join("")
  // 正样本：往返期间面板绝不覆写 SENTINEL 所在的日志行。SENTINEL 打印后位于
  // 滚动区内某行；恒定几何下面板只画底部 3 行、绝不回头 CUP 到日志行清行。
  // 断言：往返输出里没有把光标移到"日志区行 + CLEAR_LINE"的序列吃掉历史。
  // 由于 SENTINEL 一旦上屏其字节不可撤回，真正的鉴别力在：往返不产生
  // 额外的日志区行覆写。这里断言 SENTINEL 仍只被写一次（无重绘搬运）且
  // 面板 CUP 目标恒在底部 3 行（panelTop..rows），不落在日志区。
  const cups = [...out.matchAll(/\x1b\[(\d+);1H/g)].map((m) => Number(m[1]))
  // rows=24, panelHeight=3 → 面板行只应是 22/23/24；任何 < 22 的 CUP+CLEAR 即回头吃日志。
  expect(cups.every((row) => row >= 22)).toBe(true) // 变异：若往返 resize 到日志区清行 → row<22 → 红
  ui.destroy()
})
```
> 说明：此断言比"SENTINEL 仍出现"有真鉴别力——它证明往返期间所有绝对光标定位都落在受保护的底部面板行（≥panelTop），绝不回头到日志区覆写。若回归导致几何 resize / 清日志行，CUP 目标会 < panelTop → 红。

- [ ] **Step 2-3: 跑测试确认通过（当前 P0.2 已使其绿）+ 提交**

Run: `bun test tests/tui/terminal-ui-interactive.unit.test.ts`
```bash
git add -- tests/tui/terminal-ui-interactive.unit.test.ts
git commit -F <msgfile>   # test(tui): pin INV-1 round-trip log-preservation
```

---

# Phase P1：detail 备用屏 + C1/C2 + 回放

**交付物**：detail 全屏可滚（C1）、崩溃干净退屏（C2）、detail 期日志不丢回放、detail↔panel 零 churn（detail 不再走 Region）。

### Task P1.1：render 分发 detail 特判（绕过 Region）

**Files:**
- Modify: `src/lib/tui/terminal-ui.ts`（`render()` / `renderRegion()` / `buildViewLines()` / `onInput()`，均按符号 grep 定位——真实行号比早期草稿偏后约 13 行，勿信行号）
- Test: `tests/tui/terminal-ui-interactive.unit.test.ts`

**Interfaces:**
- Produces: 新私有 `renderDetail()`；`render()` 在 `view==="detail"` 时调 `renderDetail()`、否则 `renderRegion()`。`buildViewLines` 的 detail 分支删除（改由 `renderDetail` 用 `buildDetailLines` 直接全屏画）。

- [ ] **Step 1: 写失败测试**（进 detail 发备用屏 + reset 边距）

```ts
test("detail enters the alternate screen and resets scroll margins (C1)", () => {
  // …构造交互 ui + 1 在途请求…
  stdin.emit("data", Buffer.from(" "))    // collapsed→panel
  stdin.emit("data", Buffer.from("\r"))   // panel→detail (enter)
  const out = chunks.join("")
  const iAlt = out.indexOf("\x1b[?1049h")
  const iReset = out.indexOf("\x1b[r", iAlt)
  expect(iAlt).toBeGreaterThanOrEqual(0)          // 进备用屏
  expect(iReset).toBeGreaterThan(iAlt)            // C1：进屏后 reset 边距（顺序！）
})
```

- [ ] **Step 2: 确认失败**（当前 detail 走 Region、无 `?1049h`）

- [ ] **Step 3: 实现**

在 `render()` 分发：
```ts
private render(): void {
  if (!this.interactive) { this.renderFooter(); return }
  if (this.uiState.view === "detail") this.renderDetail()
  else this.renderRegion()
}
```
**（C2 承重）同时把 `onInput` 里的 `this.renderRegion()` 改为 `this.render()` 分发**——否则键盘进入 detail 走 `onInput → renderRegion → buildViewLines`（detail 分支已删）→ `region.clear()`，detail 永远画不出、本 task 测试也转不绿。现有 `onInput`（按符号 grep 定位）reduce 后直调 `this.renderRegion()`，改为：
```ts
private onInput(chunk: Buffer): void {
  for (const key of parseKeys(chunk)) {
    if (key.kind === "ctrl-c") { this.onShutdownSignal("SIGINT"); continue }
    const prevView = this.uiState.view
    this.uiState = reduce(this.uiState, key, { activeCount: this.active.size, visibleRows: this.visibleRequestRows() })
    // 离开 detail（detail→panel via esc）须退备用屏（P1.2 exitDetail）。
    if (prevView === "detail" && this.uiState.view !== "detail") this.exitDetail()
    else this.render() // 经分发器（detail→renderDetail、其余→renderRegion）
  }
}
```
新增 `renderDetail()`（进备用屏一次性、后续 esc 才退）：
```ts
private detailActive = false
private renderDetail(): void {
  if (this.silent || !this.region || this.shuttingDown) return
  const entry = [...this.active.values()].at(this.uiState.selectedIndex)
  if (!entry) { this.exitDetail(); return } // 选中失效 → 退回
  if (!this.detailActive) {
    this.detailActive = true
    // C1：进备用屏 → reset DECSTBM 边距（否则残留 panel 滚动区截断超屏 detail）
    // → DECOM off（防御）→ 清屏。顺序 load-bearing。
    this.stdout.write("\x1b[?1049h" + "\x1b[r" + "\x1b[?6l" + "\x1b[H\x1b[2J")
  }
  // ActiveRequest 结构上满足 DetailView（tags/thinking/attempts 皆可选、ActiveRequest
  // 全具备），现有 buildViewLines detail 分支即直接传 entry——无需转换函数。
  const lines = buildDetailLines({ entry, now: Date.now(), columns: this.getColumns() })
  this.stdout.write("\x1b[H\x1b[2J" + lines.join("\r\n"))
}
```
`buildViewLines` 删去 detail 分支（renderRegion 不再处理 detail）。

- [ ] **Step 4-5: 跑测试确认通过 + 提交**

### Task P1.2：detail 退出 → 退备用屏 + 重建区 + 重画

**Files:** `src/lib/tui/terminal-ui.ts`、`tests/tui/terminal-ui-interactive.unit.test.ts`

**Interfaces:** 新私有 `exitDetail()`；controller 的 `esc`（detail→panel）触发它。

- [ ] **Step 1: 写失败测试**

```ts
test("esc from detail leaves the alt screen and re-establishes the region", () => {
  // …进 detail…
  chunks.length = 0
  stdin.emit("data", Buffer.from("\x1b")) // esc → panel
  const out = chunks.join("")
  const iOff = out.indexOf("\x1b[?1049l")
  const iRegion = out.indexOf("\x1b[1;", iOff) // 退屏后重建 DECSTBM
  expect(iOff).toBeGreaterThanOrEqual(0)
  expect(iRegion).toBeGreaterThan(iOff)
})
```

- [ ] **Step 2: 确认失败**

- [ ] **Step 3: 实现**

```ts
private exitDetail(): void {
  if (!this.detailActive) return
  this.detailActive = false
  this.stdout.write("\x1b[?1049l")     // 退备用屏（回主屏，含之前内容）
  this.region?.forceReestablish()      // 备用屏往返 + 进屏 reset 已改边距 → 必须重建
  this.flushReplayQueue()              // P1.3 提供；此 task 先留空实现
  this.renderRegion()                  // 重画 panel（此刻 view 已回 panel）
}
```
Region 加 `forceReestablish()`：`this.established = undefined`（下次 render 全重建）。
`onInput` 的 detail 离开检测已在 **P1.1 实现**（`prevView === "detail" && view !== "detail"` → `exitDetail()`）；本 task 只需提供 `exitDetail()` 方法体。controller 的 `detail` 态 `esc`（按符号 grep 定位）已返回 `view: "panel"`。

- [ ] **Step 4-5: 通过 + 提交**

### Task P1.3：detail 期日志入有上界回放队列 + 退出回放

**Files:** `src/lib/tui/terminal-ui.ts`、测试同上

**Interfaces:** 新字段 `replayQueue: Array<string>`、常量 `REPLAY_CAP = 200`；`printLog` 在 detail 态入队；`flushReplayQueue()` 退出时写出。

- [ ] **Step 1: 写失败测试**

```ts
test("logs during detail are queued (not written to alt screen) and replayed on exit", () => {
  // …进 detail…
  chunks.length = 0
  bus.scope("system").publish({ kind: "system.log", logType: "info", message: "DURING-DETAIL", time: Date.now() } as never)
  expect(chunks.join("")).not.toContain("DURING-DETAIL") // 不写备用屏
  stdin.emit("data", Buffer.from("\x1b")) // esc → 退出 + 回放
  expect(chunks.join("")).toContain("DURING-DETAIL")     // 回放进 scrollback
})
```

- [ ] **Step 2: 确认失败**

- [ ] **Step 3: 实现**

`printLog` 头部：
```ts
private printLog(message: string): void {
  if (this.silent) return
  if (this.interactive && this.detailActive) {
    this.replayQueue.push(message)
    if (this.replayQueue.length > REPLAY_CAP) this.replayQueue.shift() // 上界，durability 靠 FileSink
    return
  }
  // …既有 interactive / P0 分支…
}
/** 退 detail 时把缓存日志写进（已重建的）滚动区，随后 renderRegion 重画 panel。 */
private flushReplayQueue(): void {
  for (const msg of this.replayQueue.splice(0)) this.stdout.write(msg + "\n")
}
```
翻转（detail→panel）在同一同步 `onInput` 回合完成（M8）：`exitDetail` 依次 `?1049l` → 重建区 → `flushReplayQueue` → `renderRegion`，全同步无 log 交错。

- [ ] **Step 4-5: 通过 + 提交**

### Task P1.4：`restoreTerminal` alt-screen-aware（C2 崩溃/退出/drain）

**Files:** `src/lib/tui/terminal-ui.ts`（`restoreTerminal`，按符号 grep 定位）、`tests/tui/terminal-restore.unit.test.ts`

**Interfaces:** `restoreTerminal()` 在 `region.clear()` 前，若 `detailActive` 则先 `\x1b[?1049l`。

- [ ] **Step 1: 写失败测试**

```ts
test("restore while in detail leaves the alt screen first (C2)", () => {
  // …进 detail…（注入 registerExitHook 捕获 hook）
  chunks.length = 0
  ui.destroy() // 或触发 exit hook / draining —— 模拟崩溃/退出路径
  const out = chunks.join("")
  expect(out.indexOf("\x1b[?1049l")).toBeGreaterThanOrEqual(0) // 先退备用屏
  // 且在 RESET_SCROLL_REGION / SHOW_CURSOR 之前
  expect(out.indexOf("\x1b[?1049l")).toBeLessThan(out.indexOf("\x1b[?25h"))
})
```

- [ ] **Step 2: 确认失败**（现 `restoreTerminal` 不知备用屏）

- [ ] **Step 3: 实现**

```ts
private restoreTerminal(): void {
  if (!this.interactive || this.restored) return
  this.restored = true
  if (this.detailActive) { this.stdout.write("\x1b[?1049l"); this.detailActive = false } // C2
  if (this.onData) this.stdin?.removeListener("data", this.onData)
  this.stdin?.pause()
  this.stdin?.setRawMode(false)
  this.region?.clear()
}
```

- [ ] **Step 4-5: 通过（+ 既有 restore 测试全绿）+ 提交**

### Task P1.5：detail 期 resize（M7）+ drain（C2 衍生）

**Files:** `src/lib/tui/terminal-ui.ts`、测试同上

- [ ] **Step 1-5**：detail 态 resize 时重画全屏（reset 边距 + 重绘 detail），不走 panel 的 `geometryChanged` 重锚；`system.shutdown_phase_changed` 的 `draining` 分支（按符号 grep 定位）若 `detailActive` 则先退备用屏再 `restoreTerminal`。测试断言 detail 态 drain → 出 `?1049l`。提交。

---

# Phase P2：emergencyWrite 收编旁路写

**交付物**：republish reentrant + FileSink error 的 stderr 直写改走 region 感知协调点，消除旁路扰动（INV-3）。

### Task P2.1：terminal-coordinator 单例 + `emergencyWrite`

**Files:**
- Create: `src/lib/tui/terminal-coordinator.ts`
- Test: `tests/tui/terminal-coordinator.unit.test.ts`

**Interfaces:**
- Produces: 模块级单例，暴露 `registerTerminal(hooks)` / `emergencyWrite(line)`。`hooks` = `{ state: () => "region"|"alt"|"inline"|"none"; clearPanel(): string; redrawPanel(): string; write(s): void }`（由 TerminalUi 注册）。未注册时 `emergencyWrite` 直写 `process.stderr`（保底、同今日行为）。

- [ ] **Step 1-5**：TDD。测试断言：① 未注册 → 直写 stderr；② region 态注册 → `emergencyWrite` 产出「清面板 + 消息 + 重画」的**单次原子** write；③ alt 态 → write-through 到（备用屏）主流并标注（I-new-1 采纳 write-through：宁污染勿丢失）；④ inline 态 → `CLEAR_LINE` + 消息 + 重画 footer（I2）；⑤ **不经 bus、不触发 publish**（防风暴）。实现 + 提交。

### Task P2.2：TerminalUi 注册 + 收编 republish/FileSink

**Files:**
- Modify: `src/lib/tui/terminal-ui.ts`（构造时 `registerTerminal`；提供 state/clearPanel/redrawPanel/write，且**不受 `rendering` 守卫抑制**）
- Modify: `src/lib/observability/republish.ts`（:59 reentrant 兜底 → `emergencyWrite`）
- Modify: `src/lib/observability/sinks/file.ts`（:132 error → `emergencyWrite`）
- Test: 相关 sink 测试 + 集成断言

**Interfaces:**
- Consumes: `emergencyWrite`（从 `~/lib/tui/terminal-coordinator`）。
- **ESLint**：republish/file 属 `observability/`，import `tui/terminal-coordinator` 须不违反 `src/lib/tui/**` 边界规则——coordinator 设计为**无 tui 内部依赖的纯叶子**（不 import region/terminal-ui），故可被 observability 安全引用（类比 `projections/format` 的共享叶子地位）。若 ESLint 仍报，评估把 coordinator 放 `observability/` 或独立 `lib/terminal/`。

- [ ] **Step 1-5**：TDD。测试断言 republish reentrant / FileSink error 走 `emergencyWrite`、reentrant 上下文仍写出（不被 `rendering` 守卫吞、不触发 publish）。实现 + `bun run typecheck` + `bunx eslint <改动文件>` + 提交。

### Task P2.3：ESLint 边界确认 + 分层守卫测试

**Files:** `eslint.config.js`（如需）、`tests/tui/layer-boundaries.unit.test.ts`

- [ ] **Step 1-5**：确认 coordinator 接线过 `bun run lint:all`（无缓存）；`layer-boundaries` L1 守卫测试断言 coordinator 无 tui 内部 import。提交。

---

# 收尾（全阶段完成后）

- [ ] **真终端复验**：用户跑 `exp/tui-rawmode/log-coordination-regression.ts` 复验最终生产行为对齐 PoC（INV-4 唯一 oracle）。
- [ ] **doc-sync**（`session-closeout` 步 2）：`docs/DESIGN.md`「活的架构现状」Console UI 行更新为恒定高度区 + detail 备用屏 + 三态协调；ADR `2026-07-10-tui-terminal-ownership.md` 决策 4 两次补记（M2：①原始 DECSTBM 选型 ②本演进）；spec 头部标实施状态。
- [ ] **合并态 subagent review**：全分支集成审查（终端行为 + 分层边界）。
- [ ] **backlog**：spec §8 未采纳/推迟项归档 `docs/todo/`。

## Self-Review（写完自检）

- **Spec 覆盖**：INV-1（P0.2/P0.3）、INV-2（P0.2）、INV-3（P2）、INV-4（P0.1 + 真终端）、INV-5（P1.3）、INV-6（P1.4/P1.5）—— 全部有 task。C1（P1.1）、C2（P1.4）、I2（P2.1 inline 态）、I3（P1.1 绕过 Region + P0 保留 buildCollapsedLines）、I-new-1（P2.1 write-through）—— 全覆盖。
- **类型一致**：`interactivePanelHeight()`/`renderDetail()`/`exitDetail()`/`flushReplayQueue()`/`detailActive`/`replayQueue`/`REPLAY_CAP`/`forceReestablish()` 跨 task 命名一致。
- **占位符**：P1.5/P2.1/P2.2/P2.3 用了压缩 Step（1-5），因其为机械 TDD 循环 + 已给接口/断言要点；实施者按 P0 的完整 5-step 模板展开。
- **阶段边界**：P0 独立交付（默认场景主修复）、P1 独立交付（detail 完备）、P2 独立交付（旁路加固），每阶段可单独 review/merge。

## 对抗审查响应记录（1 轮，已全部采纳修订）

subagent 对抗审查（核验代码片段 vs 真实代码）报 4 Critical + 2 Important + Minor，**全部采纳修订**：
- **C1**（`toDetailView` 虚构）→ P1.1 改为直接传 `entry`（`ActiveRequest` 结构上满足 `DetailView`，现有 `buildViewLines` detail 分支已证）。
- **C2**（`onInput` 直调 `renderRegion` 而非 `render` 分发 → detail 渲不出、测试转不绿）→ P1.1 显式加「`onInput` 改经 `render()` 分发 + `prevView` 捕获触发 `exitDetail`」，P1.2 去重。
- **C3**（P0.1 fix A 打爆既有 "steady-state 不重发 DECSTBM" 断言）→ P0.1 Step 4 增「更新该对立断言为正向」。
- **C4**（P0.2 恒定几何打爆既有 "escape 收回发 `\x1b[r`" 断言）→ P0.2 Step 4 增「更新该 round-trip 断言」。
- **I1**（测试 helper 名不符）→ 全片段改真实 helper（`new FakeStdin()`/`makeStdout()`/`makeCtx(id,model,offset)`）。
- **I2**（P0.3 SENTINEL 同义反复）→ 改为负向覆写断言（往返期所有 CUP 目标 ≥ panelTop，回头到日志区即红）。
- **Minor**（行号系统偏早 ~13 行）→ 全改「按符号 grep 定位」。
- **确认成立**（非缺陷）：P2 ESLint 分层论证（coordinator 作纯叶子可被 observability import，无规则禁止）；`forceReestablish` 正确标注为新增。
