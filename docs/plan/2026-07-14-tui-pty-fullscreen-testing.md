# TUI PTY 整屏测试 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 `src/lib/tui/` 的 raw-mode 编排层建立 PTY 整屏测试 oracle——用 `Bun.Terminal` + `@xterm/headless` 把真 `TerminalUi` 的输出字节解释成 rows×cols 网格 + scrollback,断言字节测证不了的整屏不变量(不吞行、footer 钉底、退出还原、切 detail 不覆盖、resize 重锚)。

**Architecture:** 一个复用 harness 模块(`tests/tui/pty/harness.ts`)封装「spawn 真 driver → Bun.Terminal 分配伪终端 → 喂键序列 → 输出喂 @xterm/headless → 读网格+scrollback 查缺号」。每个不变量一个真 `TerminalUi` driver 脚本(`tests/tui/pty/drivers/*.ts`)+ 一个 `.pty.test.ts`。每个测试内建红绿对照——正测断言不变量绿,并在注释里写明红样本破坏点(临时删该行 → 测试须变红)。

**Tech Stack:** Bun 1.3.14 内置 `Bun.Terminal`(伪终端);`@xterm/headless@6.0.0`(VT100 网格解释器,唯一新 devDep);纯 TypeScript;`bun test`。

## Global Constraints

（每个 task 隐含包含本节，值逐字来自 spec `docs/spec/2026-07-14-tui-pty-fullscreen-testing.md`）

- **Bun 版本固定 1.3.14**：`Bun.Terminal` 是相对新 API，PoC 只在此版本 + Linux 验过。
- **`@xterm/headless` 读 buffer 三前提**：构造传 `allowProposedApi: true`；等 `terminal.write(data, cb)` 的 cb 再读 buffer；遍历 `0..buffer.active.length-1`（含 scrollback，不只可见 rows）。
- **编号载荷零填充**：`SELFTEST-LOG-0007`（防 `-9` 被 `-90..99` 子串误配）；正则 `/PREFIX-(\d{4})/g` 收集后与 `range(1,N+1)` 求差。
- **缺依赖硬 fail 非 skip**：`@xterm/headless` 未装或 `Bun.Terminal` 不可用 → 测试报错失败，绝不静默 skip。
- **不碰 4141 主服务器**：driver 子进程只驱动 `TerminalUi` 跑事件、**不起任何服务**；超时只按 harness 持有的 `proc.pid` 精确 kill，绝不 `pkill`/`killall`。
- **时序场景连跑 ≥10 次**证确定性。
- **红绿对照铁律**：每个不变量的测试注释里写明红样本破坏点 file:line；实施 Step 里**实际执行一次**「临时破坏 → 跑测试须红并报出具体症状 → 恢复 → 跑测试须绿」。假绿测试比不测更糟。

---

## File Structure

- `package.json`（改）— 加 `@xterm/headless` devDep；加 `test:pty` script；`test:ci` 追加 `&& bun run test:pty`。
- `tests/tui/pty/harness.ts`（建）— 复用件：`runDriver(opts)` spawn 真 driver 经 Bun.Terminal、喂定时键序、输出喂 xterm、返回 `{ grid, allText, rawBytes, exitCode, findNumbers(prefix, total) }`；纯函数 `missingNumbers(allText, prefix, total)`。
- `tests/tui/pty/drivers/log-stream.ts`（建）— 真 `TerminalUi` + 一个 in-flight request + 编号日志流 + `space` 切视图（提升自 `exp/tui-rawmode/pty_selftest_driver.ts`）。
- `tests/tui/pty/drivers/detail-cycle.ts`（建）— 同上 + 支持 `space→enter→日志→escape` 进出 detail 备用屏。
- `tests/tui/pty/drivers/resize-anchor.ts`（建）— 同 log-stream + 响应 `SIGWINCH`/env 触发的 rows 变化。
- `tests/tui/pty/harness.pty.test.ts`（建）— Phase 0：证 harness 管线本身有牙（纯 xterm scrollback 红绿对照，无 driver）。
- `tests/tui/pty/no-eaten-lines.pty.test.ts`（建）— ① 不吞行。
- `tests/tui/pty/footer-pinned.pty.test.ts`（建）— ② footer 钉底。
- `tests/tui/pty/clean-restore.pty.test.ts`（建）— ③ 退出还原（混合 oracle）。
- `tests/tui/pty/detail-no-clobber.pty.test.ts`（建）— ④ 切 detail 不覆盖。
- `tests/tui/pty/resize-reanchor.pty.test.ts`（建）— ⑤ resize 重锚 + known-seam 哨兵。

**依赖顺序**：Phase 0（脚手架 + harness）→ 其余 Phase 各自独立，可任意序/并行。

---

## Task 0: 脚手架 — 依赖、编排、harness 管线自证

**Files:**
- Modify: `package.json`（scripts 段 `test:ci` 行 58；devDependencies 段）
- Create: `tests/tui/pty/harness.ts`
- Test: `tests/tui/pty/harness.pty.test.ts`

