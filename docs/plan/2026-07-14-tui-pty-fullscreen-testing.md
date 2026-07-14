# TUI PTY 整屏测试 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 `src/lib/tui/` 的 raw-mode 编排层建立 PTY 整屏测试 oracle——用 `Bun.Terminal` + `@xterm/headless` 把真 `TerminalUi` 的输出字节解释成 rows×cols 网格 + scrollback，断言字节测证不了的整屏不变量（不吞行、footer 钉底、退出还原、切 detail 不覆盖、resize 重锚）。

**Architecture:** 复用 harness（`tests/tui/pty/harness.ts`）封装「spawn 真 driver → Bun.Terminal 伪终端 → 喂键序列 → 输出串行喂 @xterm/headless → 读网格+scrollback」。**关键**：driver 会在退出时 `ui.destroy()→region.clear()` 擦掉 panel/footer（`region.ts:229` 的 `ERASE_TO_END`），所以「运行中空间关系」（footer 钉底、resize 重锚、切 detail）**不能读末态网格**——harness 提供 **sentinel 握手快照**：driver 在关键状态发唯一 marker 日志，harness 检测到 marker 出现在网格里就抓**当时**的快照（driver 未 clear 前）。「退出还原」则读末态原始字节 + 重放。每个不变量一个真 `TerminalUi` driver + 一个 `.pty.test.ts`，内建红绿对照。

**Tech Stack:** Bun 1.3.14 内置 `Bun.Terminal`；`@xterm/headless@6.0.0`（唯一新 devDep）；纯 TypeScript；`bun test`。

## Global Constraints

（每个 task 隐含包含本节，值逐字来自 spec `docs/spec/2026-07-14-tui-pty-fullscreen-testing.md`）

- **Bun 版本固定 1.3.14**：`Bun.Terminal` 是相对新 API，PoC 只在此版本 + Linux 验过。
- **`@xterm/headless` 读 buffer 三前提**：构造传 `allowProposedApi: true`；等 `terminal.write(data, cb)` 的 cb 再读 buffer；遍历 `0..buffer.active.length-1`（含 scrollback）。
- **编号载荷零填充**：`SELFTEST-LOG-0007`（防子串误配）；正则 `/PREFIX-(\d{4})/g` 求差。
- **缺依赖硬 fail 非 skip**：`@xterm/headless` 未装或 `Bun.Terminal` 不可用 → 测试报错失败，绝不静默 skip。
- **不碰 4141 主服务器**：driver 只驱动 `TerminalUi` 跑事件、不起服务；超时/结束只按 harness 持有的 `proc.pid` 精确处理，绝不 `pkill`/`killall`。
- **时序场景连跑 ≥10 次**证确定性。
- **红绿对照铁律**：每个不变量的测试注释写明红样本破坏点 file:line；实施 Step 里**实际执行**「临时破坏 → 跑测试须红并报出具体症状 → 恢复（重新编辑非 git revert）→ 跑测试须绿」。假绿测试比不测更糟。
- **destroy 擦屏铁律**（GPT 复审 BLOCK）：driver `ui.destroy()` 触发 `region.clear()` 的 `ERASE_TO_END`，擦掉 panel/footer。凡断言「运行中的 footer/panel/滚动区空间关系」，**必须用 sentinel 握手快照读 driver clear 前的网格**，绝不读末态。scrollback 里的滚动**日志**不受 clear 影响（clear 只擦 panel 区），故「不吞行」可读末态。

---

## File Structure

- `package.json`（改）— 加 `@xterm/headless` devDep；加 `test:pty`；`test:ci` 追加 `&& bun run test:pty`。
- `tests/tui/pty/harness.ts`（建）— 复用件（含 sentinel 握手快照、串行 resize、try/finally 资源清理）。
- `tests/tui/pty/drivers/log-stream.ts`（建）— 真 TerminalUi + in-flight request + 编号日志 + marker 发射。
- `tests/tui/pty/drivers/detail-cycle.ts`（建）— 同上 + `space→enter→escape` 进出 detail + detail 窗口 marker。
- `tests/tui/pty/drivers/resize-anchor.ts`（建）— 同 log-stream + resize 前后 marker。
- `tests/tui/pty/harness.pty.test.ts`（建）— Phase 0 管线自证。
- `tests/tui/pty/no-eaten-lines.pty.test.ts`（建）— ① 不吞行（读末态 scrollback）。
- `tests/tui/pty/footer-pinned.pty.test.ts`（建）— ② footer 钉底（握手快照）。
- `tests/tui/pty/clean-restore.pty.test.ts`（建）— ③ 退出还原（末态字节 + sentinel 落点）。
- `tests/tui/pty/detail-no-clobber.pty.test.ts`（建）— ④ 切 detail 不覆盖（detail 窗口 marker）。
- `tests/tui/pty/resize-reanchor.pty.test.ts`（建）— ⑤ resize 重锚（中间快照 + test.failing 哨兵）。

**依赖顺序**：Task 0（脚手架+harness）→ 其余各自独立。

---

## Task 0: 脚手架 — 依赖、编排、harness（含握手快照 + 时序修复）

**Files:**
- Modify: `package.json`（scripts `test:ci` 行 58；devDependencies）
- Create: `tests/tui/pty/harness.ts`
- Test: `tests/tui/pty/harness.pty.test.ts`

**Interfaces:**
- Produces:
  - `missingNumbers(allText, prefix, total): number[]` — 纯函数数缺号。
  - `collectGrid(term): string[]` — 遍历 `0..buffer.active.length-1`。
  - `writeXterm(term, data): Promise<void>`。
  - `runDriver(opts): Promise<RunDriverResult>` — 见下签名。driver↔harness 用 marker 日志握手抓运行中快照。

