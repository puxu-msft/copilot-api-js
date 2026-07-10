# TUI 终端层重组（P0）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把终端渲染从 `observability/sinks/console.ts` 重组进新的 `src/lib/tui/` 层，`terminal-ui` 作为 bus 订阅者接管「请求事件 + system.log 两条 stdout 流」取代 ConsoleSink，**行为逐字等价**——为 P1/P2 的交互式面板铺路。

**Architecture:** 纯结构重组、零行为变化。golden-fixture 预捕获当前 stdout 字节流作等价 oracle；footer/syslog 渲染抽成 `tui/render/` 纯模块；`format.ts`/`log-line.ts` **留在** `observability/projections/`（多消费者共享叶子）；新增 ESLint 结构性边界钉死 tui 层依赖。

**Tech Stack:** Bun 1.3.14 + TypeScript（ESM、`verbatimModuleSyntax`）、`bun:test`、picocolors、string-width、consola、eslint（`no-restricted-imports` 分层边界）。

## Global Constraints

- **行为等价是硬不变量**：P0 结束时 stdout 字节流与重组前**逐字相同**（golden-fixture 断言）。不改任何渲染逻辑、footer 格式、system.log 协调、非 TTY 行为。
- **format.ts / log-line.ts 不移动**（留 `observability/projections/`，ADR 决策 2）；tui/render/ **import** 它们。
- **terminal-ui 直接订 bus**（`bus.subscribe`）取代 ConsoleSink，不是「ConsoleSink 转喂」（ADR 决策 1）。
- **commit invariants**：每个 task 的终态编译绿 + 既有测试全过 + golden 绿；中间态绝不半坏。
- **每 commit 显式 pathspec**（`git add -- <精确路径>`、`git commit -F <msgfile> -- <精确路径>`），conventional commits，不加模型署名。
- **不运行服务器**（no `bun run dev`/`start`）；可跑 `bun test` / `bun run typecheck` / `bunx eslint <path>`（无缓存）。
- **依赖 ADR 签字**：本计划实施前 [docs/decisions/2026-07-10-tui-terminal-ownership.md](../decisions/2026-07-10-tui-terminal-ownership.md) 须 Accepted。P0 不依赖任何 PoC 结果（那些是 P1/P2 交互渲染的）。

---

## File Structure（P0 终态）

```
src/lib/tui/
  terminal-ui.ts        # 新：TerminalUi 类（bus 订阅者 + stdout 唯一写者）= 重组后的 ConsoleSink
                        #   逻辑；订请求事件 + system.log；持 ActiveRequest map + footer 计时器。
                        #   导出 attachTerminalUi(bus, options)。
  render/
    footer.ts           # 新：从 console.ts 抽出的 footer 串构建（buildFooter/buildModelGroupSegments
                        #   /finalizeFooter，纯函数，入参为 active 快照 + columns getter）。
    syslog.ts           # 新：从 console.ts 抽出的 system.log 行渲染（onSystemLog 主体 + consolaPrefix）。
  index.ts              # 新：re-export attachTerminalUi + 类型（供 start.ts / 测试 import）。

src/lib/observability/
  projections/format.ts # 不动（共享叶子；tui/render import 它）
  projections/log-line.ts # 不动
  sinks/console.ts      # 删除（Task 4）
```

