# Spec: TUI 渲染模型 —— 恒定高度区 + detail 备用屏，消除 DECSTBM 几何 churn

- **状态**：Draft v2（待用户签字；v1 经两轮对抗审查 + 用户真终端实测重写）
- **日期**：2026-07-11
- **类型**：架构级修复（bug 根因驱动 + 渲染协调重构）
- **相关**：
  - 重访 ADR [tui-terminal-ownership](../decisions/2026-07-10-tui-terminal-ownership.md) 决策 4（region 渲染技术）
  - 承接 plan [tui-interactive-panel-p1](../plan/2026-07-11-tui-interactive-panel-p1.md)、[tui-terminal-reorg-p0](../plan/2026-07-10-tui-terminal-reorg-p0.md)
  - 根因 + 选型 PoC：`exp/tui-rawmode/log-coordination-regression.ts`（用户真终端实测裁决）
  - CLAUDE.md `empirical-verification` / `root-cause-over-patch` / `architecture-health-first`

## 0. 实测裁决记录（本 spec 的事实基础）

本 spec 的关键结论**均经用户真终端实测**，非文档推断（`empirical-verification`）：

| 断言 | 实测结果 |
|---|---|
| DECSTBM 几何变化吃行/留空/footer 泄漏（根因） | ✅ 三轮实测确认（视图切换 + `c` toggle 复现） |
| **MODE A（恒定高度区）** collapsed↔panel 接缝零 churn | ✅ 实测：狂按 space 无断号、无空行 gap |
| **MODE B（内联 footer + 按需区）** 接缝仍留空行 gap | ❌ 实测：scroll-before-establish 挡住吃行、但拆区留空行（3 行区→1 行内联本质有 2 行落差） |
| detail 进备用屏发 `\x1b[r` reset 边距 → 全屏可滚（C1 修复） | ✅ 实测：超屏 detail 全屏正常滚动 |
| detail 崩溃退出 alt-screen-aware（C2 修复） | ✅ 实测：`x` 模拟崩溃后 shell 回到干净正常屏 |
| detail 期间日志缓存、退出回放 | ✅ 实测：停留数秒的日志退出后回放进 scrollback |
| fix A 每拍重申明 DECSTBM 无闪烁、可自愈扰动 | ✅ 实测（v1 PoC `a` 档）+ terminal reviewer VT510 语义确认 |

## 1. 问题（What & Why）

### 1.1 症状（用户实测报告）

1. 默认底行在途请求行**间歇性变空**，"按几次 space 才恢复"，中途一闪 backfill log。
2. 按 space 切视图期间**日志行被吃**（如 `969→972→973`，970/971 丢失）。
3. 按 space 期间出现**空行 gap**，`[<-->]` footer **泄漏进滚动的日志流中间**（本该钉底）。

### 1.2 根因（三轮真终端 PoC 实测锁定）

**任何 DECSTBM 滚动区（`\x1b[<top>;<bottom>r`）的几何变化都会扰动日志流**：面板长大（滚动区缩小）→ 吃最新日志行；面板缩小（滚动区长大）→ 留空行 gap；重建滚动区 → 旧面板行变滚动内容 → footer 泄漏。

现有 `src/lib/tui/render/region.ts` 只在几何变时重发 DECSTBM，反使**同几何重绘无法自愈**扰动。069c2293 用"恒定高度 padding"堵掉了"**在途数变化**"这一路几何变，但**漏了视图切换**（collapsed N=1 / panel N=3 / detail N=可变，高度天然不同）——这是本 bug 直接来源。

### 1.3 为何不能只打补丁

三视图高度天然不同，"按视图 resize 滚动区"**本质上**无法消除 churn，须换渲染协调模型。**但换模型有多个候选，须实测选型**（§0 已裁决），不凭直觉。

## 2. 目标不变量（验收标准）