- [ ] **Step 1: 装依赖（不装 node-pty）**

Run: `cd /home/xp/src/copilot-api-js && bun add -d @xterm/headless@6.0.0`
Expected: `installed @xterm/headless@6.0.0`；`package.json` devDependencies + `bun.lock` 更新。

- [ ] **Step 2: 写 harness（API 用法逐字来自已验 PoC `exp/poc-js-pty-grid/index.ts`）**

Create `tests/tui/pty/harness.ts`：

```typescript
/**
 * PTY 整屏测试复用件 — Bun.Terminal 伪终端跑真 TerminalUi driver，输出串行喂
 * @xterm/headless 解释成网格+scrollback。见 spec
 * docs/spec/2026-07-14-tui-pty-fullscreen-testing.md。
 *
 * 握手快照：driver 退出时 region.clear() 擦掉 panel/footer，故「运行中空间关系」
 * 不能读末态。driver 在关键状态发唯一 marker 日志（如 "__SNAP__panel"），harness
 * 在串行 write 链上检测到该 marker 已解释进网格，即抓当时快照存入 result.snapshots。
 */
import { Terminal } from "@xterm/headless"

const COLS = 80
const ROWS = 24
const SCROLLBACK = 2000

type Xterm = InstanceType<typeof Terminal>

export function collectGrid(term: Xterm): Array<string> {
  const buffer = term.buffer.active
  const lines: Array<string> = []
  for (let i = 0; i < buffer.length; i++) lines.push(buffer.getLine(i)?.translateToString(true) ?? "")
  return lines
}

export function writeXterm(term: Xterm, data: string): Promise<void> {
  return new Promise((resolve) => term.write(data, resolve))
}

export function missingNumbers(allText: string, prefix: string, total: number): Array<number> {
  const re = new RegExp(`${prefix}-(\\d{4})`, "g")
  const found = new Set([...allText.matchAll(re)].map((m) => Number(m[1])))
  return Array.from({ length: total }, (_, i) => i + 1).filter((n) => !found.has(n))
}

export interface RunDriverOptions {
  driver: string
  env?: Record<string, string>
  /** 定时键：at 毫秒后向伪终端写 bytes（如 { at: 250, bytes: " " }）。 */
  keys?: Array<{ at: number; bytes: string }>
  /** 跑中 resize：at 毫秒后同时 resize 伪终端 + xterm，串行插入 write 链（GPT HIGH）。 */
  resizes?: Array<{ at: number; cols: number; rows: number }>
  /**
   * 握手快照：driver 发出的 marker 一旦解释进网格，抓当时的 collectGrid() 存进
   * result.snapshots[label]。marker 用不与编号载荷冲突的独特串（如 "__SNAP__panel"）。
   */
  snapshots?: Array<{ marker: string; label: string }>
  timeoutMs?: number
  cols?: number
  rows?: number
}

export interface RunDriverResult {
  /** 末态网格（含 scrollback）——「不吞行」「退出还原重放」用。 */
  grid: Array<string>
  allText: string
  /** 累积原始字节（未经 xterm）——光标可见性/备用屏进出等只能验字节。 */
  rawText: string
  /** 握手快照：label → 抓拍时的网格行。运行中空间关系断言用。 */
  snapshots: Record<string, Array<string>>
  rawBytes: number
  exitCode: number
}

export async function runDriver(opts: RunDriverOptions): Promise<RunDriverResult> {
  const cols = opts.cols ?? COLS
  const rows = opts.rows ?? ROWS
  const xterm = new Terminal({ cols, rows, scrollback: SCROLLBACK, allowProposedApi: true })
  const decoder = new TextDecoder()
  let writes = Promise.resolve()
  let raw = ""
  let rawBytes = 0
  const snapshots: Record<string, Array<string>> = {}
  const pending = new Map((opts.snapshots ?? []).map((s) => [s.marker, s.label]))

  const checkMarkers = (): void => {
    if (pending.size === 0) return
    const text = collectGrid(xterm).join("\n")
    for (const [marker, label] of pending) {
      if (text.includes(marker)) {
        snapshots[label] = collectGrid(xterm) // 抓当时快照（driver 尚未 clear）
        pending.delete(marker)
      }
    }
  }

  const terminal = new Bun.Terminal({
    name: "xterm-256color",
    cols,
    rows,
    data(_t, data) {
      rawBytes += data.byteLength
      const text = decoder.decode(data, { stream: true })
      raw += text
      // 串行写 → 每次解释完检查 marker（读点在 write 链上，顺序一致）。
      writes = writes.then(() => writeXterm(xterm, text)).then(checkMarkers)
    },
  })
  terminal.ref()

  const proc = Bun.spawn(["bun", "run", opts.driver], {
    cwd: "/home/xp/src/copilot-api-js",
    env: { ...process.env, FORCE_COLOR: "0", TERM: "xterm-256color", ...opts.env },
    terminal,
  })

  const timers: Array<ReturnType<typeof setTimeout>> = []
  for (const k of opts.keys ?? []) timers.push(setTimeout(() => terminal.write(k.bytes), k.at))
  // resize 串行插入 write 链：resize 边界排在「此刻已排队的输出解释之后」（GPT HIGH）。
  for (const r of opts.resizes ?? [])
    timers.push(
      setTimeout(() => {
        writes = writes.then(() => {
          terminal.resize(r.cols, r.rows)
          xterm.resize(r.cols, r.rows)
        })
      }, r.at),
    )

  const timeoutMs = opts.timeoutMs ?? 15_000
  let timedOut = false
  let exitCode = -1
  try {
    exitCode = await Promise.race([
      proc.exited,
      Bun.sleep(timeoutMs).then(() => {
        timedOut = true
        proc.kill() // 只 kill 本 harness 持有的 pid
        return proc.exited // kill 后仍 await 真正退出（GPT HIGH：别跳过资源清理）
      }),
    ])
  } finally {
    for (const t of timers) clearTimeout(t)
    // drain：等已排队字节全部解释，再关资源（GPT HIGH：别用裸 sleep 猜排空）。
    await writes
    const tail = decoder.decode()
    if (tail) {
      raw += tail
      await writeXterm(xterm, tail)
      checkMarkers()
    }
    terminal.close()
  }
  const grid = collectGrid(xterm)
  const allText = grid.join("\n")
  xterm.dispose()
  if (timedOut) throw new Error(`driver ${opts.driver} pid ${proc.pid} timed out after ${timeoutMs}ms`)
  return { grid, allText, rawText: raw, snapshots, rawBytes, exitCode }
}
```

