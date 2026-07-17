/**
 * PTY 终端网格测试复用件 — Bun.Terminal 伪终端跑真 TerminalUi driver，输出串行喂
 * @xterm/headless 解释成网格+scrollback。见 spec
 * docs/spec/2026-07-14-tui-pty-terminal-grid-testing.md。
 *
 * 握手快照：driver 退出时 region.clear() 擦掉 panel/footer，故「运行中空间关系」
 * 不能读末态。driver 在关键状态发唯一 marker 日志（如 "__SNAP__panel"），harness
 * 在串行 write 链上检测到该 marker 已解释进网格，即抓当时快照存入 result.snapshots。
 */
import { Terminal } from "@xterm/headless"
import path from "node:path"

const COLS = 80
const ROWS = 24
const SCROLLBACK = 2000

/** Current checkout/worktree root, derived from this harness instead of a developer-specific absolute path. */
export const PROJECT_ROOT = path.resolve(import.meta.dir, "../../..")

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
  const pendingMarkers = new Map((opts.snapshots ?? []).map((s) => [s.marker, s.label]))
  const armed = new Map<string, { label: string; at: number }>() // marker → {label, 检测到的时刻}
  let lastDataAt = Date.now()
  // 抓拍时机（GPT 复审 HIGH-1 + 实测修正）：marker 日志的 write 与紧随的 renderRegion() 是
  // printLog 里两个连续 stdout.write（terminal-ui.ts:805-806），PTY 可拆成不同 chunk。且日志
  // 持续流下「等数据静默」不可靠（静默点随机落在日志间隙）。故检测到 marker 后不立即抓，
  // 记 armedAt，等固定 SNAP_SETTLE_MS（覆盖 2+ 个 100ms footer 重绘周期）再抓，确保 panel
  // 重绘字节已到齐——不依赖静默，在持续日志流下确定。
  const SNAP_SETTLE_MS = 250 // 【实测校准】连跑 10 次快照稳定含 panel footer 即达标；不稳则调大。
  const QUIESCE_MS = 80 // 仅 finally drain 用（driver 退出后无日志，静默判定有效）。

  const detectMarkers = (): void => {
    if (pendingMarkers.size === 0) return
    const text = collectGrid(xterm).join("\n")
    for (const [marker, label] of pendingMarkers) {
      if (text.includes(marker)) {
        armed.set(marker, { label, at: Date.now() })
        pendingMarkers.delete(marker)
      }
    }
  }
  const snapArmedIfSettled = (): void => {
    if (armed.size === 0) return
    const now = Date.now()
    for (const [marker, { label, at }] of armed) {
      if (now - at < SNAP_SETTLE_MS) continue // 等 panel 重绘 settle
      snapshots[label] = collectGrid(xterm)
      armed.delete(marker)
    }
  }
  const quiesceTimer = setInterval(snapArmedIfSettled, 20)

  const terminal = new Bun.Terminal({
    name: "xterm-256color",
    cols,
    rows,
    data(_t, data) {
      rawBytes += data.byteLength
      lastDataAt = Date.now()
      const text = decoder.decode(data, { stream: true })
      raw += text
      // 串行写 → 每次解释完检测 marker（读点在 write 链上，顺序一致）；抓拍推迟到静默。
      writes = writes.then(() => writeXterm(xterm, text)).then(detectMarkers)
    },
  })
  terminal.ref()

  const proc = Bun.spawn(["bun", "run", opts.driver], {
    cwd: PROJECT_ROOT,
    env: { ...process.env, FORCE_COLOR: "0", TERM: "xterm-256color", ...opts.env },
    terminal,
  })

  const timers: Array<ReturnType<typeof setTimeout>> = []
  for (const k of opts.keys ?? []) timers.push(setTimeout(() => terminal.write(k.bytes), k.at))

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
    clearInterval(quiesceTimer)
    // drain（GPT 复审 HIGH-3）：proc.exited 后 PTY 仍可能有未投递尾字节。`await writes` 只
    // 排空已进 data 回调的写入，不保证 PTY EOF。故轮询「静默」——连续 QUIESCE_MS 无新字节
    // 视为排空——再关闭，替代裸 sleep 猜测。上限兜底防挂死。
    const drainDeadline = Date.now() + 2000

    while (Date.now() - lastDataAt < QUIESCE_MS && Date.now() < drainDeadline) {
      await Bun.sleep(20)
    }
    await writes
    const tail = decoder.decode()
    if (tail) {
      raw += tail
      await writeXterm(xterm, tail)
      detectMarkers()
    }
    // driver 已退出：任何仍 armed 的 marker 直接抓末态（settle 计时已无意义），
    // pending 未检测到的也退化为末态（driver 未静默即退的边缘）。
    for (const [, { label }] of armed) snapshots[label] = collectGrid(xterm)
    armed.clear()
    terminal.close()
  }
  const grid = collectGrid(xterm)
  const allText = grid.join("\n")
  xterm.dispose()
  if (timedOut) throw new Error(`driver ${opts.driver} pid ${proc.pid} timed out after ${timeoutMs}ms`)
  return { grid, allText, rawText: raw, snapshots, rawBytes, exitCode }
}
