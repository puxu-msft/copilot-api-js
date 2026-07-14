# Spec：TUI raw-mode 编排层的 PTY 终端网格测试

状态：**已实施 ①②③④⑤（landed 2026-07-14，commit fcfc91ea..6b870214）**——5 个不变量全部落地、各配红绿对照实测。⑤ resize 曾一度误判「无法测」降 backlog，收尾审计（GPT HIGH-2）推翻并复活（driver 内注入 mutable rows source 绕开 Bun 限制，见 §3⑤）；仅「生产尺寸来源链路」这一薄环节留 backlog。PoC 已实证、GPT 对抗审查已吸收（4 轮：设计 4 HIGH + plan 6→2→0 BLOCK + 收尾审计 2 HIGH）。
归属：本项目 TUI 测试策略。相关代码 `src/lib/tui/`、`tests/tui/pty/`，相关 PoC `exp/tui-rawmode/`、`exp/poc-js-pty-grid/`。

## 1. 问题与动机（why）

本项目的终端 TUI（`src/lib/tui/`，真 `TerminalUi` 类）**不是全屏应用**——它是「**底部活跃区 + 上方滚动历史**」：用 DECSTBM 滚动区（`\x1b[<top>;<bottom>r`）把 footer/panel 钉在屏底固定几行，日志在上方走终端**正常滚动、进 scrollback**（保留终端历史，不接管全屏）。唯一的全屏片段是按 enter 钻进的 detail 视图（`\x1b[?1049h` 备用屏），escape 即退回活跃区模式。

现状：TUI 测试几乎全是**字节流断言**——注入 fake stdout 捕获字符串，断言「发了 `\x1b[1;23r`」。典型文件 `tests/tui/terminal-coordinator.unit.test.ts`、`terminal-restore.unit.test.ts`、`panel-scroll-alignment.unit.test.ts`。

这些**证不了屏级空间关系**。「面板长高会不会覆盖吞掉底部日志行」「切 detail 视图会不会污染底部日志」「退出后终端有没有干净还原」这类真相，只存在于「字节被真终端按 VT100 语义摆进 rows×cols 网格 + scrollback 后的**空间关系**」里。字节断言对这类真相是 **oracle-blind**——字节里根本没有「覆盖」「吞行」这个概念，必须网格解释才浮现。

按「真相域」判据（一条测试只有当它断言的真相恰好落在该类型的真相域才配用该类型）：
- **字节流断言**的真相域 = 「**我方产出的确切字节/字符串**」：列内容、颜色、门控、映射表。（现有 `formatLogLine` 单测、`golden-fixture`、FORCE_COLOR 集，归位正确。）
- **PTY 屏级 oracle**的真相域 = 「**网格 + scrollback 的空间关系**」：不吞行、面板钉底、退出还原、切视图不覆盖、resize 重锚。**唯一**合格的真相域，字节测在此 oracle-blind。

本 spec 补齐第二类真相域的自动化 oracle，把「屏级空间关系」从「只能人肉重启真终端复验」升级为可复现的自动化测试。

## 2. 选型（PoC 已实证，见 `exp/poc-js-pty-grid/`）

| 层 | 采用 | 弃用 + 理由 |
|---|---|---|
| PTY | **`Bun.Terminal`**（Bun 1.3.14 内置） | ❌ `node-pty@1.1.0`——bun 下 spawn 语义损坏（子进程早退、stdout 非 TTY、`resize` EBADF；同 addon 在 Node v24 正常）；❌ Python `pty`——实证非必需 |
| 网格解释器 | **`@xterm/headless@6.0.0`**（唯一新 devDep） | ❌ `pyte`——换掉整个 Python 依赖 |
| harness | **纯 TypeScript**，跑在 bun | 与项目同栈，零跨语言编排 |

**净增依赖：只有 `@xterm/headless` 一个 devDependency。** 无 Python、无原生模块。

PoC 亲验（`bun exp/poc-js-pty-grid/index.ts driver`，主会话复跑一次确认）：真 `TerminalUi` driver 经 `Bun.Terminal` 端到端跑通、raw-mode 输入到达、scrollback 缺号红绿对照（删 7/19/33 精确报出）、连跑 10 次全绿、typecheck 过。40 行编号日志 `missing: []`、`bufferLength: 98`（含 scrollback）、exit 0。