- [ ] **Step 3: 写管线自证测试**

Create `tests/tui/pty/harness.pty.test.ts`（纯 xterm 红绿对照，证缺号 oracle 有牙）：

```typescript
import { describe, expect, test } from "bun:test"
import { Terminal } from "@xterm/headless"

import { collectGrid, missingNumbers, writeXterm } from "./harness"

describe("pty harness 管线自证", () => {
  test("Bun.Terminal 存在（缺依赖硬 fail 前提）", () => {
    expect(typeof Bun.Terminal).toBe("function")
  })

  test("scrollback oracle 红绿：满编号绿、缺号精确报出", async () => {
    const mk = async (drop: Set<number>): Promise<string> => {
      const term = new Terminal({ cols: 80, rows: 6, scrollback: 2000, allowProposedApi: true, convertEol: true })
      const payload = Array.from({ length: 40 }, (_, i) => i + 1)
        .filter((n) => !drop.has(n))
        .map((n) => `PROBE-LOG-${String(n).padStart(4, "0")}\n`)
        .join("")
      await writeXterm(term, payload)
      const text = collectGrid(term).join("\n")
      term.dispose()
      return text
    }
    expect(missingNumbers(await mk(new Set()), "PROBE-LOG", 40)).toEqual([])
    expect(missingNumbers(await mk(new Set([7, 19, 33])), "PROBE-LOG", 40)).toEqual([7, 19, 33])
  })
})
```

- [ ] **Step 4: 跑测试证通过**

Run: `bun test tests/tui/pty/harness.pty.test.ts`
Expected: 全 PASS（Bun.Terminal 存在、绿满编号、红精确报 [7,19,33]）。`@xterm/headless` 未装 → import 抛错整文件 fail（正是「缺依赖硬 fail」期望）。

- [ ] **Step 5: 接编排脚本**

Modify `package.json`（第 58 行 `test:ci` + 新增 `test:pty`）：
```json
    "test:ci": "bun run test:backend && bun run test:pty",
    "test:pty": "bun test .pty.test",
```
（`test:backend` glob 不含 `.pty.test`，日常 `bun test` 不跑 pty；`test:ci` 显式追加防静默失效。）

- [ ] **Step 6: 验证 + 提交**

Run: `bun run test:pty`
Expected: harness.pty.test.ts 全 PASS。
```bash
git add -- package.json bun.lock tests/tui/pty/harness.ts tests/tui/pty/harness.pty.test.ts
git commit -m "test(tui): PTY 整屏测试脚手架 — harness(握手快照+串行resize) + @xterm/headless + test:pty"
```

---

## Task 1: 不变量① 不吞行（读末态 scrollback，clear 不擦滚动日志）

**Files:**
- Create: `tests/tui/pty/drivers/log-stream.ts`
- Test: `tests/tui/pty/no-eaten-lines.pty.test.ts`
- 红样本破坏点: `src/lib/tui/render/region.ts:133-137`（scroll-before-grow）

**Interfaces:**
- Consumes: `runDriver`, `missingNumbers`（Task 0）。
- Produces: driver `log-stream.ts`，env `DRIVER_LOGS`(默认40)/`DRIVER_MS`(默认60)/可选 `SNAP_MARKER`（进 panel 后发一条 marker 日志，供 Task 2 复用）。

- [ ] **Step 1: 写 driver（提升自 exp/tui-rawmode/pty_selftest_driver.ts）**

Create `tests/tui/pty/drivers/log-stream.ts`：

```typescript
/**
 * PTY driver：真 TerminalUi + 一个 in-flight request + 编号日志流 + space 切视图。
 * 收到 space 进 panel 时（若 env SNAP_MARKER 设）额外发一条 marker 日志供 harness 抓
 * 运行中快照。提升自 exp/tui-rawmode/pty_selftest_driver.ts。
 */
import { createBus } from "~/lib/observability"
import { TerminalUi } from "~/lib/tui"

const TOTAL = Number(process.env.DRIVER_LOGS ?? 40)
const INTERVAL = Number(process.env.DRIVER_MS ?? 60)
const SNAP_MARKER = process.env.SNAP_MARKER // 例："__SNAP__panel"

const bus = createBus()
const ui = new TerminalUi(bus, { stdout: process.stdout, stdin: process.stdin, isTTY: true })
const req = bus.scope("request")
const sys = bus.scope("system")

req.publish({
  kind: "request.created",
  ctx: { id: "req_pty_1", endpoint: "anthropic-messages", method: "POST", path: "/v1/messages", resolvedModel: "claude-sonnet-4-5", state: "streaming", startTime: Date.now(), queueWaitMs: 0 },
} as never)

// SNAP_MARKER：进 panel 稳定后（给切视图 + 重绘留时间）发一条 marker 日志。
if (SNAP_MARKER) {
  setTimeout(() => sys.publish({ kind: "system.log", logType: "info", message: SNAP_MARKER, time: Date.now() } as never), 900)
}

let n = 0
const timer = setInterval(() => {
  n++
  sys.publish({ kind: "system.log", logType: "info", message: `SELFTEST-LOG-${String(n).padStart(4, "0")}`, time: Date.now() } as never)
  if (n >= TOTAL) {
    clearInterval(timer)
    setTimeout(() => {
      ui.destroy()
      process.exit(0)
    }, 150)
  }
}, INTERVAL)
```