**Interfaces:**
- Produces:
  - `missingNumbers(allText: string, prefix: string, total: number): number[]` — 纯函数，从含 scrollback 的全文里数编号缺号。
  - `collectGrid(term: XtermTerminal): string[]` — 遍历 `0..buffer.active.length-1` 返回每行文本。
  - `writeXterm(term: XtermTerminal, data: string): Promise<void>` — 包 `term.write(data, cb)` 成 Promise。
  - `runDriver(opts: { driver: string; env?: Record<string,string>; keys?: Array<{ at: number; bytes: string }>; timeoutMs?: number; cols?: number; rows?: number }): Promise<{ grid: string[]; allText: string; rawBytes: number; exitCode: number }>` — spawn `bun run <driver>` 经 Bun.Terminal，按 `keys[].at`(ms) 定时 `terminal.write(bytes)`，输出喂 xterm，driver 退出后读网格。

- [ ] **Step 1: 隔离目录已验依赖，装进项目**

Run:
```bash
cd /home/xp/src/copilot-api-js && bun add -d @xterm/headless@6.0.0
```
Expected: `installed @xterm/headless@6.0.0`，`package.json` devDependencies 出现该条，`bun.lock` 更新。**不装 node-pty**（PoC 证其 bun 下 spawn 损坏）。

- [ ] **Step 2: 写 harness 模块**

Create `tests/tui/pty/harness.ts`（API 用法逐字来自已验 PoC `exp/poc-js-pty-grid/index.ts`）：

```typescript
/**
 * PTY 整屏测试复用件 — 用 Bun.Terminal 分配伪终端跑真 TerminalUi driver，
 * 输出喂 @xterm/headless 解释成网格+scrollback。见 spec
 * docs/spec/2026-07-14-tui-pty-fullscreen-testing.md。
 */
import { Terminal } from "@xterm/headless"

const COLS = 80
const ROWS = 24
const SCROLLBACK = 2000

type Xterm = InstanceType<typeof Terminal>

/** 遍历含 scrollback 的所有行（不只可见 rows）。 */
export function collectGrid(term: Xterm): Array<string> {
  const buffer = term.buffer.active
  const lines: Array<string> = []
  for (let i = 0; i < buffer.length; i++) {
    lines.push(buffer.getLine(i)?.translateToString(true) ?? "")
  }
  return lines
}

/** 等 write 的 callback 再返回（读 buffer 的前提）。 */
export function writeXterm(term: Xterm, data: string): Promise<void> {
  return new Promise((resolve) => term.write(data, resolve))
}

/** 纯函数：从含 scrollback 的全文里数 `<prefix>-0001..total` 的缺号。零填充防子串误配。 */
export function missingNumbers(allText: string, prefix: string, total: number): Array<number> {
  const re = new RegExp(`${prefix}-(\\d{4})`, "g")
  const found = new Set([...allText.matchAll(re)].map((m) => Number(m[1])))
  return Array.from({ length: total }, (_, i) => i + 1).filter((n) => !found.has(n))
}

export interface RunDriverOptions {
  /** driver 脚本相对项目根的路径，如 "tests/tui/pty/drivers/log-stream.ts"。 */
  driver: string
  env?: Record<string, string>
  /** 定时键：at 毫秒后向伪终端写 bytes（如 { at: 250, bytes: " " }）。 */
  keys?: Array<{ at: number; bytes: string }>
  timeoutMs?: number
  cols?: number
  rows?: number
}

export interface RunDriverResult {
  grid: Array<string>
  allText: string
  rawBytes: number
  exitCode: number
}

/** spawn 真 driver 经 Bun.Terminal，喂定时键，输出喂 xterm，退出后读网格。 */
export async function runDriver(opts: RunDriverOptions): Promise<RunDriverResult> {
  const cols = opts.cols ?? COLS
  const rows = opts.rows ?? ROWS
  const xterm = new Terminal({ cols, rows, scrollback: SCROLLBACK, allowProposedApi: true })
  const decoder = new TextDecoder()
  let writes = Promise.resolve()
  let rawBytes = 0
  const terminal = new Bun.Terminal({
    name: "xterm-256color",
    cols,
    rows,
    data(_t, data) {
      rawBytes += data.byteLength
      const text = decoder.decode(data, { stream: true })
      writes = writes.then(() => writeXterm(xterm, text))
    },
  })
  terminal.ref()
  const proc = Bun.spawn(["bun", "run", opts.driver], {
    cwd: "/home/xp/src/copilot-api-js",
    env: { ...process.env, FORCE_COLOR: "0", TERM: "xterm-256color", ...opts.env },
    terminal,
  })
  const timers = (opts.keys ?? []).map((k) => setTimeout(() => terminal.write(k.bytes), k.at))
  const timeoutMs = opts.timeoutMs ?? 15_000
  let exitCode: number
  try {
    exitCode = await Promise.race([
      proc.exited,
      Bun.sleep(timeoutMs).then(() => {
        proc.kill() // 只 kill 本 harness 持有的 pid，绝不 pkill
        throw new Error(`driver ${opts.driver} pid ${proc.pid} timed out after ${timeoutMs}ms`)
      }),
    ])
  } finally {
    for (const t of timers) clearTimeout(t)
  }
  await Bun.sleep(50)
  terminal.close()
  const tail = decoder.decode()
  if (tail) await writeXterm(xterm, tail)
  await writes
  const grid = collectGrid(xterm)
  const allText = grid.join("\n")
  xterm.dispose()
  return { grid, allText, rawBytes, exitCode }
}
```

