# RFC: 交互式 TUI live query 面板 + 终端层重组

- **状态**：Draft（待 subagent 对抗评审 + PoC 回填 + 用户评审）
- **日期**：2026-07-10
- **类型**：大型结构重构（≥1000 行）+ 新交互特性 · RFC-first（skill `large-refactor`）
- **关联**：反转 [observability-rewrite](../archive/2606-landed-rfcs/observability-rewrite.md) 对 console 渲染件摆放的部分决定（须补 ADR）；复用 [DESIGN.md](../DESIGN.md)「Console UI」footer 宽度不变量；PoC 在 `exp/tui-rawmode/`

## 1. 动机（为什么）

TUI 的 live query 信息目前是 [console.ts](../../src/lib/observability/sinks/console.ts) 底部一条 `[<-->]` footer（刚做完宽度感知 + 按模型分组）。它是**纯输出、不可交互**——用户看得到在途请求，但无法展开细看、无法定位某条、无法在终端里中止一个卡住的请求。

用户要一个**交互式 live query UI**：折叠态是现在的分组 footer，按键**展开成底部多行面板**（在途请求逐条表格，实时刷新），可**上下选中某条**、**回车看终端详情**、**abort 在途请求**、**复制 req_id**，再按键收回。

顺带暴露一个组织缺陷：现有终端渲染件散落在 `observability/sinks/console.ts` + `observability/projections/`，而 observability-rewrite RFC 明确把 **ConsoleSink 定为「只读显示」**（原文 "read-only display"，且铁律「sinks 之间/routes→sinks 不得互引、不 mutate」）。交互 TUI 要**读 stdin + abort 请求**，是**控制** concern，塞进只读 sink 违反该不变量。故需要一次终端层重组。

预期结果：一个职责清晰的 `src/lib/tui/` 拥有终端交互界面；ConsoleSink 退回纯 bus 订阅者、只把事件 feed 给 tui 层；富交互（面板/选择/详情/abort）在 tui 层，横竖双向不破屏。

## 2. 目标 / 非目标

**目标**
- 折叠 footer ↔ 展开逐条面板 ↔ 单条 detail 三态，键盘驱动。
- 行级动作：高亮选中、回车详情、abort 在途请求（确认门）、复制 req_id。
- sticky 底部多行 region：日志在上滚动、region 恒贴底，**横（columns）× 竖（rows）双向 clamp**，绝不破屏。
- 终端安全：raw-mode 下 Ctrl-C 捕获转发优雅关闭；崩溃/退出必还原终端；非 TTY 自动降级为今天的 footer。
- 终端层重组：新建 `src/lib/tui/`，ConsoleSink 降为薄 bus→UI 适配器，恢复 sink 只读不变量。

**非目标**
- 不重建被解散的 `tracker.ts` god-module（D1/D2/D6/D7）——按职责拆开。
- 不做全屏 alternate-screen dashboard（用户已选「可展开面板」而非「htop 式全屏」）。
- 不替代 History Web UI / ui-v4 LiveDock——终端 detail 是即时快照，深挖仍去 Web。
- 不改 bus/事件协议、不改其它 sink（ws/history/telemetry）。

## 3. 架构（重组后）

```
src/lib/tui/
  terminal-ui.ts      # 单一终端所有者：持 active-requests 快照 + UI 状态(view/selectedIndex) + 渲染循环 + region 独占
  render/
    format.ts         # 纯格式化（从 observability/projections/ 迁入，含刚落地的 truncateToWidth）
    log-line.ts       #   同上（迁入）
    footer.ts         # 折叠态分组 footer 串构建（从 console.ts 抽出）
    panel.ts          # 展开态逐条表格 + detail 视图串构建（新）
    region.ts         # sticky 底部多行区域：光标管理 + 宽×高双向 clamp + overflow 指示（新）
  input/
    keys.ts           # raw-mode stdin → 归一化键事件（转义序列解析）（新）
  controller.ts       # 键事件 → UI 状态机迁移 + 派发 actions（新）
  actions.ts          # 副作用：经 manager.getContext(id).reapInFlight() abort；OSC52 复制 req_id（新）
```

ConsoleSink（`observability/sinks/console.ts`）瘦身：仍是 bus 订阅者（与 ws/history/telemetry 对称、经 `attachConsoleSink` 挂载），但**只把请求生命周期事件 feed 给 `terminal-ui`**，不自持渲染逻辑；非 TTY 时 terminal-ui 退回今天的 footer 行为。start.ts 在 ConsoleSink 之后、`isTTY` 门控下 attach `terminal-ui` 的输入控制器。