- [ ] **Step 2: 写测试**

Create `tests/tui/pty/no-eaten-lines.pty.test.ts`：

```typescript
import { describe, expect, test } from "bun:test"

import { missingNumbers, runDriver } from "./harness"

describe("① 不吞行：space 反复切视图时编号日志连续无缺号", () => {
  // 红样本：删 src/lib/tui/render/region.ts:133-137 的 scroll-before-grow →
  // 面板长高时底部日志被覆盖 → missingNumbers 报出缺号。
  // clear() 只擦 panel 区、不擦 scrollback 日志，故读末态 allText 正确。
  test("40 行日志 + 每 200ms space 切视图 → 无缺号（连跑 10 次）", async () => {
    for (let run = 0; run < 10; run++) {
      const keys = Array.from({ length: 15 }, (_, i) => ({ at: 250 + i * 200, bytes: " " }))
      const r = await runDriver({
        driver: "tests/tui/pty/drivers/log-stream.ts",
        env: { DRIVER_LOGS: "40", DRIVER_MS: "40" },
        keys,
      })
      expect(r.exitCode).toBe(0)
      expect(missingNumbers(r.allText, "SELFTEST-LOG", 40)).toEqual([])
    }
  }, 60_000)
})
```

- [ ] **Step 3: 跑测试证通过** — Run: `bun test tests/tui/pty/no-eaten-lines.pty.test.ts` → Expected PASS（10 次无缺号）。

- [ ] **Step 4: 红样本对照** — 临时注释 `region.ts:133-137` 的 scroll-before-grow 块 → 跑测试 Expected **FAIL**（报出缺号）→ 重新编辑恢复 → 跑测试 PASS。

- [ ] **Step 5: 提交**
```bash
git add -- tests/tui/pty/drivers/log-stream.ts tests/tui/pty/no-eaten-lines.pty.test.ts
git commit -m "test(tui): PTY 不变量① 不吞行 — scrollback 编号连续（红绿对照验 scroll-before-grow）"
```

---

## Task 2: 不变量② footer/panel 钉底（握手快照，不读末态）

**Files:**
- Test: `tests/tui/pty/footer-pinned.pty.test.ts`（复用 `drivers/log-stream.ts` 的 SNAP_MARKER）
- 红样本破坏点: `src/lib/tui/render/region.ts:186`（`panelContentString` 的 `panelTop = rows - panelHeight + 1`，panel 绝对绘制坐标）

**Interfaces:**
- Consumes: `runDriver`（Task 0）、`log-stream.ts` 的 SNAP_MARKER（Task 1）。

- [ ] **Step 1: 写测试（用握手快照读运行中网格，不读被 clear 擦过的末态）**

Create `tests/tui/pty/footer-pinned.pty.test.ts`：

```typescript
import { describe, expect, test } from "bun:test"

import { runDriver } from "./harness"

const PANEL_ROWS = 3 // TerminalUi panel 恒高 min(rows,3)；footer 内容在该区首行，余为 padding。

describe("② footer/panel 钉底：footer 内容在末 panel 区、滚动日志在其上", () => {
  // 红样本：改 src/lib/tui/render/region.ts:186 的 panelTop（如 `rows - panelHeight - 1`）→
  // panel 画到非物理末区 → footer 不在末 PANEL_ROWS 区 / 日志侵入该区。
  // 用 SNAP_MARKER 握手快照读 driver 未 destroy(clear) 前的网格（末态 footer 已被擦）。
  test("进 panel 后运行中快照：footer 在末 panel 区、日志不在该区", async () => {
    const r = await runDriver({
      driver: "tests/tui/pty/drivers/log-stream.ts",
      env: { DRIVER_LOGS: "40", DRIVER_MS: "50", SNAP_MARKER: "__SNAP__panel" },
      keys: [{ at: 250, bytes: " " }], // 进 panel，不再切回
      rows: 24,
    })
    expect(r.exitCode).toBe(0)
    const snap = r.snapshots["panel"]
    expect(snap).toBeDefined() // 握手成功（marker 抓到快照）
    const visible = snap.slice(-24)
    const panelZone = visible.slice(-PANEL_ROWS) // 末 3 行 = panel 区
    const aboveZone = visible.slice(0, -PANEL_ROWS)
    // footer 内容（在途 request 的 model 名）在 panel 区，不在其上的滚动区。
    expect(panelZone.some((l) => l.includes("claude-sonnet-4-5"))).toBe(true)
    expect(aboveZone.some((l) => l.includes("claude-sonnet-4-5"))).toBe(false)
    // 滚动日志在 panel 区之上，不侵入 panel 区。
    expect(panelZone.some((l) => l.includes("SELFTEST-LOG"))).toBe(false)
    expect(aboveZone.some((l) => l.includes("SELFTEST-LOG"))).toBe(true)
  }, 30_000)
})
```