**实现纪律（PoC 踩出来的，必须固化进测试）：**
1. `Bun.Terminal` 构造传 `cols/rows` + `data(terminal, bytes)` 回调喂 xterm。
2. `@xterm/headless` 的 `Terminal` 必须 `allowProposedApi: true`（读 buffer 的前提）。
3. 等 `terminal.write(bytes, callback)` 的 callback 再读 buffer。
4. 遍历 `0..buffer.active.length-1`（**含 scrollback**，不只可见 rows）；`getLine(i).translateToString(true)`。
5. 编号载荷零填充 `LOG-0007`（防 `LOG-9` 被 `LOG-90..99` 子串误配）；`re` 收集后与 `range(1,N+1)` 求差。
6. 超时只按 harness 持有的 `proc.pid` 精确 kill，绝不 `pkill`/`killall`（护 4141 主服务器）。
7. 时序场景连跑 ≥10 次证确定性。

## 3. 测什么屏级不变量（每个配红绿对照）

**两条铁律**：① **红绿对照**——临时破坏源码指定行 → 测试必须变红并报出具体症状 → 恢复变绿（证 oracle 有牙、非恒绿假测）；② 时序相关的连跑 ≥10 次。

| # | 屏级不变量 | 红样本（破坏点 file:line） | 成熟度 |
|---|---|---|---|
| ① | **不吞行**：编号日志含 scrollback 连续无缺号 | 删 `region.ts:133-137` 的 scroll-before-grow → 报出缺号 | 原型已跑通 |
| ② | **footer/panel 钉底**：footer 内容在末 N 行、滚动日志在其上 | 改 `region.ts:151`(`bottom`) 或 `:142`(`oldPanelTop`) → footer 漂移/被压 | 新增 |
| ③ | **退出干净还原**（混合 oracle，见下）| 删 `terminal-ui.ts:1141-1150` 的 alt-leave / `region.clear()` → 残留 | 新增 |
| ④ | **切 detail 不覆盖底部日志**：真进备用屏后底部日志不被吃 | 破坏 `terminal-ui.ts:1032-1051/1095-1104` 的 alt-screen entry/exit/replay | ✅ landed a8e9e543 |
| ⑤ | **resize 重锚**：rows 变化时重锚、旧 panel 无孤儿行 | 注释 `region.ts:138-145` 重锚清除 → 孤儿 footer | ✅ landed 6b870214 |

### ③ 退出还原是混合 oracle（GPT HIGH，采纳）

离开备用屏（`\x1b[?1049l`）**天然**恢复 primary buffer，且 `@xterm/headless` 公共 buffer API **不暴露光标可见性**——所以「末屏看起来正常」这个断言天然为真、抓不到「没正确还原」。**不能只断言末屏文本。** 正确 oracle 是三者组合：
- `terminal.buffer.active.type === "normal"`（回到主屏非备用屏）；
- 还原后写一个 sentinel、断言其**落点正确**（无残留滚动区把它截断）；
- **原始字节流**里含 `\x1b[?25h`（SHOW_CURSOR）——光标可见性只能验字节，网格验不了。

### ⑤ resize 重锚 —— landed（driver 内注入 mutable rows source 绕开 Bun 限制，2026-07-14 收尾审计复活）

初判「无法 PTY 测」曾降 backlog，收尾审计（GPT HIGH-2）推翻并经主会话亲验：**实测发现的 Bun 硬限制只堵死「生产尺寸来源」一环**——`Bun.Terminal.resize()` 不给子进程投递 SIGWINCH、子进程 `process.stdout.rows` 不刷新（探针 got=0 / rows 恒 24），故生产里靠 `process.stdout.rows` 感知真实 resize 的那一环 Bun 下无法自动化验。**但 `Region` 的重锚逻辑可测**：`TerminalUiOptions.rows` 支持函数式 `() => number`（`terminal-ui.ts:171`，`Region.getRows` 经它读值），driver 内部持 mutable `curRows`、发满日志后改值 → 下个 100ms 重绘 `Region` 读到新 rows → `geometryChanged` → 走重锚清除分支。红绿对照实测：绿态 footerCount===1、注释 `region.ts:138-145` 重锚清除 → footerCount===2（孤儿 footer 可见）。

**教训**（呼应 `verifying-authoritative-claims`「通过不自证」）：初判「无法测」是被 `process.stdout.rows` 一条生产路径堵死、漏了注入口的盲区；曾被「稳定 6/6 绿」误导（实为 resize 从没生效）——是收尾审计的独立探针 + 对 `rows: () => number` 注入路径的核实才纠回。**仍无法端到端测的「生产尺寸来源链路」**收窄进 `docs/todo/deferred-backlog.md`。known-seam（`region.ts:125-137` 同帧吞行）本就在 backlog:11，不受影响。

### 覆盖面其余项（GPT 挑「漏没漏」的回应）

- **超屏内容可滚 / 100ms 重画幂等**：合并进 ① 的载荷即可覆盖（大量编号行超屏触发滚动 = 天然测超屏；连跑多帧 = 天然测重画不累积垃圾）。不单列，但 harness 载荷要够长触发滚动。