- [ ] **Step 3: 写 harness 管线自证测试（先失败）**

Create `tests/tui/pty/harness.pty.test.ts`——证 harness 的缺号 oracle 有牙（纯 xterm 红绿对照，无 driver，快）：

```typescript
import { describe, expect, test } from "bun:test"
import { Terminal } from "@xterm/headless"

import { collectGrid, missingNumbers, writeXterm } from "./harness"

describe("pty harness 管线自证", () => {
  test("Bun.Terminal 存在（缺依赖硬 fail 的前提）", () => {
    expect(typeof Bun.Terminal).toBe("function")
  })

  test("scrollback oracle 红绿对照：满编号绿、缺号精确报出", async () => {
    // 屏幕仅 6 行、发 40 行编号 → 触发滚动，多数落 scrollback。
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
    // 绿：全 40 在，scrollback 生效（网格行数 > 6 可见行）。
    expect(missingNumbers(await mk(new Set()), "PROBE-LOG", 40)).toEqual([])
    // 红：人为丢 7/19/33 → oracle 必须精确报出这三个（证非恒绿）。
    expect(missingNumbers(await mk(new Set([7, 19, 33])), "PROBE-LOG", 40)).toEqual([7, 19, 33])
  })
})
```

- [ ] **Step 4: 跑测试证失败（模块未建时）→ 建后证通过**

Run: `bun test tests/tui/pty/harness.pty.test.ts`
Expected: 三个 test 全 PASS（Bun.Terminal 存在、绿满编号、红精确报 [7,19,33]）。若 `@xterm/headless` 未装 → import 抛错整文件 fail（这正是「缺依赖硬 fail」的期望行为）。

- [ ] **Step 5: 接编排脚本**

Modify `package.json`：`test:ci` 行（58）改为追加 pty，并新增 `test:pty`：
```json
    "test:ci": "bun run test:backend && bun run test:pty",
    "test:pty": "bun test .pty.test",
```
（`test:backend` 的 glob `.unit.test .it.test .http.test` 不含 `.pty.test`，故日常 `bun test`/`test:backend` 不跑 pty；`test:ci` 显式追加，避免静默失效。）

- [ ] **Step 6: 验证编排 + 提交**

Run: `bun run test:pty`
Expected: harness.pty.test.ts 全 PASS。
```bash
git add -- package.json bun.lock tests/tui/pty/harness.ts tests/tui/pty/harness.pty.test.ts
git commit -m "test(tui): PTY 整屏测试脚手架 — harness + @xterm/headless + test:pty"
```

---

## Task 1: 不变量① 不吞行

**Files:**
- Create: `tests/tui/pty/drivers/log-stream.ts`
- Test: `tests/tui/pty/no-eaten-lines.pty.test.ts`
- 红样本破坏点（不改，仅 Step 6 临时验证）: `src/lib/tui/render/region.ts:133-137`（scroll-before-grow）

**Interfaces:**
- Consumes: `runDriver`, `missingNumbers`（Task 0）。
- Produces: driver `tests/tui/pty/drivers/log-stream.ts`，读 env `DRIVER_LOGS`(默认 40)/`DRIVER_MS`(默认 60)，发编号日志 `SELFTEST-LOG-0001..N` + 一个 in-flight request（footer 有内容、footer 定时器保持运行使 collapsed 渲染），退出前 `ui.destroy()` + `process.exit(0)`。

- [ ] **Step 1: 写 driver（提升自 exp/tui-rawmode/pty_selftest_driver.ts）**

Create `tests/tui/pty/drivers/log-stream.ts`：

```typescript
/**
 * PTY driver：真 TerminalUi + 一个 in-flight request + 编号日志流 + space 切视图。
 * harness 喂 space 切 collapsed↔panel，同时数 SELFTEST-LOG 是否连续（不吞行）。
 * 提升自 exp/tui-rawmode/pty_selftest_driver.ts。
 */
import { createBus } from "~/lib/observability"
import { TerminalUi } from "~/lib/tui"

const TOTAL = Number(process.env.DRIVER_LOGS ?? 40)
const INTERVAL = Number(process.env.DRIVER_MS ?? 60)

const bus = createBus()
const ui = new TerminalUi(bus, { stdout: process.stdout, stdin: process.stdin, isTTY: true })
const req = bus.scope("request")
const sys = bus.scope("system")

req.publish({
  kind: "request.created",
  ctx: { id: "req_pty_1", endpoint: "anthropic-messages", method: "POST", path: "/v1/messages", resolvedModel: "claude-sonnet-4-5", state: "streaming", startTime: Date.now(), queueWaitMs: 0 },
} as never)

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

- [ ] **Step 2: 写测试（先失败——driver 不存在时 exitCode≠0）**

Create `tests/tui/pty/no-eaten-lines.pty.test.ts`：

```typescript
import { describe, expect, test } from "bun:test"