- [ ] **Step 2: 跑测试证通过** — Run: `bun test tests/tui/pty/footer-pinned.pty.test.ts` → Expected PASS。（若 `PANEL_ROWS` 或 footer 文案不符，读 `src/lib/tui/render/panel.ts#panelContentRows` 与 `render/footer.ts#buildActiveFooter` 据实调——唯一允许的偏差修正。）

- [ ] **Step 3: 红样本对照** — 临时改 `region.ts:186` 为 `const panelTop = rows - panelHeight - 1`（panel 上移，不再钉物理末区）→ 跑测试 Expected **FAIL**（footer 落进 aboveZone / 日志侵入 panelZone）→ 重新编辑恢复 → PASS。

- [ ] **Step 4: 提交**
```bash
git add -- tests/tui/pty/footer-pinned.pty.test.ts
git commit -m "test(tui): PTY 不变量② footer 钉底 — 握手快照验 panel 区（红绿对照验 panelTop 绝对坐标）"
```

---

## Task 3: 不变量③ 退出干净还原（末态字节 + sentinel 落点重放）

**Files:**
- Create: `tests/tui/pty/drivers/detail-cycle.ts`（Task 3/4 共用）
- Test: `tests/tui/pty/clean-restore.pty.test.ts`
- 红样本破坏点: `src/lib/tui/terminal-ui.ts:1142`（`restoreTerminal` 的 `\x1b[?1049l`）与 `src/lib/tui/render/region.ts:229`（`clear()` 的 `SHOW_CURSOR` / `RESET_SCROLL_REGION`）

**Interfaces:**
- Consumes: `runDriver`, `writeXterm`（Task 0）。
- Produces: driver `detail-cycle.ts`，env `DRIVER_LIFETIME_MS`(默认1500)、`DETAIL_LOG_MS`(默认120)。整个 lifetime 持续发 `DETAIL-LOG-000N`；lifetime 到点 `ui.destroy()`（还原路径）后 exit。

- [ ] **Step 1: 写 detail-cycle driver**

Create `tests/tui/pty/drivers/detail-cycle.ts`：

```typescript
/**
 * PTY driver：真 TerminalUi，整个 lifetime 持续发编号日志（供 Task 4 数 detail 窗口
 * 内编号连续），lifetime 到点经 ui.destroy() 干净还原退出（Task 3 验 restoreTerminal
 * 的 alt-leave + region.clear() 字节）。harness 用 space→enter 带它进 detail 备用屏。
 */
import { createBus } from "~/lib/observability"
import { TerminalUi } from "~/lib/tui"

const LIFETIME = Number(process.env.DRIVER_LIFETIME_MS ?? 1500)
const LOG_MS = Number(process.env.DETAIL_LOG_MS ?? 120)

const bus = createBus()
const ui = new TerminalUi(bus, { stdout: process.stdout, stdin: process.stdin, isTTY: true })
const req = bus.scope("request")
const sys = bus.scope("system")

req.publish({
  kind: "request.created",
  ctx: { id: "req_pty_detail", endpoint: "anthropic-messages", method: "POST", path: "/v1/messages", resolvedModel: "claude-sonnet-4-5", state: "streaming", startTime: Date.now(), queueWaitMs: 0 },
} as never)

let n = 0
const timer = setInterval(() => {
  n++
  sys.publish({ kind: "system.log", logType: "info", message: `DETAIL-LOG-${String(n).padStart(4, "0")}`, time: Date.now() } as never)
}, LOG_MS)

setTimeout(() => {
  clearInterval(timer)
  ui.destroy() // restoreTerminal → alt-leave（若在 detail）+ region.clear()（SHOW_CURSOR）
  process.exit(0)
}, LIFETIME)
```

- [ ] **Step 2: 写测试（末态原始字节 + sentinel 重放落点）**

Create `tests/tui/pty/clean-restore.pty.test.ts`：