- **INV-1 零 churn**：任何视图切换 / 在途数变化 / help 切换 / 日志到达，**绝不**吃已上屏日志、**绝不**留空行 gap、**绝不**让 footer 泄漏进滚动流。
- **INV-2 恒定几何**：交互实例的 DECSTBM 滚动区高度**在整个生命周期恒定**（= `MAX_PANEL_ROWS`），只在**首次建立 / 终端 resize / detail 备用屏往返后重建**时改变，绝不随视图或在途数变。
- **INV-3 全协调三态**：所有对受控终端流的写入都经 region 感知的协调点；协调点区分**三态**（DECSTBM 区活跃 / detail 备用屏活跃 / 无区非交互内联），当前两处旁路直写（republish reentrant、FileSink error）被收编。
- **INV-4 自愈（manual-only 验收）**：panel 每次渲染重申明 DECSTBM，任何未预期扰动下一拍自愈。**此不变量只能真终端验证**（字节断言只能证"发了重申明"、证不了"愈合"，见 §5）。
- **INV-5 日志 durability + best-effort 回放**：日志 durability 由 **FileSink** 保证（始终写盘、一条不丢）；detail 备用屏期间到达的日志进**有上界队列**（`REPLAY_CAP` 行）、退出时 best-effort 回放进 scrollback（超上界丢最旧、durability 不受影响）。
- **INV-6 干净退出（含 detail 态）**：退出 / 崩溃 / shutdown-drain 必还原——reset 滚动区 + **若在 detail 备用屏则先 `\x1b[?1049l`** + 显光标。exit-hook 是承重还原点，须 alt-screen-aware。

### 症状 ↔ 不变量映射

症状 1-3 均归 DECSTBM 几何 churn → INV-1（+ INV-2 恒定几何、INV-4 自愈）。INV-5/INV-6 是**新模型（detail 备用屏）自身引入副作用**的防护（reviewer 确认：为自解法副作用加不变量是完整、非过度设计）。

## 3. 渲染模型：交互实例恒定高度区 + detail 备用屏

**核心：交互实例始终经 `Region.render`，滚动区高度恒定 `MAX_PANEL_ROWS`（=3）。** 三视图只改**区内画什么**，绝不 resize 滚动区。这是把 069c2293 的恒定高度原则从"在途数"延伸到"视图切换"。

| 视图 | 触发 | 区内内容 | 高度 |
|---|---|---|---|
| **collapsed**（默认） | 启动 / esc 收回 | `buildCollapsedLines`（footer + `space: expand` hint）**补空行到 3 行** | 恒定 3 |
| **panel** | collapsed 按 space | `buildPanelLines`（逐条请求表，069c2293 已恒定 3 行） | 恒定 3 |
| **detail** | panel 按 enter | **备用屏幕**（`\x1b[?1049h`），DECSTBM 区暂让位 | 全屏 |