**单一所有者化解「双写者争同一 region」**：bus 事件（新请求到达/进度/终态）和键盘（选择/切换/动作）都要改同一片底部 region + 共享状态。`terminal-ui` 独占该 region 的渲染；ConsoleSink 与 controller 都只**feed 它**（前者喂请求事件、后者喂键事件），它统一 diff + 重画。这正是 `tracker.ts` D1 的正解——不是一个 class 全干，而是一个所有者 + 拆开的 render/input/state/actions 各自可测。

**边界自检**（brainstorming 原则）：每个单元一句话职责——`keys.ts`=字节→键事件；`controller.ts`=键事件→状态迁移；`region.ts`=状态→贴底多行字节；`actions.ts`=副作用；`terminal-ui.ts`=所有者胶合。互不读内部、可独立测。

## 4. 渲染模型：sticky 底部 region（承重）

把当前「单行 footer + `\x1b[2K\r`」推广为**持久底部区域（N 行）**：
- 日志打印协调：光标移到 region 顶 → 清 region → 打印日志行 → 在下方重画 region。即现有单行 clear/redraw 的 N 行版（`region.ts` 用相对光标移动 `\x1b[<n>F` + `\x1b[0J`，PoC-2 验证具体序列）。
- **横向**：每行 `truncateToWidth(columns-1)`——复用刚落地的宽度原语（迁入 `render/format.ts`），横不溢出。
- **竖向**：region 高 = `min(所需行数, rows - 预留)`，超出在面板内显 `+K more below`，`rows` 每次渲染读活值 + 监听 `resize`——竖不吃满屏、不顶飞日志。
- **双向 clamp 是硬不变量**：多行 region 一旦算错，错位的是**整屏**不是一行。故每次渲染同时感知 `columns` 和 `rows`，任一维超限即 clamp。
- 折叠 footer 是该 region 的 **N=1 退化**——同一套代码，不另起炉灶。
- 非 TTY：整个 region 逻辑短路，退回今天的分组 footer。

## 5. 交互模型

**状态机**（`view`）：`collapsed`（分组 footer + dim keybar 提示）→ `panel`（逐条表格 + 选中高亮）→ `detail`（单条全 ctx）；正交 `confirm-abort` 覆盖态。`selectedIndex` 在 panel/detail 维护。

**键位**（提议默认，PoC 后定稿）：
- `Space`/`Tab` 折叠↔展开 · `↑↓`（兼 `k/j`）移动选中 · `Enter` 详情 · `Esc` 逐级返回
- `x` abort 选中 → `confirm-abort`（`y` 确认 / 其它取消）· `c` 复制选中 req_id · `?` 切 help keybar
- `q` / `Ctrl-C`（字节 `0x03`）→ 转发 `handleShutdownSignal("SIGINT")`

**面板逐条行**（richest-data-flow）：req_id 短形 · model · method+path（截断）· elapsed · ↑req/↓resp bytes · events · block/tags/thinking 摘要。按最老排序（或后续加排序键）。

**detail 视图**：选中请求全 ctx 快照——req_id / method+path / client→resolved model / multiplier / state / elapsed / queueWait / ↑↓bytes / events / blockType / tags / thinking requested→effective / attempts。`Esc` 返回。