## 4. 编排与运行契约

- 新后缀 **`.pty.test.ts`** + npm script **`test:pty`**（`bun test .pty.test`）。保留独立 script 便于单跑/调试。
- **接进 `test:ci`**（GPT HIGH，采纳）：本项目无 `.github/workflows`，默认 `test`/`test:ci` 都只跑 `test:backend`，`test:acceptance` **无人调用** → 只接 `test:acceptance` 会静默失效。故 `test:ci` = `test:backend && test:pty`；`test:acceptance` 保留为聚合入口。**不进** `test:backend`（pty spawn 子进程较重，不拖慢日常 `bun test`）。
- 缺依赖（`@xterm/headless` 没装 / `Bun.Terminal` 不可用）→ **硬 fail 非 skip**（防「静默跳过 = 假绿」，呼应 `verifying-authoritative-claims`）。
- 固定 Bun 1.3.14（PoC 只在此版本 + Linux 验过；`Bun.Terminal` 是相对新 API）。跨版本/跨 OS 未验，记为已知边界。
- driver 子进程**不起任何服务**（不碰 4141），只驱动 `TerminalUi` 跑事件；超时只按 `proc.pid` 精确 kill。

## 5. 位置与和现有测试的关系

- 正式化到 **`tests/tui/pty/`**：`harness.ts`（Bun.Terminal + xterm 复用件：spawn driver、喂键、读网格、查缺号）+ `drivers/`（各场景的真 TerminalUi driver）+ 各 `*.pty.test.ts`。`exp/tui-rawmode/`、`exp/poc-js-pty-grid/` 保留作 PoC 存档。
- 现有字节测（`terminal-coordinator` 等）**保留不删**——两类真相域并存：字节测 = 「我方产出的确切字节」，pty 测 = 「网格空间关系」。它们不冗余（字节测能定位「发了哪个 escape」，pty 测能定位「摆到网格上对不对」，互补）。
  - 注：GPT reviewer 未点名任何一条现有字节测为「屏级空间关系的错配近似应迁移」。若实施期发现某条字节测实为 oracle-blind 的屏级空间关系的错配近似，按 `choosing-test-type` 的迁移取向（先补 pty 覆盖再删/迁，零覆盖缺口）处理，不预先砍。

## 6. GPT 对抗审查吸收记录（record-not-adopted / adopted）

GPT reviewer（异模型第二双眼睛）verdict：**0 BLOCK / 4 HIGH，修 HIGH 后放行**。四条 HIGH **全部经主会话亲验 file:line 属实、全部采纳**：

1. **detail 恒绿**（`controller.ts:15` enter 才进 detail、driver 只发 space）→ §3 ④ harness 改 `space→enter→日志→escape`。
2. **退出还原弱 oracle**（xterm 不暴露光标可见性）→ §3 ③ 改混合 oracle（buffer.type + 字节层完整还原序正则含 SHOW_CURSOR；初版的 sentinel 落点断言经收尾审计证伪、已删）。
3. **漏 resize 重锚**（`region.ts:125-137` known-seam）→ §3 ⑤ 新增不变量（测重锚正逻辑，driver 内注入 mutable rows）。**同帧 known-seam 哨兵未加**——无法确定性构造「同帧」，仍仅留 backlog（见 §7）。
4. **test:pty 仍静默失效**（`package.json:58` test:ci 只跑 backend）→ §4 接进 test:ci。

未采纳项：无（四条全采纳）。设计从 4 个不变量增至 5 个，两个假测陷阱堵上，编排纠正。

## 7. 非目标 / 已知边界

- 不覆盖 macOS/Windows、非 Bun-1.3.14 版本、`node-pty` beta/fork（PoC 未验，不影响当前选型）。
- ⑤ 的**同帧 resize known-seam 未加哨兵**（`region.ts:125-137`）——harness 无法从两个同 at 的 timer 确定性构造「同帧」（键输入跨进程异步、源码只承诺 MAY 吞行，`test.failing` 会 flake），故不加自动化哨兵、仍仅留 `deferred-backlog.md:11`。⑤ 的正测覆盖的是 resize 重锚**主逻辑**（rows 变→重锚清除→无孤儿行），不含同帧窄缝。
- ⑤ 的**生产尺寸来源链路**（`process.stdout.rows` 感知真实终端 resize）在 Bun.Terminal 下无法端到端测——见 `deferred-backlog.md`。重锚逻辑本身已由注入 mutable rows source 覆盖。
- OSC52 剪贴板、视觉闪烁观感等 `exp/tui-rawmode/README.md` 标注「需真人真终端」的项，pty 验不了，不在本 spec。