import { missingNumbers, runDriver } from "./harness"

describe("① 不吞行：space 反复切视图时编号日志连续无缺号", () => {
  // 红样本：删 src/lib/tui/render/region.ts:133-137 的 scroll-before-grow →
  // 面板长高时底部日志被覆盖 → missingNumbers 报出缺号。
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

- [ ] **Step 3: 跑测试证通过**

Run: `bun test tests/tui/pty/no-eaten-lines.pty.test.ts`
Expected: PASS，10 次迭代无缺号。

- [ ] **Step 4: 红样本对照——证 oracle 有牙**

临时编辑 `src/lib/tui/render/region.ts`，注释掉第 133-137 行的 scroll-before-grow 块（`if (rows === prev.rows && panelHeight > prev.panelHeight) { ... }`）。
Run: `bun test tests/tui/pty/no-eaten-lines.pty.test.ts`
Expected: **FAIL**，`missingNumbers` 报出非空缺号（底部行被覆盖吞掉）。
然后**用重新编辑恢复**该块（勿用 git revert，见 CLAUDE.md `no-destructive-workspace-loss`），再跑一次：
Run: `bun test tests/tui/pty/no-eaten-lines.pty.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add -- tests/tui/pty/drivers/log-stream.ts tests/tui/pty/no-eaten-lines.pty.test.ts
git commit -m "test(tui): PTY 不变量① 不吞行 — 编号日志含 scrollback 连续（红绿对照验 region scroll-before-grow）"
```

---

## Task 2: 不变量② footer/panel 钉底

**Files:**
- Test: `tests/tui/pty/footer-pinned.pty.test.ts`（复用 `drivers/log-stream.ts`）
- 红样本破坏点: `src/lib/tui/render/region.ts:151`（`const bottom = rows - panelHeight`）或 `:142`（`oldPanelTop`）

**Interfaces:**
- Consumes: `runDriver`（Task 0）、`drivers/log-stream.ts`（Task 1）。

- [ ] **Step 1: 写测试（先跑观察当前网格形状）**

Create `tests/tui/pty/footer-pinned.pty.test.ts`：

```typescript
import { describe, expect, test } from "bun:test"

import { runDriver } from "./harness"

describe("② footer/panel 钉底：footer 内容在末 N 行、滚动日志在其上", () => {
  // 红样本：改 src/lib/tui/render/region.ts:151 的 `bottom` 或 :142 的 oldPanelTop →
  // footer 漂移/被日志压 → 末行不再是 footer、或日志出现在末行。
  test("切到 panel 后，footer 锚在屏幕最后一行、上方是滚动日志", async () => {
    // 250ms 时 space 进 panel，让 footer/panel 常驻；不再切回。
    const r = await runDriver({
      driver: "tests/tui/pty/drivers/log-stream.ts",
      env: { DRIVER_LOGS: "30", DRIVER_MS: "50" },
      keys: [{ at: 250, bytes: " " }],
      rows: 24,
    })
    expect(r.exitCode).toBe(0)
    // grid 含 scrollback；可见屏是最后 24 行。footer 行含 request 的 model 或 "×"/耗时标记。
    const visible = r.grid.slice(-24)
    const lastNonBlank = [...visible].reverse().find((l) => l.trim() !== "") ?? ""
    // footer 由 buildActiveFooter 渲染，含在途 request 的 model 名。
    expect(lastNonBlank).toContain("claude-sonnet-4-5")
    // 且日志（SELFTEST-LOG）不应出现在最末一行（那是 footer 的位置）。
    expect(visible.at(-1) ?? "").not.toContain("SELFTEST-LOG")
  }, 30_000)
})
```

- [ ] **Step 2: 跑测试证通过**

Run: `bun test tests/tui/pty/footer-pinned.pty.test.ts`
Expected: PASS。（若 footer 文案与 `claude-sonnet-4-5` 不符，先读 `src/lib/tui/render/footer.ts#buildActiveFooter` 确认在途行实际文案，据实调整断言字符串——这是唯一允许的偏差修正。）

- [ ] **Step 3: 红样本对照**

临时改 `src/lib/tui/render/region.ts:151` 为 `const bottom = rows - panelHeight - 2`（footer 上移 2 行）。
Run: `bun test tests/tui/pty/footer-pinned.pty.test.ts`
Expected: **FAIL**（末行不再是 footer，或日志漏进末行区）。重新编辑恢复 `- panelHeight`，再跑 → PASS。

- [ ] **Step 4: 提交**

```bash
git add -- tests/tui/pty/footer-pinned.pty.test.ts
git commit -m "test(tui): PTY 不变量② footer 钉底 — footer 锚末行、日志在其上（红绿对照验 region bottom）"
```

---

## Task 3: 不变量③ 退出干净还原（混合 oracle）

**Files:**
- Create: `tests/tui/pty/drivers/detail-cycle.ts`（本 task 用其「进 detail 后退出」路径，Task 4 复用）
- Test: `tests/tui/pty/clean-restore.pty.test.ts`
- 红样本破坏点: `src/lib/tui/render/region.ts:229`(`clear()` 的 `SHOW_CURSOR`) 与 `src/lib/tui/terminal-ui.ts:1142`(`restoreTerminal` 的 `\x1b[?1049l`)

**Interfaces:**
- Consumes: `runDriver`（Task 0，需扩展返回 `rawText` 原始字节流——见 Step 1）。
- Produces: driver `detail-cycle.ts`，支持 env `ENTER_DETAIL=1` 时在收到第 2 个 space 后不切回而是等 enter 进 detail；本 task 只需它跑到 `ui.destroy()`（还原路径）后退出。

- [ ] **Step 1: 扩展 harness 暴露原始字节流**

Modify `tests/tui/pty/harness.ts`：`RunDriverResult` 加 `rawText: string`（累积的解码原始字节，未经 xterm）；在 `runDriver` 里累积 `let raw = ""` 于 `data` 回调（`raw += text`），返回时带上 `rawText: raw`。光标可见性只能从原始字节验（xterm buffer 不暴露），故需要它。

```typescript
// data 回调内追加：
      raw += text
// 返回对象追加：
    rawText: raw,
```
（`raw` 在函数顶部 `let raw = ""` 声明；`RunDriverResult` interface 加 `rawText: string`。）

- [ ] **Step 2: 写 detail-cycle driver**

Create `tests/tui/pty/drivers/detail-cycle.ts`：

```typescript
/**
 * PTY driver：真 TerminalUi，跑固定生命周期后经 ui.destroy() 干净还原退出。
 * 若 env ENTER_DETAIL=1，则在退出前已被 harness 用 space→enter 带进 detail 备用屏，
 * 用于验证「从 detail 态退出也能干净还原」（restoreTerminal 的 alt-leave 路径）。
 */
import { createBus } from "~/lib/observability"
import { TerminalUi } from "~/lib/tui"

const LIFETIME = Number(process.env.DRIVER_LIFETIME_MS ?? 1500)

const bus = createBus()
const ui = new TerminalUi(bus, { stdout: process.stdout, stdin: process.stdin, isTTY: true })
const req = bus.scope("request")
const sys = bus.scope("system")

req.publish({
  kind: "request.created",
  ctx: { id: "req_pty_detail", endpoint: "anthropic-messages", method: "POST", path: "/v1/messages", resolvedModel: "claude-sonnet-4-5", state: "streaming", startTime: Date.now(), queueWaitMs: 0 },
} as never)

// 少量日志，保持 footer 定时器活着。
let n = 0
const timer = setInterval(() => {
  n++
  sys.publish({ kind: "system.log", logType: "info", message: `DETAIL-LOG-${String(n).padStart(4, "0")}`, time: Date.now() } as never)
}, 120)

setTimeout(() => {
  clearInterval(timer)
  ui.destroy() // 还原路径：restoreTerminal → alt-leave（若在 detail）+ region.clear()（SHOW_CURSOR）
  process.exit(0)
}, LIFETIME)
```

- [ ] **Step 3: 写测试（混合 oracle：网格 type + sentinel + 原始字节 SHOW_CURSOR）**

Create `tests/tui/pty/clean-restore.pty.test.ts`：

```typescript
import { describe, expect, test } from "bun:test"

import { runDriver, writeXterm } from "./harness"
import { Terminal } from "@xterm/headless"

describe("③ 退出干净还原：从 detail 态退出后回主屏、光标可见、无残留滚动区", () => {
  // 红样本：删 src/lib/tui/terminal-ui.ts:1142 的 `\x1b[?1049l`（进不了主屏，buffer.type 仍 alternate）；
  // 或删 src/lib/tui/render/region.ts:229 clear() 的 SHOW_CURSOR（rawText 不含 \x1b[?25h）。
  test("space→enter 进 detail 备用屏后退出：buffer 回 normal + rawText 含 SHOW_CURSOR", async () => {
    const r = await runDriver({
      driver: "tests/tui/pty/drivers/detail-cycle.ts",
      env: { ENTER_DETAIL: "1", DRIVER_LIFETIME_MS: "1400" },
      // 250ms space(collapsed→panel)，500ms enter(panel→detail)；driver 1400ms 后 destroy 退出。
      keys: [{ at: 250, bytes: " " }, { at: 500, bytes: "\r" }],
    })
    expect(r.exitCode).toBe(0)
    // 光标可见性只能验原始字节：还原路径必发 SHOW_CURSOR。
    expect(r.rawText).toContain("\x1b[?25h")
    // 进过备用屏必发 enter-alt；退出必发 leave-alt（回主屏）。
    expect(r.rawText).toContain("\x1b[?1049h")
    expect(r.rawText).toContain("\x1b[?1049l")
    // 网格 oracle：把还原后的原始字节重放进一个新 xterm，末态 buffer 应为 normal（非 alternate）。
    const term = new Terminal({ cols: 80, rows: 24, scrollback: 2000, allowProposedApi: true })
    await writeXterm(term, r.rawText)
    expect(term.buffer.active.type).toBe("normal")
    term.dispose()
  }, 30_000)
})
```

- [ ] **Step 4: 跑测试证通过**

Run: `bun test tests/tui/pty/clean-restore.pty.test.ts`
Expected: PASS。（若 driver 未真正进 detail——`\x1b[?1049h` 不在 rawText——说明键序时机不对：读 `terminal-ui.ts` `onInput`/`renderDetail`，确认 enter 在 panel 视图才触发；据实调 `at` 时机。）

- [ ] **Step 5: 红样本对照（两个破坏点各验一次）**

(a) 临时删 `src/lib/tui/terminal-ui.ts:1142` 的 `this.stdout.write("\x1b[?1049l")` → 跑测试 Expected **FAIL**（`buffer.type` 仍 alternate 且 rawText 缺 leave-alt）；重新编辑恢复。
(b) 临时改 `src/lib/tui/render/region.ts:229`，从 `clear()` 的写串里删 `+ SHOW_CURSOR` → 跑测试 Expected **FAIL**（rawText 不含 `\x1b[?25h`）；重新编辑恢复。
最后跑一次 Expected PASS。

- [ ] **Step 6: 提交**

```bash
git add -- tests/tui/pty/harness.ts tests/tui/pty/drivers/detail-cycle.ts tests/tui/pty/clean-restore.pty.test.ts
git commit -m "test(tui): PTY 不变量③ 退出干净还原 — 混合 oracle(buffer.type+SHOW_CURSOR)（红绿对照验 alt-leave/clear）"
```

---

## Task 4: 不变量④ 切 detail 不覆盖底部日志

**Files:**
- Test: `tests/tui/pty/detail-no-clobber.pty.test.ts`（复用 `drivers/detail-cycle.ts`，但需其在 detail 期间持续发日志）
- 红样本破坏点: `src/lib/tui/terminal-ui.ts:1103`（`exitDetail` 的 `flushReplayQueue()`）——detail 期间 `printLog` 排队的日志靠它回放；删了则这些日志丢失（被吃）。

**Interfaces:**
- Consumes: `runDriver`, `missingNumbers`（Task 0）、`drivers/detail-cycle.ts`（Task 3，其在整个 lifetime 持续发 `DETAIL-LOG-000N`）。

- [ ] **Step 1: 写测试（先失败——文件不存在）**

Create `tests/tui/pty/detail-no-clobber.pty.test.ts`：

```typescript
import { describe, expect, test } from "bun:test"

import { missingNumbers, runDriver } from "./harness"

describe("④ 切 detail 不覆盖底部日志：detail 期间的日志退出后完整回放", () => {
  // 红样本：删 src/lib/tui/terminal-ui.ts:1103 的 flushReplayQueue() →
  // detail 备用屏期间 printLog 排队的日志不回放 → 退出后 scrollback 缺号。
  test("space→enter 进 detail、停留期间持续发日志、escape 回 panel → 日志无缺号（连跑 10 次）", async () => {
    for (let run = 0; run < 10; run++) {
      const r = await runDriver({
        driver: "tests/tui/pty/drivers/detail-cycle.ts",
        env: { ENTER_DETAIL: "1", DRIVER_LIFETIME_MS: "2000" },
        // space 进 panel → enter 进 detail → 停留(driver 持续发 DETAIL-LOG) → escape 回 panel。
        keys: [
          { at: 250, bytes: " " },
          { at: 500, bytes: "\r" },
          { at: 1500, bytes: "\x1b" },
        ],
      })
      expect(r.exitCode).toBe(0)
      // detail 期间(500–1500ms，每120ms一条)约 8 条日志排队；退出前应全部回放进 scrollback。
      // 用宽松下界：至少 DETAIL-LOG-0001..N 里 500ms 前已发的连续段无缺号。
      const missing = missingNumbers(r.allText, "DETAIL-LOG", 4) // 前 4 条（~480ms 内）必在
      expect(missing).toEqual([])
    }
  }, 60_000)
})
```

- [ ] **Step 2: 跑测试证通过**

Run: `bun test tests/tui/pty/detail-no-clobber.pty.test.ts`
Expected: PASS。（`total=4` 是保守下界，避开 driver 退出时机抖动；红样本仍能触发——删 flushReplayQueue 后 detail 期间[含前 4 条之后进入 detail 排队的]日志丢失。若要更强断言，读 driver 实际发出条数据实调 total。）

- [ ] **Step 3: 红样本对照**

临时删 `src/lib/tui/terminal-ui.ts:1103` 的 `this.flushReplayQueue()`。
Run: `bun test tests/tui/pty/detail-no-clobber.pty.test.ts`
Expected: **FAIL**（detail 期间排队日志不回放，缺号）。重新编辑恢复，再跑 → PASS。
（注：若 `total=4` 的下界太松导致红样本不 FAIL——因前 4 条在进 detail 前已直接渲染——把断言 total 提高到「detail 期间发出的条数」，即断言 detail 窗口内的编号段无缺号。实施者读 driver 时序据实定这个边界，确保红样本能触发。）

- [ ] **Step 4: 提交**

```bash
git add -- tests/tui/pty/detail-no-clobber.pty.test.ts
git commit -m "test(tui): PTY 不变量④ 切 detail 不覆盖底部日志 — replay 回放完整（红绿对照验 flushReplayQueue）"
```

---

## Task 5: 不变量⑤ resize 重锚 + known-seam 哨兵

**Files:**
- Create: `tests/tui/pty/drivers/resize-anchor.ts`
- Test: `tests/tui/pty/resize-reanchor.pty.test.ts`
- 红样本破坏点: `src/lib/tui/render/region.ts:138-145`（`RESET_SCROLL_REGION` + 清旧 panel 孤儿行）
- known-seam 引用: `docs/todo/deferred-backlog.md:11`（resize 撞视图切换同帧可能吞行）

**Interfaces:**
- Consumes: `runDriver`, `missingNumbers`（Task 0）。
- Produces: driver `resize-anchor.ts`，同 log-stream，但 harness 需在跑中改伪终端尺寸。`Bun.Terminal` 的 `resize(cols, rows)` 触发子进程 SIGWINCH；driver 的 `TerminalUi` 从 `process.stdout.rows` 读新高度（footer 定时器 ≤100ms 重锚）。

- [ ] **Step 1: 扩展 harness 支持跑中 resize**

Modify `tests/tui/pty/harness.ts`：`RunDriverOptions` 加 `resizes?: Array<{ at: number; cols: number; rows: number }>`；在 `runDriver` 里除 `keys` 定时器外，为每个 resize 加 `setTimeout(() => { terminal.resize(r.cols, r.rows); xterm.resize(r.cols, r.rows) }, r.at)`（Bun.Terminal 与 xterm **同时** resize，保持网格解释一致）。timers 数组一并 clearTimeout。

```typescript
// keys timers 之后追加：
  const resizeTimers = (opts.resizes ?? []).map((r) =>
    setTimeout(() => {
      terminal.resize(r.cols, r.rows)
      xterm.resize(r.cols, r.rows)
    }, r.at),
  )
// finally 里一并清理：for (const t of resizeTimers) clearTimeout(t)
```

- [ ] **Step 2: 写 resize-anchor driver**

Create `tests/tui/pty/drivers/resize-anchor.ts`（与 log-stream 相同，改前缀 `RESIZE-LOG`、日志更密以便 resize 期间有内容滚动）：

```typescript
/**
 * PTY driver：真 TerminalUi + 编号日志流，供 harness 在跑中 resize 伪终端，
 * 验证 resize 后 panel 按新底重锚、旧 panel 无孤儿行、日志不吞。
 */
import { createBus } from "~/lib/observability"
import { TerminalUi } from "~/lib/tui"

const TOTAL = Number(process.env.DRIVER_LOGS ?? 40)
const INTERVAL = Number(process.env.DRIVER_MS ?? 50)

const bus = createBus()
const ui = new TerminalUi(bus, { stdout: process.stdout, stdin: process.stdin, isTTY: true })
const req = bus.scope("request")
const sys = bus.scope("system")

req.publish({
  kind: "request.created",
  ctx: { id: "req_pty_resize", endpoint: "anthropic-messages", method: "POST", path: "/v1/messages", resolvedModel: "claude-sonnet-4-5", state: "streaming", startTime: Date.now(), queueWaitMs: 0 },
} as never)

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

- [ ] **Step 3: 写测试（正测绿 + known-seam 哨兵）**

Create `tests/tui/pty/resize-reanchor.pty.test.ts`：

```typescript
import { describe, expect, test } from "bun:test"

import { missingNumbers, runDriver } from "./harness"

describe("⑤ resize 重锚", () => {
  // 红样本：绕过 src/lib/tui/render/region.ts:138-145 的 RESET_SCROLL_REGION + 清旧 panel 行 →
  // resize 后旧 panel 孤儿行残留 / 日志被覆盖。
  test("非同帧 resize（先 resize、隔帧再切 panel）→ panel 按新底重锚、日志无缺号（连跑 10 次）", async () => {
    for (let run = 0; run < 10; run++) {
      const r = await runDriver({
        driver: "tests/tui/pty/drivers/resize-anchor.ts",
        env: { DRIVER_LOGS: "40", DRIVER_MS: "50" },
        // 600ms 时把 24 行 resize 到 30 行；800ms（隔帧）再 space 切 panel。
        resizes: [{ at: 600, cols: 80, rows: 30 }],
        keys: [{ at: 800, bytes: " " }],
        rows: 24,
      })
      expect(r.exitCode).toBe(0)
      expect(missingNumbers(r.allText, "RESIZE-LOG", 40)).toEqual([])
      // resize 后可见屏是最后 30 行；footer 仍锚末行（含 model 名）、无旧 panel 孤儿行。
      const lastNonBlank = [...r.grid.slice(-30)].reverse().find((l) => l.trim() !== "") ?? ""
      expect(lastNonBlank).toContain("claude-sonnet-4-5")
    }
  }, 60_000)

  // known-seam 哨兵：region.ts:125-137 的 `rows===prev.rows` 守卫使「resize 与视图切换严格同帧」
  // 时 scroll-before-grow 跳过、MAY eat a bottom row。这是已文档化窄缝
  // (docs/todo/deferred-backlog.md:11)，本 spec 不修复、只可见化。故标 todo：若哪天有人修了
  // 这个缝、此测意外可绿，提醒回收 backlog 条目。绝不伪装成 passing。
  test.todo("同帧 resize+grow 不吞行（known-seam，deferred-backlog.md:11，暂不修复）")
})
```

- [ ] **Step 4: 跑测试证通过**

Run: `bun test tests/tui/pty/resize-reanchor.pty.test.ts`
Expected: 正测 PASS（10 次无缺号 + footer 锚新底）；哨兵显示为 `todo`（不算 fail、不算 pass）。

- [ ] **Step 5: 红样本对照**

临时注释 `src/lib/tui/render/region.ts:138-145`（`RESET_SCROLL_REGION` 起到清 `oldPanelTop` 循环止）。
Run: `bun test tests/tui/pty/resize-reanchor.pty.test.ts`
Expected: 正测 **FAIL**（孤儿行残留或缺号）。重新编辑恢复，再跑 → PASS。

- [ ] **Step 6: 提交**

```bash
git add -- tests/tui/pty/harness.ts tests/tui/pty/drivers/resize-anchor.ts tests/tui/pty/resize-reanchor.pty.test.ts
git commit -m "test(tui): PTY 不变量⑤ resize 重锚 + known-seam 哨兵（红绿对照验 region 重锚清除）"
```

---

## 收尾 Task: 全量跑 + 文档同步

- [ ] **Step 1: 全量 pty 套件连跑**

Run: `bun run test:pty`
Expected: 全 PASS（含各 10 次迭代），哨兵 todo。再跑第二遍确认无 flake。

- [ ] **Step 2: 确认不拖慢默认集**

Run: `bun run test:backend`（应不含任何 `.pty.test`）+ `bun run test:ci`（应含 pty）。
Expected: `test:backend` 不跑 pty；`test:ci` 跑 pty。

- [ ] **Step 3: spec 头部标实施状态 + DESIGN.md 存在性守卫**

Modify `docs/spec/2026-07-14-tui-pty-fullscreen-testing.md` 头部状态改为「已实施（landed）」+ 落地 commit 范围。若 `docs/DESIGN.md` 有「活的架构现状」表且列测试布局，追加 `tests/tui/pty/` 一行。

- [ ] **Step 4: 提交文档**

```bash
git add -- docs/spec/2026-07-14-tui-pty-fullscreen-testing.md docs/DESIGN.md
git commit -m "docs: 标记 TUI PTY 整屏测试已实施 + 架构现状同步"
```

---

## Self-Review（写完对照 spec）

**1. Spec coverage**：§2 选型→Task 0 依赖；§3 五个不变量→Task 1-5 逐一；§4 编排(test:ci/硬fail)→Task 0 Step 5 + Global Constraints；§5 位置(tests/tui/pty/)→File Structure；§3③混合oracle→Task 3；§3⑤known-seam哨兵→Task 5 test.todo。全覆盖。

**2. Placeholder scan**：无 TBD/TODO 占位；红样本破坏点均给出确切 file:line + 恢复步骤；driver/harness 均含完整代码。Task 2/4 里「据实调整断言」是**有界的偏差修正**（给了判据：读指定源文件确认文案/时序），非放任占位。

**3. Type consistency**：`runDriver`/`missingNumbers`/`collectGrid`/`writeXterm` 签名在 Task 0 定义，Task 1-5 一致消费;`RunDriverResult` 在 Task 3 加 `rawText`、Task 5 加 `resizes` 到 options，均标注为对 Task 0 模块的增量修改（Modify harness.ts）。driver env 键(`DRIVER_LOGS`/`DRIVER_MS`/`ENTER_DETAIL`/`DRIVER_LIFETIME_MS`)前后一致。

**4. 已知实施风险**（executor 注意）：① Bun.Terminal API 形状以 PoC `exp/poc-js-pty-grid/index.ts` 为准（已验）；② detail 键序时机(`at`)可能需按实际 onInput 处理微调，判据是 rawText 含 `\x1b[?1049h`；③ Task 4 的断言下界 total 须保证红样本能触发（读 driver 时序据实定）。