**abort 语义**：`x`→确认→`manager.getContext(id)?.reapInFlight()`（复用 reaper 取消路径，见 [manager.ts:207](../../src/lib/context/manager.ts#L207)、[types.ts:467](../../src/lib/context/types.ts#L467)）。已 settle 竞态→no-op + 提示。**诚实记账 open-question**：`reapInFlight` 现为 `reaper-cancel` provenance，用户手动 abort 宜给独立 `user-abort` provenance，否则 history 误记来源（见 §7）。

**复制 req_id**：OSC 52（`\x1b]52;c;<base64>\x07`）写终端剪贴板 + 短暂 flash；PoC-3 若某些终端不支持，退回「醒目显示 req_id 供鼠标选」。

## 6. 终端安全（承重风险）

- **Ctrl-C 铁律**：raw mode 下 `Ctrl-C` 不再产 SIGINT，以字节 `0x03` 进 stdin（PoC-1 确认）。controller 必须捕获 `0x03`（及 `0x04` Ctrl-D）转发 `handleShutdownSignal("SIGINT")`，否则**停不下服务器**。
- **终端还原**：退出/shutdown/崩溃都必须 `setRawMode(false)` + 显光标 + 清 region。挂进 shutdown 序列（[shutdown.ts](../../src/lib/shutdown.ts)）**且**兜底 `process.on("exit")`，绝不把用户终端留在 raw 态。
- **门控**：仅 `typeof process.stdin.setRawMode === "function" && process.stdout.isTTY` 才启用交互（非 TTY 下 `setRawMode`/`isTTY` 皆 `undefined`，实测 Bun 1.3.14）。pm2/docker/systemd/管道下自动关交互、零风险。
- **单一 stdin 消费者**：全仓无既有 stdin 使用，raw-mode 独占安全。

## 7. Open Questions（PoC + 决策待定）

| # | 问题 | 解法 | 阻塞面 |
|---|---|---|---|
| Q1 | Bun raw-mode 下 Ctrl-C 是否以 `0x03` 到达、SIGINT 是否仍触发 | PoC-1 `exp/tui-rawmode/raw-ctrlc.ts`（用户真终端跑） | 影响 §6 转发实现，不影响架构 |
| Q2 | sticky region 光标序列在 Bun 下无错位/闪烁、resize 即时重算 | PoC-2 `sticky-region.ts` | 影响 `region.ts` 具体转义序列 |
| Q3 | OSC 52 跨终端可行性 | PoC-3 `osc52-copy.ts`；否则退回显示 req_id | 仅影响复制实现 |
| Q4 | 用户手动 abort 的 history provenance | 新增 `user-abort` provenance vs 复用 `reaper-cancel` | 影响记账诚实度，P2 决 |

架构对 Q1-Q3 的结果**鲁棒**——它们改实现战术不改分层。

## 8. 分阶段（RFC 内 phase，各带 commit invariants）

- **P0 重组（行为等价）**：建 `src/lib/tui/`；`git mv` projections/{format,log-line} → tui/render/；从 console.ts 抽 footer 到 render/footer.ts；ConsoleSink 瘦身为薄适配器。**golden-fixture 预捕获**（改动前锁旧 console 输出证逐字等价）；每 commit 终态不变量、中间态不半坏（`large-refactor`）。纯搬家、零行为变化。
- **P1 只读面板**：`region.ts` 多行 sticky + 宽×高 clamp；`keys.ts`+`controller.ts` 展开/收回/导航；`panel.ts` 逐条表格 + detail。**无破坏性动作**。PoC-1/2 须先绿。
- **P2 破坏性动作**：abort（+ Q4 provenance 决策）+ req_id 复制（Q3）。确认门 + 终端还原兜底。

## 9. 测试

- `keys`：转义序列（`\x1b[A`↑ 等）→ 键事件。
- `controller`：键事件 → 状态迁移（fake 状态、无终端）。
- `region`：宽×高 clamp、截断、overflow 指示（冻结时钟 + 固定 columns/rows 的 fake stdout；复用 footer 测试 harness）。
- `actions`：abort → mock `manager.getContext` + `reapInFlight` 调用；复制 → OSC52 字节。
- Ctrl-C 转发：`0x03` → mock `handleShutdownSignal` 调用。
- 非 TTY：controller no-op、退回 footer。
- 还原：destroy → `setRawMode(false)` 调用。
- P0 回归：golden-fixture 证 console 输出逐字等价 + 既有 `tests/observability/console-*` 全绿。

## 10. 风险与回滚

- **风险**：raw-mode 误吞 Ctrl-C（§6 铁律 + PoC-1 缓解）；region 光标错位破屏（PoC-2 + 双向 clamp）；重组回归（P0 golden-fixture + 行为等价）。
- **回滚**：P0/P1/P2 独立可回退（各自 commit invariants，中间态不半坏）；交互层整体可经 `isTTY` 门控 + config 开关禁用，退回纯 footer。
- **ADR**：§3 反转 observability-rewrite 对 console 渲染件摆放的部分决定，须补 `docs/decisions/2026-07-10-tui-terminal-ownership.md` 记录「为何把控制/输入从只读 sink 剥到 tui 层」。

## 11. 不采纳

- 全屏 htop 式 dashboard：用户选「可展开面板」，全屏与日志流模型冲突、量级过大。
- 就地扩展 ConsoleSink：破坏只读 sink 不变量（本 RFC 动机之一）。
- 信号/config 切换替代键盘交互：用户明确要交互式 UI（本轮起点）。