```typescript
import { describe, expect, test } from "bun:test"
import { Terminal } from "@xterm/headless"

import { runDriver, writeXterm } from "./harness"

describe("③ 退出干净还原：从 detail 态退出后回主屏、光标可见、无残留滚动区", () => {
  // 红样本 (a)：删 src/lib/tui/terminal-ui.ts:1142 的 `\x1b[?1049l` → 回不了主屏。
  // 红样本 (b)：改 src/lib/tui/render/region.ts:229，删 clear() 的 SHOW_CURSOR → 光标不还原。
  test("space→enter 进 detail 备用屏后退出：字节含 alt进/alt出/SHOW_CURSOR + 重放末态回主屏且 sentinel 落点正常", async () => {
    const r = await runDriver({
      driver: "tests/tui/pty/drivers/detail-cycle.ts",
      env: { DRIVER_LIFETIME_MS: "1400" },
      keys: [{ at: 250, bytes: " " }, { at: 500, bytes: "\r" }], // space→panel, enter→detail
    })
    expect(r.exitCode).toBe(0)
    // 光标可见性/备用屏进出只能验原始字节。
    expect(r.rawText).toContain("\x1b[?1049h") // 进过备用屏（真进了 detail）
    expect(r.rawText).toContain("\x1b[?1049l") // 退出回主屏
    expect(r.rawText).toContain("\x1b[?25h") // SHOW_CURSOR
    // 网格重放：把还原后的原始字节重放进新 xterm，写 sentinel，验其落点在正常全屏、
    // 不被残留滚动区截断（DECSTBM reset 正确）。
    const term = new Terminal({ cols: 80, rows: 24, scrollback: 2000, allowProposedApi: true })
    await writeXterm(term, r.rawText)
    expect(term.buffer.active.type).toBe("normal") // 回主屏非备用屏
    await writeXterm(term, "\x1b[24;1HRESTORE-SENTINEL") // 定位末行写 sentinel
    const grid: Array<string> = []
    for (let i = 0; i < term.buffer.active.length; i++) grid.push(term.buffer.active.getLine(i)?.translateToString(true) ?? "")
    // sentinel 应完整落在网格里（滚动区未把它截断/困住）。
    expect(grid.some((l) => l.includes("RESTORE-SENTINEL"))).toBe(true)
    term.dispose()
  }, 30_000)
})
```

- [ ] **Step 3: 跑测试证通过** — Run: `bun test tests/tui/pty/clean-restore.pty.test.ts` → Expected PASS。（若 rawText 无 `\x1b[?1049h`，说明未真进 detail：读 `terminal-ui.ts` onInput/renderDetail、调键序 `at` 时机——判据是 rawText 含 alt-enter。）

- [ ] **Step 4: 红样本对照（两点各验）**
  - (a) 临时删 `terminal-ui.ts:1142` 的 `this.stdout.write("\x1b[?1049l")` → 跑测试 Expected **FAIL**（`buffer.type` 非 normal + rawText 缺 alt-leave）→ 恢复。
  - (b) 临时改 `region.ts:229`，删写串里的 `+ SHOW_CURSOR` → 跑测试 Expected **FAIL**（rawText 缺 `\x1b[?25h`）→ 恢复。
  - 最后跑一次 Expected PASS。

- [ ] **Step 5: 提交**
```bash
git add -- tests/tui/pty/drivers/detail-cycle.ts tests/tui/pty/clean-restore.pty.test.ts
git commit -m "test(tui): PTY 不变量③ 退出干净还原 — 字节oracle+sentinel落点（红绿对照验 alt-leave/SHOW_CURSOR）"
```

---

## Task 4: 不变量④ 切 detail 不覆盖底部日志（detail 窗口 marker 界定）

**Files:**
- Test: `tests/tui/pty/detail-no-clobber.pty.test.ts`（复用 `drivers/detail-cycle.ts`）
- 红样本破坏点: `src/lib/tui/terminal-ui.ts:1103`（`exitDetail` 的 `flushReplayQueue()`）

**Interfaces:**
- Consumes: `runDriver`, `missingNumbers`（Task 0）、`detail-cycle.ts`（Task 3，整 lifetime 每 `DETAIL_LOG_MS` 发一条）。

**关键（GPT BLOCK）**：进 detail 前已直接渲染的日志删 flushReplayQueue 也不缺，红样本不触发。必须断言**确实在 detail 窗口内产生**的编号段。detail 窗口 = enter(500ms) 到 escape(1500ms)，每 100ms 一条 → 约第 5–14 条在窗口内。断言这段无缺号。

- [ ] **Step 1: 写测试**

Create `tests/tui/pty/detail-no-clobber.pty.test.ts`：

```typescript
import { describe, expect, test } from "bun:test"

import { missingNumbers, runDriver } from "./harness"

describe("④ 切 detail 不覆盖底部日志：detail 期间日志退出后完整回放", () => {
  // 红样本：删 src/lib/tui/terminal-ui.ts:1103 的 flushReplayQueue() →
  // detail 备用屏期间 printLog 排队的日志不回放 → scrollback 缺 detail 窗口编号段。
  test("detail 停留期间的日志（窗口内编号段）退出后无缺号（连跑 10 次）", async () => {
    for (let run = 0; run < 10; run++) {
      const r = await runDriver({
        driver: "tests/tui/pty/drivers/detail-cycle.ts",
        env: { DRIVER_LIFETIME_MS: "2000", DETAIL_LOG_MS: "100" },
        keys: [
          { at: 500, bytes: " " }, // panel
          { at: 700, bytes: "\r" }, // detail（第 ~7 条后进入）
          { at: 1500, bytes: "\x1b" }, // escape 回 panel（触发 flushReplayQueue）
        ],
      })
      expect(r.exitCode).toBe(0)
      // detail 窗口 = 700–1500ms，每 100ms 一条 → 第 8–15 条确在 detail 内产生（排队→回放）。
      // 只断言这段无缺号（进 detail 前的第 1–7 条不参与红样本，删 flush 不影响它们）。
      const missing = missingNumbers(r.allText, "DETAIL-LOG", 20).filter((n) => n >= 8 && n <= 15)
      expect(missing).toEqual([])
    }
  }, 60_000)
})
```

- [ ] **Step 2: 跑测试证通过** — Run: `bun test tests/tui/pty/detail-no-clobber.pty.test.ts` → Expected PASS。

- [ ] **Step 3: 红样本对照（关键——必须真 FAIL）** — 临时删 `terminal-ui.ts:1103` 的 `this.flushReplayQueue()` → 跑测试 Expected **FAIL**（第 8–15 条里 detail 窗口内的缺失）。若不 FAIL，说明键序时机没真把日志排进 replay 队列：读 `terminal-ui.ts:788-799`（printLog 的 detailActive 分支），确认 enter 后 `detailActive===true` 期间的日志走 `replayQueue.push`，据实调 `at`/窗口编号范围使红样本触发。恢复后跑 PASS。

- [ ] **Step 4: 提交**
```bash
git add -- tests/tui/pty/detail-no-clobber.pty.test.ts
git commit -m "test(tui): PTY 不变量④ 切 detail 不覆盖 — detail 窗口编号段回放完整（红绿对照验 flushReplayQueue）"
```

---

## Task 5: 不变量⑤ resize 重锚（中间快照断言孤儿行 + known-seam test.failing）

**Files:**
- Create: `tests/tui/pty/drivers/resize-anchor.ts`
- Test: `tests/tui/pty/resize-reanchor.pty.test.ts`
- 红样本破坏点: `src/lib/tui/render/region.ts:138-145`（`RESET_SCROLL_REGION` + 清旧 panel 孤儿行）
- known-seam: `docs/todo/deferred-backlog.md:11`

**Interfaces:**
- Consumes: `runDriver`, `missingNumbers`（Task 0，含 `resizes` + `snapshots`）。
- Produces: driver `resize-anchor.ts`，env `DRIVER_LOGS`/`DRIVER_MS`/`SNAP_MARKER`。resize 后由 harness 发 marker 抓中间快照。

**关键（GPT BLOCK）**：原 plan 删重锚后「后续 panel 覆盖旧 footer」会掩盖孤儿行，只查编号+末 footer 仍 PASS。必须抓 **resize 后、下次 grow 前的中间快照**，断言旧 panel 坐标已清空（无孤儿行残留在旧末区）。

- [ ] **Step 1: 写 resize-anchor driver**

Create `tests/tui/pty/drivers/resize-anchor.ts`：

```typescript
/**
 * PTY driver：真 TerminalUi + 编号日志流，供 harness 跑中 resize，验 resize 后 panel
 * 按新底重锚、旧 panel 无孤儿行。resize 后由 harness 触发 marker 抓中间快照。
 */
import { createBus } from "~/lib/observability"
import { TerminalUi } from "~/lib/tui"

const TOTAL = Number(process.env.DRIVER_LOGS ?? 40)
const INTERVAL = Number(process.env.DRIVER_MS ?? 50)
const SNAP_MARKER = process.env.SNAP_MARKER

const bus = createBus()
const ui = new TerminalUi(bus, { stdout: process.stdout, stdin: process.stdin, isTTY: true })
const req = bus.scope("request")
const sys = bus.scope("system")

req.publish({
  kind: "request.created",
  ctx: { id: "req_pty_resize", endpoint: "anthropic-messages", method: "POST", path: "/v1/messages", resolvedModel: "claude-sonnet-4-5", state: "streaming", startTime: Date.now(), queueWaitMs: 0 },
} as never)

// resize 后（~900ms，晚于 harness 的 700ms resize）发 marker，让 harness 抓 resize 后中间快照。
if (SNAP_MARKER) {
  setTimeout(() => sys.publish({ kind: "system.log", logType: "info", message: SNAP_MARKER, time: Date.now() } as never), 900)
}

let n = 0
const timer = setInterval(() => {
  n++
  sys.publish({ kind: "system.log", logType: "info", message: `RESIZE-LOG-${String(n).padStart(4, "0")}`, time: Date.now() } as never)
  if (n >= TOTAL) {
    clearInterval(timer)
    setTimeout(() => {
      ui.destroy()
      process.exit(0)
    }, 150)
  }
}, INTERVAL)
```

- [ ] **Step 2: 写测试（正测中间快照 + known-seam test.failing）**

Create `tests/tui/pty/resize-reanchor.pty.test.ts`：

```typescript
import { describe, expect, test } from "bun:test"

import { missingNumbers, runDriver } from "./harness"

const NEW_ROWS = 30

describe("⑤ resize 重锚", () => {
  // 红样本：注释 src/lib/tui/render/region.ts:138-145 的 RESET_SCROLL_REGION + 清旧 panel 行 →
  // resize 后旧 panel 行成孤儿残留在旧末区（24 行附近）→ 中间快照该区非空。
  test("非同帧 resize（先 resize、隔帧后 marker 抓中间快照）→ 无孤儿行 + 日志无缺号（连跑 10 次）", async () => {
    for (let run = 0; run < 10; run++) {
      const r = await runDriver({
        driver: "tests/tui/pty/drivers/resize-anchor.ts",
        env: { DRIVER_LOGS: "40", DRIVER_MS: "50", SNAP_MARKER: "__SNAP__postresize" },
        rows: 24,
        // 250ms 进 panel（先建 24 行 panel）→ 700ms resize 到 30 行 → driver 900ms 发 marker。
        keys: [{ at: 250, bytes: " " }],
        resizes: [{ at: 700, cols: 80, rows: NEW_ROWS }],
      })
      expect(r.exitCode).toBe(0)
      expect(missingNumbers(r.allText, "RESIZE-LOG", 40)).toEqual([])
      const snap = r.snapshots["postresize"]
      expect(snap).toBeDefined()
      const visible = snap.slice(-NEW_ROWS)
      // panel 应锚在新末区（末 3 行含 model），旧 24 行位置无孤儿 panel 残留。
      const panelZone = visible.slice(-3)
      expect(panelZone.some((l) => l.includes("claude-sonnet-4-5"))).toBe(true)
      // 旧末区（新屏里的倒数第 ~7 行附近，即旧 24 行 panel 曾在处）不应残留第二个 footer。
      const aboveOldBottom = visible.slice(0, -3)
      const footerCount = visible.filter((l) => l.includes("claude-sonnet-4-5")).length
      expect(footerCount).toBe(1) // 只有一个 footer（新底），无孤儿旧 footer
      void aboveOldBottom
    }
  }, 60_000)

  // known-seam（deferred-backlog.md:11）：region.ts:125-137 的 `rows===prev.rows` 守卫使
  // 「resize 与视图切换严格同帧」时 scroll-before-grow 跳过、MAY eat a bottom row。本 spec
  // 不修复、只可见化。test.failing 使其"当前失败"被记录、修复后反转提醒回收 backlog（绝不伪装 passing）。
  test.failing("同帧 resize+grow 不吞行（known-seam，暂不修复；修复后本测应转绿→回收 backlog）", async () => {
    // 同帧：resize 与 space 切视图同一时刻触发，命中守卫跳过分支。
    const r = await runDriver({
      driver: "tests/tui/pty/drivers/resize-anchor.ts",
      env: { DRIVER_LOGS: "40", DRIVER_MS: "50" },
      rows: 24,
      keys: [{ at: 700, bytes: " " }], // 与 resize 同帧
      resizes: [{ at: 700, cols: 80, rows: NEW_ROWS }],
    })
    expect(r.exitCode).toBe(0)
    expect(missingNumbers(r.allText, "RESIZE-LOG", 40)).toEqual([]) // 当前 known-seam 下可能吞行 → 预期 fail
  }, 60_000)
})
```

- [ ] **Step 3: 跑测试** — Run: `bun test tests/tui/pty/resize-reanchor.pty.test.ts` → Expected：正测 PASS（10 次无缺号 + footerCount===1）；`test.failing` 项显示为**预期失败**（bun test 里 `test.failing` 断言不成立时算通过、成立时算失败——若同帧其实不吞行则该项"意外通过"提醒回收）。（注：若 bun 的 `test.failing` 语义与预期不符，改用 `test` + 注释断言当前实际行为 + backlog 指针，确保它执行且状态可见，非 `test.todo` 空体。）

- [ ] **Step 4: 红样本对照** — 临时注释 `region.ts:138-145`（`RESET_SCROLL_REGION` 到清 `oldPanelTop` 循环）→ 跑正测 Expected **FAIL**（`footerCount>1` 孤儿 footer / 缺号）→ 重新编辑恢复 → PASS。

- [ ] **Step 5: 提交**
```bash
git add -- tests/tui/pty/drivers/resize-anchor.ts tests/tui/pty/resize-reanchor.pty.test.ts
git commit -m "test(tui): PTY 不变量⑤ resize 重锚 — 中间快照验孤儿行 + known-seam test.failing 哨兵"
```

---

## 收尾 Task: 全量跑 + 文档同步

- [ ] **Step 1: 全量 pty 连跑两遍** — Run: `bun run test:pty`（两遍）→ Expected 全 PASS（含各 10 次迭代），无 flake，known-seam 哨兵状态稳定。
- [ ] **Step 2: 确认编排** — Run: `bun run test:backend`（不含 pty）+ `bun run test:ci`（含 pty）→ Expected 分别正确。
- [ ] **Step 3: spec 头部标实施状态 + DESIGN.md** — spec 状态改「已实施（landed）」+ commit 范围；`docs/DESIGN.md` 若有测试布局表，加 `tests/tui/pty/` 一行（改动过存在性守卫则同步 L1 测试）。
- [ ] **Step 4: 提交文档**
```bash
git add -- docs/spec/2026-07-14-tui-pty-fullscreen-testing.md docs/DESIGN.md
git commit -m "docs: 标记 TUI PTY 整屏测试已实施 + 架构现状同步"
```

---

## Self-Review（写完对照 spec + GPT 复审 8 条）

**1. Spec coverage**：§2 选型→Task 0；§3 五不变量→Task 1-5；§4 编排→Task 0 Step 5 + Global Constraints；§5 位置→File Structure；§3③混合oracle→Task 3；§3⑤known-seam→Task 5 test.failing。全覆盖。

**2. GPT 复审 8 条落实**：
- BLOCK-1（destroy 后读末态 footer 已被 clear 擦）→ Task 2/5 改**握手快照**读运行中网格；Global Constraints 加「destroy 擦屏铁律」。
- BLOCK-2（Task2 红样本 bottom-2 不动 panel 绝对坐标）→ 红样本改破坏 `region.ts:186` panelTop。
- BLOCK-3（Task4 total=4 全在进 detail 前）→ 断言改 detail 窗口内第 8–15 条。
- BLOCK-4（Task5 没断言孤儿行）→ 加中间快照 `footerCount===1` 断言。
- BLOCK-5（Task3 声称 sentinel 却没写）→ Task 3 真写 `RESTORE-SENTINEL` 验落点。
- BLOCK-6（test.todo 空体永不执行）→ 改 `test.failing` 带真实复现体。
- HIGH-1（resize 未串 writes 链）→ harness resize 插入 `writes.then`。
- HIGH-2（固定 sleep 猜排空 + timeout 泄漏）→ harness try/finally 关资源、kill 后 await exited、`await writes` drain 替代裸 sleep。

**3. Placeholder scan**：红样本破坏点均确切 file:line + 恢复步骤；driver/harness 完整代码。Task 2/4/5 的「据实调整」均给判据（读指定源文件确认 PANEL_ROWS/时序/test.failing 语义），非放任占位。

**4. Type consistency**：`runDriver`/`RunDriverResult`(grid/allText/rawText/snapshots/rawBytes/exitCode)/`RunDriverOptions`(keys/resizes/snapshots) 在 Task 0 定义，Task 1-5 一致消费。driver env 键(`DRIVER_LOGS`/`DRIVER_MS`/`SNAP_MARKER`/`DRIVER_LIFETIME_MS`/`DETAIL_LOG_MS`)前后一致。

**5. 残留实施风险**（executor 注意）：① detail 键序 `at` 时机可能需按实际 onInput 微调，判据 rawText 含 `\x1b[?1049h`；② `test.failing` 的 bun 语义若不符，退回 `test` + 可见断言 + backlog 指针（勿用 test.todo）；③ PANEL_ROWS=3 若与 `panelContentRows` 实际不符据实调。