消费者改动：[start.ts:252](../../src/start.ts#L252) `attachConsoleSink`→`attachTerminalUi`；测试 import 从 `~/lib/observability/sinks/console` → `~/lib/tui`。

---

### Task 0: Golden-fixture 预捕获（等价 oracle 基线锁）

**Files:**
- Create: `tests/tui/golden-fixture.unit.test.ts`
- Create: `tests/tui/__fixtures__/console-golden.txt`（捕获产物，提交入库）
- Reference: [console.ts](../../src/lib/observability/sinks/console.ts)（当前被锁的渲染器）、[console-footer.unit.test.ts](../../tests/observability/console-footer.unit.test.ts)（capture harness 范式）

**Interfaces:**
- Produces: `renderGoldenScenario(sink 或 attach 函数): string` —— 驱动一组固定事件（`request.created`×3 不同 model + `stream_progress` + 一条 `system.log` + `request.completed` + footer 定时重画一拍）经渲染器，返回 stdout 字节流（含 CLEAR_LINE/ANSI，时间戳归一化）。P1+ 复用同一 scenario 断言等价。

- [ ] **Step 1: 写捕获测试（对当前 ConsoleSink）**

固定 `columns`、`isTTY:true`、冻结时钟（`setSystemTime`），复刻 console-footer 测试的 capture stdout。事件序列须**三流交织**：请求生命周期行 + footer 重画 + system.log 行（评审 BLOCK-1 要求非空正样本）。把 chunks join 后 `.replaceAll(/\d\d:\d\d:\d\d/g,"TT:TT:TT")` 归一化时间戳。

```ts
import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test"
import { createBus } from "~/lib/observability"
import { ConsoleSink } from "~/lib/observability/sinks/console" // Task 4 后改为 ~/lib/tui
import { readFileSync } from "node:fs"

const NOW = 1_700_000_000_000
function makeCapture() {
  const chunks: Array<string> = []
  const stdout = { write: (s: string) => (chunks.push(s), true), isTTY: true } as unknown as NodeJS.WritableStream
  return { stdout, text: () => chunks.join("").replaceAll(/\d\d:\d\d:\d\d/g, "TT:TT:TT") }
}
export function renderGoldenScenario(attach: (bus: ReturnType<typeof createBus>, o: unknown) => () => void): string {
  const cap = makeCapture()
  const bus = createBus()
  const detach = attach(bus, { stdout: cap.stdout, isTTY: true, columns: 80 })
  const req = bus.scope("request")
  const sys = bus.scope("system")
  const ctxA = { id: "a", endpoint: "anthropic-messages", method: "POST", path: "/v1/messages", resolvedModel: "claude-opus-4-8", state: "streaming", startTime: NOW - 3000, queueWaitMs: 0 } as never
  const ctxB = { ...ctxA, id: "b", resolvedModel: "gpt-5", startTime: NOW - 1000 } as never
  req.publish({ kind: "request.created", ctx: ctxA })
  req.publish({ kind: "request.created", ctx: ctxB })
  req.publish({ kind: "request.stream_progress", ctx: ctxA, bytesIn: 12_345, eventsIn: 42 } as never)
  sys.publish({ kind: "system.log", logType: "info", message: "golden line", time: NOW })
  req.publish({ kind: "request.completed", ctx: ctxA, entry: { id: "a", endpoint: "anthropic-messages", state: "completed" } } as never)
  detach()
  return cap.text()
}

const cleanups: Array<() => void> = []
beforeEach(() => setSystemTime(new Date(NOW)))
afterEach(() => { for (const c of cleanups.splice(0)) c(); setSystemTime() })

describe("golden fixture (P0 equivalence oracle)", () => {
  test("current renderer output matches the committed golden", () => {
    const attach = (bus: never, o: never) => { const { attachConsoleSink } = require("~/lib/observability/sinks/console"); return attachConsoleSink(bus, o) }
    const out = renderGoldenScenario(attach as never)
    const golden = readFileSync(new URL("./__fixtures__/console-golden.txt", import.meta.url), "utf8")
    expect(out).toBe(golden)
  })
})
```

- [ ] **Step 2: 生成 golden 产物**

先让测试**失败**（fixture 不存在）确认 scenario 触达渲染路径（正样本），再把当次 `out` 写进 `console-golden.txt`。用一次性脚本或 `test.only` 打印 `out` 后手工存盘；确认 fixture **非空**且含 `[<-->]`（footer）、`[INFO]`（system.log）、`[ OK ]`（completed）三类行。

Run: `bun test tests/tui/golden-fixture.unit.test.ts`
Expected: 先 FAIL（no fixture）→ 存盘后 PASS。

- [ ] **Step 3: Commit**

```bash
git add -- tests/tui/golden-fixture.unit.test.ts tests/tui/__fixtures__/console-golden.txt
git commit -F <msgfile> -- tests/tui/golden-fixture.unit.test.ts tests/tui/__fixtures__/console-golden.txt
# msg: test(tui): capture pre-reorg console golden fixture (P0 equivalence oracle)
```

---

### Task 1: 抽出 footer 渲染 → `tui/render/footer.ts`

**Files:**
- Create: `src/lib/tui/render/footer.ts`
- Modify: `src/lib/observability/sinks/console.ts`（删 `buildFooter`/`buildModelGroupSegments`/`finalizeFooter` 方法体，改 import + 委托）
- Test: 既有 `tests/observability/console-footer.unit.test.ts`（不改，回归证等价）

**Interfaces:**
- Produces: `buildActiveFooter(args: { active: ReadonlyArray<ActiveRequestView>, now: number, columns: number }): string` —— 纯函数，返回已 `pc.dim` + 截断的 footer 串（空则 `""`）。`ActiveRequestView = { ctx: RequestContextSnapshot, streamBytesIn?: number, streamEventsIn?: number, streamBlockType?: string }`（footer 只需这几个字段的只读视图）。
- Consumes: `truncateToWidth`/`formatDuration`/`formatStreamInfo`/`formatBytes`（from `~/lib/observability/projections/format`）。

- [ ] **Step 1: 写 footer.ts 单元测试**（把 console-footer 的 footer 断言下移为对 `buildActiveFooter` 的直接测，冻结时钟 + 固定 columns，断言分组 `model ×N`、宽度 `stringWidth ≤ columns-1`、`(resolving)` 桶）。代码见 console-footer.unit.test.ts 现有断言，改为直接调 `buildActiveFooter({ active, now: NOW, columns })`。

- [ ] **Step 2: 运行新测试确认 FAIL**（`buildActiveFooter` 未定义）。Run: `bun test tests/tui/render/footer.unit.test.ts` Expected: FAIL。

- [ ] **Step 3: 实现 footer.ts**——把 console.ts 的 `buildFooter`+`buildModelGroupSegments`+`finalizeFooter` 逐字搬进 `buildActiveFooter`（把 `this.active.values()` 换成入参 `args.active`、`this.getColumns()` 换成 `args.columns`、`Date.now()` 换成 `args.now`）。`ActiveRequestView` 类型 export。

- [ ] **Step 4: console.ts 改为委托**——`buildFooter()` 变 `return buildActiveFooter({ active: [...this.active.values()], now: Date.now(), columns: this.getColumns() })`；删除被搬走的私有方法；`finalizeFooter` 的调用点已内含于 `buildActiveFooter`。

- [ ] **Step 5: 运行 footer 单测 + console 回归 + golden**。Run: `bun test tests/tui/render/footer.unit.test.ts tests/observability/console-footer.unit.test.ts tests/tui/golden-fixture.unit.test.ts` Expected: 全 PASS（golden 逐字不变——证等价）。

- [ ] **Step 6: typecheck + lint + commit**。`bun run typecheck` && `bunx eslint src/lib/tui/render/footer.ts src/lib/observability/sinks/console.ts`（无缓存）。
```bash
git commit -F <msgfile> -- src/lib/tui/render/footer.ts tests/tui/render/footer.unit.test.ts src/lib/observability/sinks/console.ts
# msg: refactor(tui): extract footer rendering to tui/render/footer.ts
```

---

### Task 2: 抽出 system.log 渲染 → `tui/render/syslog.ts`

**Files:**
- Create: `src/lib/tui/render/syslog.ts`
- Modify: `src/lib/observability/sinks/console.ts`（`onSystemLog` 改委托、`consolaPrefix` 迁走）
- Test: 既有 `tests/observability/console-system-log.unit.test.ts`（不改，回归）

**Interfaces:**
- Produces: `renderSystemLogLine(event: { logType: string, message: string, time: number }): string` —— 返回 `consolaPrefix(type,date)` + message 的完整行（不含尾 `\n`）。`consolaPrefix` 作为内部函数或一并 export。
- Consumes: `formatTime`（from projections/format）、`picocolors`。

- [ ] **Step 1: 写 syslog.ts 单测**——断言 `renderSystemLogLine({logType:"info",message:"hi",time:NOW})` 以 `[INFO]` 前缀开头、含归一化时间、含 `hi`；各 logType（error/warn/success/debug/默认）前缀正确。

- [ ] **Step 2: 运行确认 FAIL**。Run: `bun test tests/tui/render/syslog.unit.test.ts` Expected: FAIL。

- [ ] **Step 3: 实现 syslog.ts**——把 console.ts 的 `consolaPrefix` 逐字搬入，加 `renderSystemLogLine` 包装（复刻 `onSystemLog` 里 `prefix ? prefix + " " + message : message` 逻辑）。

- [ ] **Step 4: console.ts 改委托**——`onSystemLog(event)` 变 `this.printLog(renderSystemLogLine(event))`；删本地 `consolaPrefix`。

- [ ] **Step 5: 运行 syslog 单测 + console-system-log 回归 + golden**。Run: `bun test tests/tui/render/syslog.unit.test.ts tests/observability/console-system-log.unit.test.ts tests/tui/golden-fixture.unit.test.ts` Expected: 全 PASS。

- [ ] **Step 6: typecheck + lint + commit**。
```bash
git commit -F <msgfile> -- src/lib/tui/render/syslog.ts tests/tui/render/syslog.unit.test.ts src/lib/observability/sinks/console.ts
# msg: refactor(tui): extract system.log rendering to tui/render/syslog.ts
```

---

### Task 3: 重组 ConsoleSink → `tui/terminal-ui.ts`（bus 订阅者）+ 切换 + 删旧

本 task 是 P0 的**原子切换**——终态一步到位绿（避免长期两份拷贝）。

**Files:**
- Create: `src/lib/tui/terminal-ui.ts`、`src/lib/tui/index.ts`
- Modify: `src/start.ts:252`、`tests/observability/{sink-ordering,console-footer,console-system-log,console-thinking}.unit.test.ts`、`tests/pipeline/pipeline-retry-tui.unit.test.ts`、`tests/helpers/test-bootstrap.ts`、`tests/tui/golden-fixture.unit.test.ts`（import 改 `~/lib/tui`）
- Delete: `src/lib/observability/sinks/console.ts`

**Interfaces:**
- Produces: `class TerminalUi`（重组后的 ConsoleSink，构造签名 + `ConsoleSinkOptions`→`TerminalUiOptions` 逐字保留：`stdout?`/`isTTY?`/`columns?`/`showActive?`/`silent?`）；`attachTerminalUi(bus, options?): () => void`；`formatThinkingTag`（保留 export，测试用）。`tui/index.ts` re-export 这些。
- Consumes: Task 1 `buildActiveFooter`、Task 2 `renderSystemLogLine`、projections/{format,log-line}、`~/lib/observability`（bus/事件类型/assertNever）。

- [ ] **Step 1: 创建 terminal-ui.ts**——把 console.ts 现有类**整体搬入**并改名 `TerminalUi`（footer/syslog 已在 Task 1/2 委托给 render/，故此处主要是搬运 + 改类名 + import 路径）。`renderFeatureTag`（穷尽守卫）随类搬入。`attachTerminalUi` 复刻 `attachConsoleSink`。

- [ ] **Step 2: 创建 index.ts**——`export { TerminalUi, attachTerminalUi, formatThinkingTag } from "./terminal-ui"`。

- [ ] **Step 3: 切换 start.ts**——`import { attachTerminalUi } from "./lib/tui"`；`attachConsoleSink(bus)` → `attachTerminalUi(bus)`。删 `attachConsoleSink` import。

- [ ] **Step 4: 批量改测试 import**——所有 `from "~/lib/observability/sinks/console"` → `from "~/lib/tui"`；`ConsoleSink` → `TerminalUi`、`attachConsoleSink` → `attachTerminalUi`（sink-ordering/console-footer/console-system-log/console-thinking/pipeline-retry-tui/test-bootstrap/golden-fixture）。golden-fixture 的 `attach` 闭包改 `attachTerminalUi`。**独立跨文件 Edit 消息内并行**。

- [ ] **Step 5: 删除 console.ts**。`git rm src/lib/observability/sinks/console.ts`。

- [ ] **Step 6: 全回归 + golden 逐字等价**。Run: `bun run typecheck` && `bun test tests/tui/ tests/observability/ tests/pipeline/pipeline-retry-tui.unit.test.ts` Expected: 全 PASS，**golden 逐字不变**（证 ConsoleSink→TerminalUi 零行为变化）。

- [ ] **Step 7: lint + commit（原子）**。`bunx eslint src/lib/tui/ src/start.ts`（无缓存）。
```bash
git commit -F <msgfile> -- src/lib/tui/terminal-ui.ts src/lib/tui/index.ts src/start.ts tests/observability/sink-ordering.unit.test.ts tests/observability/console-footer.unit.test.ts tests/observability/console-system-log.unit.test.ts tests/observability/console-thinking.unit.test.ts tests/pipeline/pipeline-retry-tui.unit.test.ts tests/helpers/test-bootstrap.ts tests/tui/golden-fixture.unit.test.ts src/lib/observability/sinks/console.ts
# msg: refactor(tui): relocate ConsoleSink to tui/terminal-ui as bus subscriber
```

---

### Task 4: ESLint 结构性边界（tui 层）+ L1 守卫测试

**Files:**
- Modify: `eslint.config.js`（加 `files: ["src/lib/tui/**/*.ts"]` 块）
- Create: `tests/tui/layer-boundaries.unit.test.ts`（L1 存在性守卫）

**Interfaces:**
- Produces: 无运行时导出；仅结构性约束 + 守卫测试。

- [ ] **Step 1: 加 eslint 边界块**——在 `eslint.config.js` 现有三个 `no-restricted-imports` 块之后追加（ADR 决策 3）：
```js
{
  files: ["src/lib/tui/**/*.ts"],
  rules: {
    "no-restricted-imports": ["error", { patterns: [
      { group: ["~/lib/observability/sinks", "~/lib/observability/sinks/*"],
        message: "tui/ must not import other sinks — subscribe to the bus (like FileSink). See ADR docs/decisions/2026-07-10-tui-terminal-ownership.md." },
    ] }],
  },
},
```
（注：`context/manager` + `~/lib/observability` 订阅**允许**，故不列入禁止组；`keys/controller/region/actions` 互不 import 的 path-group 约束在 P1 引入这些文件时补，P0 尚无它们。）

- [ ] **Step 2: 写 L1 守卫测试**——读 `src/lib/tui/` 各 `.ts` 源文本，断言：① 无文件 import `~/lib/observability/sinks/`（terminal-ui 自身除外——它 re-export 无、已删 console）；② P0 阶段 `setRawMode`/`process.stdin` 不应出现在 tui/（那是 P1）——`grep` 断言当前为 0（防提前泄漏）。用 `readFileSync` + 正则。

```ts
import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
function tuiFiles(): Array<string> { /* 递归列 src/lib/tui/**/*.ts 绝对路径 */ }
describe("tui layer boundaries (L1 guard)", () => {
  test("no tui file imports another observability sink", () => {
    for (const f of tuiFiles()) expect(readFileSync(f, "utf8")).not.toMatch(/from\s+["']~\/lib\/observability\/sinks\//)
  })
  test("P0 tui has no stdin/raw-mode usage yet (that is P1)", () => {
    for (const f of tuiFiles()) expect(readFileSync(f, "utf8")).not.toMatch(/setRawMode|process\.stdin/)
  })
})
```

- [ ] **Step 3: 运行守卫 + 全量 lint（无缓存）**。Run: `bun test tests/tui/layer-boundaries.unit.test.ts` && `bun run lint:all` Expected: PASS + eslint 净（新边界不误伤既有代码）。

- [ ] **Step 4: Commit**。
```bash
git commit -F <msgfile> -- eslint.config.js tests/tui/layer-boundaries.unit.test.ts
# msg: chore(tui): add structural eslint boundary + L1 guard for tui layer
```

---

### Task 5: P0 收尾——doc-sync + 合并态回归

**Files:**
- Modify: [docs/DESIGN.md](../DESIGN.md)（「Console UI」节 + 若有「活的架构现状」sink 行：ConsoleSink → TerminalUi/tui 层）、[docs/rfc/2026-07-10-interactive-tui-live-panel.md](../rfc/2026-07-10-interactive-tui-live-panel.md)（P0 头部标「已实施」）、本计划头部实施状态注解

- [ ] **Step 1: 全套件回归**。Run: `bun test tests/tui/ tests/observability/` && `bun run typecheck` && `bun run lint:all` Expected: 全绿。

- [ ] **Step 2: doc-sync + 跨文档 grep 验证**——`grep -rn "ConsoleSink\|sinks/console" docs/ src/ --include="*.md" --include="*.ts"` 确认活文档/代码无残留旧引用（archived RFC 除外）；DESIGN.md「Console UI」footer 段的 `ConsoleSink.finalizeFooter` 等引用更新为 `tui/render/footer.ts`。

- [ ] **Step 3: Commit**。
```bash
git commit -F <msgfile> -- docs/DESIGN.md docs/rfc/2026-07-10-interactive-tui-live-panel.md docs/plan/2026-07-10-tui-terminal-reorg-p0.md
# msg: docs(tui): sync DESIGN/RFC/plan for P0 terminal-layer reorg
```

---

## Self-Review

- **Spec 覆盖**：RFC §8（架构重组）+ §10 P0 全部映射到 Task 1-4；BLOCK-1（system.log 接管）→ Task 2 + Task 0 golden 三流交织；MAJOR-2（format/log-line 留 projections）→ File Structure + Task 1 只 import 不移动；MAJOR-3（ESLint 边界 + terminal-ui 直接订 bus）→ Task 3 + Task 4。P1/P2（交互/abort/region）**不在本计划**——那些依赖 PoC 结果。
- **占位符扫描**：无 TBD；golden fixture 内容在 Task 0 Step 2 生成（非占位，是运行产物）。
- **类型一致**：`buildActiveFooter`（Task 1）、`renderSystemLogLine`（Task 2）、`TerminalUi`/`attachTerminalUi`（Task 3）跨 task 引用名一致；`ConsoleSinkOptions`→`TerminalUiOptions` 字段逐字保留。
- **等价 oracle 贯穿**：Task 0 的 golden 在 Task 1/2/3 每步复跑，逐字不变 = 行为等价的独立证据（非自证）。

## Execution Handoff

见会话——P0 可在 ADR 签字后独立实施（不等 PoC）。P1/P2 计划待 PoC-2 结果（可能推翻交互模型）+ P0 落地后另写。