> **保留 BLOCK-1（不反转 P1 承重不变量）**：交互实例**始终**走 Region.render（collapsed 也是区、补空行），**非交互实例**（无注入 stdin）始终走 P0 内联 footer——这是**实例级 mode 两分**（构造时定死、终身不变、无会话内切换），正是 P1 plan line 16 + [terminal-ui.ts:668](../../src/lib/tui/terminal-ui.ts#L668) 钉死的 BLOCK-1。本 spec **强化而非反转**它：detail 从"当作 panel 走 Region"改为"备用屏"，是区内内容的分发差异，不引入第二套渲染模型进交互实例。**注意**：MODE A 下 DECSTBM 区**常驻、不再对 `active.size===0` 拆区**（P1 plan 原有"空态走 `region.clear()` 拆 DECSTBM"子句被本 spec 取代——空闲态改为 collapsed 补空行的恒定 3 行区，见 §3.1 取舍）。

### 3.1 collapsed（恒定高度区，默认态）

- 复用 P1 的 `buildCollapsedLines`（保留 `space: expand` hint + `?` help 可发现性，**不退回裸 footer**）。
- **补空行到 `MAX_PANEL_ROWS`**：collapsed 只有 1 行 footer，pad 2 空行占满 3 行区（与 `buildPanelLines` 恒定高度同理）。故 collapsed↔panel 切换**区高不变**、零 churn（§0 实测）。
- 代价：空闲态底部常驻 2 空行。取舍依据：churn/丢日志 > 空行 cosmetic（承 069c2293 philosophy）。

### 3.2 panel（DECSTBM 恒定高度区）

- `buildPanelLines` 已恒定返回 `min(rows, MAX_PANEL_ROWS)` 行（069c2293），在途数变化、`?` help 切换都不改高度。
- 日志到达：`printLog` 写日志（滚动区内滚动）+ 重画面板（钉底）。
- **fix A 自愈（INV-4）**：`renderRegion` 每拍重申明 DECSTBM（`DECSC` + `\x1b[1;<bottom>r` + `DECRC`，不移光标）。reviewer 确认 VT510 语义下 DECSC/DECRC 抵消 cursor-home、无闪烁、幂等。

### 3.3 detail（备用屏幕，C1 + C2 修复）

- **进入**（panel 按 enter）：`\x1b[?1049h`（进备用屏）→ **`\x1b[r`（C1：reset DECSTBM 边距，否则残留的 panel 滚动区会截断超屏 detail）** → 可选 `\x1b[?6l`（DECOM off，防御）→ 渲染全屏 detail。**detail 分发绕过 Region.render（I3-detail：否则会在备用屏上设 DECSTBM + 画 panel 覆盖 detail）**。
- **退出**（esc）：`\x1b[?1049l`（退备用屏）→ **重建 DECSTBM 区**（备用屏往返 + 进入时的 `\x1b[r` 已改边距，退出必须重建）→ 回放队列 → 重画 panel。
- **detail 期间的日志（INV-5）**：进备用屏后日志**不写主屏**（避免污染全屏 detail），进**有上界队列** `REPLAY_CAP`（仍进 FileSink、仍更新 `active` 状态）。退出重建区后按序回放（写滚动区）。缓存↔实时的模式翻转在**同一同步回合**完成（bus 派发 + renderRegion 均同步，天然满足；M8）。
- **detail 期间的 resize**（M7）：detail 有独立 resize 重绘（reset 边距 + 重画全屏），与 panel 态的 `geometryChanged` 重锚分开。
- **detail 期间 drain/shutdown**（C2 衍生）：若 drain 在 detail 期进入，队列 flush 到 FileSink（durability 已保证）后走 §INV-6 还原路径退备用屏；不尝试回放到即将销毁的主屏。

## 4. 全协调三态：收编旁路写（INV-3）

引入**单一 region 感知协调点**（TerminalUi 拥有），按三态处理写入：
- **DECSTBM 区活跃**（collapsed/panel）：清面板行 → 写内容（滚入滚动区）→ 重画面板。
- **detail 备用屏活跃**：入回放队列（同 §3.3），不写主屏。
- **无区非交互内联**（P0 实例）：`CLEAR_LINE` 清内联 footer → 写 → 重画 footer（**I2 修复**：即使无 DECSTBM 区，内联 footer 态也须清行，否则旁路写重现 footer 泄漏）。

收编两处旁路：
- [republish.ts:59](../../src/lib/observability/republish.ts#L59) reentrant stderr 兜底 → 走协调点 `emergencyWrite`。
- [file.ts:132](../../src/lib/observability/sinks/file.ts#L132) FileSink 写盘失败 stderr → 同上。

**`emergencyWrite` 硬约束（I4 修复）**：
- **单次原子 `stdout.write`**（清面板 → 写消息+`\n` → 重画面板），一次系统调用，不与在飞 render 的 escape 序列交织。
- **不受 `renderRegion` 的 `rendering` 重入守卫抑制**（否则会静默吞掉"绝不能丢"的 FileSink/republish 错误，违反 `never-swallow-errors`）。
- **无 bus 依赖、纯终端写**（可在 bus 扇出 reentrant 上下文安全调用，绝不再触发 publish → 防日志风暴，承 republish.ts H1）。
- 残留由下一拍 render 的 fix A 重申明自愈。

> **实施接线（留 plan，须过 ESLint 分层）**：republish/FileSink 与 TerminalUi 分属不同模块、当前无引用。收编需不破坏 `src/lib/tui/**` ESLint 边界的接线（模块级 terminal-coordinator 单例 vs DI），plan 定。

## 5. 测试策略（empirical-verification）

### 5.1 自动化：字节级单测（无需真 TTY，捕获 stdout 字节）

- **INV-2 恒定几何正样本**：模拟"panel 活跃 + 连续日志 + 在途数变化 + help 切换 + collapsed↔panel 往返"，断言 DECSTBM 几何字节 `\x1b[1;Nr` 的 **N 跨全程恒定**（变异测试：任一路径改 N 则红）。
- **INV-1 零 churn 往返正样本（I4 补）**：collapsed→panel→collapsed 往返后，先前打印的日志行**仍在**（无覆写）、无残留空行——快照断言（`\x1b[1;Nr` 的 N 恒定断言证的是"几何不变"，但**collapsed 与 panel 共用同一 N=`MAX_PANEL_ROWS`**、区分不出往返是否覆写日志，故这条最出问题的边须直接断言**内容保全**）。
- **collapsed builder**：断言 collapsed 用 `buildCollapsedLines`（含 `space: expand` hint），非裸 footer（I3 防静默砍可发现性）。
- **detail 备用屏**：断言进入字节序列 `?1049h` → `\x1b[r` → 全屏渲染（C1）；退出 `?1049l` → 重建 DECSTBM → 回放顺序（detail 期到达的日志退出后按序写入）。
- **INV-6 退出（C2 补）**：断言 detail-active 时 `restoreTerminal`/exit-hook 先发 `?1049l` 再 reset 区 + 显光标——**退出路径的字节级正样本**（v1 缺失）。
- **emergencyWrite**：断言 republish reentrant / FileSink error 走 `emergencyWrite`（区活跃时含清面板 + 重画）、且**不被 rendering 守卫吞**（reentrant 上下文仍写出）。
- **INV-5 队列上界**：断言队列超 `REPLAY_CAP` 丢最旧、durability（FileSink 调用）不受影响。
- 扩展 golden-fixture：非交互 P0 路径**逐字不变**（Reading B，不注入 stdin → P0 → golden 稳定）。

### 5.2 手动：真终端 PoC（承重裁决，INV-4 唯一 oracle）

`exp/tui-rawmode/log-coordination-regression.ts` 已覆盖最终模型（A/B 对照 + collapsed↔panel + detail 备用屏往返 + 崩溃退屏 + 回放），§0 表已由用户实测裁决。**INV-4 自愈只能真终端验**（字节断言证不了愈合，呼应 `pass-null 不自证`）。

## 6. 非目标 / 明确排除

- **不改** bus/sink 架构、ConsoleSink 只读性、ESLint 分层（ADR 决策 1-3 不动，§7）。
- **不改** footer 内容格式（top-N 多时间、宽度感知分组本会话已落地；本 spec 只改**渲染协调**）。
- **不做** panel per-group 折叠等 P2+ 交互增强（另见 backlog）。
- **不引入**第三方 TUI 框架（blessed/ink）——纯 ANSI + 分层机制足够；引入是更大架构变动、超本 bug 修复范围（未来需要另开 ADR）。

## 7. 对 ADR 的处理（M2 修：补历史欠账 + 演进）

[tui-terminal-ownership](../decisions/2026-07-10-tui-terminal-ownership.md) 决策 4 原文仍为"待 PoC 回填"（**从未写入最终选 DECSTBM**，选择只落在 region.ts 代码）。落地时该决策 4 需**两次补记**：① 补原始 PoC-2b 选 DECSTBM 的结论（历史欠账）；② 补本 spec 的演进——DECSTBM 适合**恒定几何**、不适合跨视图变高，故最终模型 = **交互实例恒定高度区 + detail 备用屏**。终端所有权（决策 1）、格式化件位置（决策 2）、ESLint 边界（决策 3）**均不变**；**BLOCK-1 单渲染模型不变量被保留**（§3 说明）。

## 8. 开放问题（plan 阶段解决，非架构分叉）

- 旁路写收编的接线方式（terminal-coordinator 单例 vs DI），须过 ESLint 分层。
- **`emergencyWrite` × detail 备用屏态语义（I-new-1）**：§4 三态规定"detail→入回放队列"，但 emergencyWrite 收编的 republish/FileSink 错误语义是"绝不能丢"，与"入有上界队列（可能淘汰）"张力——尤其 FileSink 写盘失败时 durability 本身已失效、通知又可能被队列丢弃。plan 须裁决：detail 态 emergency 是（a）write-through 到备用屏（污染 detail 但保可见性，同原 stderr 语义）还是（b）入队 best-effort。**倾向 (a)**——emergency 语义 = 宁污染勿丢失。
- `REPLAY_CAP` 具体值（建议 ≥ 一屏行数、如 200）。
- 分阶段实施边界（建议：P0 恒定高度区消除核心 churn + fix A；P1 detail 备用屏 + C1/C2 + 回放；P2 emergencyWrite 旁路收编），plan 定。
