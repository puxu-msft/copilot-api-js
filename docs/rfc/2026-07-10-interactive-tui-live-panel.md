# RFC: 交互式 TUI live query 面板 + 终端层重组

- **状态**：Draft v2（吸收两轮对抗评审 · **两评审已达 consensus** · 待 PoC 回填 + ADR 用户签字 + 用户评审）
- **日期**：2026-07-10
- **类型**：大型结构重构（≥1000 行）+ 新交互特性 · RFC-first（skill `large-refactor`）
- **关联**：反转 [observability-rewrite](../archive/2606-landed-rfcs/observability-rewrite.md) 对 console 渲染件摆放 + 「ConsoleSink 只读」的部分决定（**须先补 ADR 并经用户签字**，见 §12）；复用 [DESIGN.md](../DESIGN.md)「Console UI」footer 宽度不变量；PoC 在 `exp/tui-rawmode/`
- **评审**：v1 经架构 + 范围两轮对抗 subagent 评审，本 v2 已吸收 BLOCK-1 + 5 MAJOR + 数条 HIGH/MEDIUM（见 §13 变更记录）

## 1. 动机（为什么）

TUI 的 live query 信息目前是 [console.ts](../../src/lib/observability/sinks/console.ts) 底部一条 `[<-->]` footer（刚做完宽度感知 + 按模型分组）。它纯输出、不可交互——看得到在途请求，但无法展开细看、定位某条、或在终端里中止一个卡住的请求。

用户要一个**交互式 live query UI**：折叠态是现在的分组 footer，按键**展开成底部多行面板**（在途请求逐条表格，实时刷新），可**上下选中**、**回车看终端详情**、**abort 在途请求**、**复制 req_id**，再按键收回。

这暴露一个组织缺陷。当前 `ConsoleSink` **本身就是纯 bus 订阅者、只读**（[console.ts:104-114](../../src/lib/observability/sinks/console.ts#L104)），observability-rewrite 把它定为「read-only display」并**用 ESLint 结构性钉死**了分层边界（[eslint.config.js:166-214](../../eslint.config.js#L166)）。交互 TUI 要**读 stdin + abort 请求**——是**控制** concern。若把它塞进 ConsoleSink，**将会**违反那条只读不变量（注意：现状未违反，是「若塞入将违反」）。所以正确形状是新建一个终端所有权层，而非扩展 sink。

预期结果：`src/lib/tui/` 拥有终端交互界面并成为 stdout **唯一写者**；富交互（面板/选择/详情/abort）在 tui 层，横竖双向不破屏；恢复 sink 的只读职责。

## 2. 关键现状（评审校正——重组必须覆盖全部 stdout 写者）

v1 把 observability 当成 archived RFC 的旧状态，漏了已演进的复杂度。**真实现状**：
- **五 sink**：Console / File / Ws / History / Telemetry（`bus.subscribe`）。
- **consola 劫持链**：[republish.ts](../../src/lib/observability/republish.ts) 劫持 consola → 发 `system.log` 事件；ConsoleSink 消费 `system.log`（[console.ts:198-201,534-537](../../src/lib/observability/sinks/console.ts#L198)）→ `onSystemLog` → `printLog`（[console.ts:521-526](../../src/lib/observability/sinks/console.ts#L521)：`clearFooterForLog`→write→`renderFooter`）。**今天所有 consola 输出（启动/鉴权/模型刷新/warn/reaper/error）都经此路径与 footer 协调后落 stdout。**
- **两条 stdout 流**：请求生命周期行 + `system.log` 行，**都**经 ConsoleSink 的 footer 协调。
- **FileSink 不碰 stdout**：只订 `system.log` 写 `copilot-api.log`（[file.ts:110-115](../../src/lib/observability/sinks/file.ts#L110)），重组不影响它。

**含义（BLOCK-1）**：region owner 必须成为 stdout **唯一**写者，接管**请求事件 + system.log 两条流**。否则请求行走 region、consola 日志仍直写 → 两个写者撕裂多行 region（每条 warn/info 常态触发）。

**残余 stderr 逃逸（评审 MINOR-a）**：两条错误路径直写 `process.stderr` 绕过 stdout 唯一写者——[republish.ts:59](../../src/lib/observability/republish.ts#L59)（reentrant 守卫逃逸）与 [file.ts:132](../../src/lib/observability/sinks/file.ts#L132)（FileSink 写盘失败）。stderr 与 stdout 在 TTY 上渲染同一屏，磁盘满/重入等错误路径下偶发一行 stderr 会撕裂 region。这是边缘错误路径、不常态触发；region 显示期须**容忍偶发错误行**（下一次定时重画自愈），不追求拦截 stderr（那会吞掉诊断输出，违反 internal-tool 全量暴露取向）。

## 3. 目标 / 非目标

**目标**
- 折叠 footer ↔ 展开逐条面板 ↔ 单条 detail 三态，键盘驱动。
- 行级动作：高亮选中、回车详情、abort 在途请求（确认门 + 完整 settle）、复制 req_id。
- sticky 底部多行 region：日志在上滚动、region 恒贴底，**横（columns）× 竖（rows）双向 clamp**；**溢出请求可经选中窗口滚动触达**（§6）。
- terminal-ui 独占 stdout：接管请求事件 + system.log。
- 终端安全：raw-mode 全程常驻 + Ctrl-C 捕获转发；崩溃/退出必还原（PoC-4 验证）；非 TTY 降级。
- 终端层重组：新建 `src/lib/tui/`，terminal-ui 直接订 bus（新交互渲染 sink），配套 ESLint 边界。

**非目标**
- 不重建被解散的 `tracker.ts` god-module（请求状态机仍在 `context/`，tui 只持 UI-view 局部状态）。
- 不做全屏 alternate-screen dashboard（保留日志 scrollback）——**除非 PoC-2 证伪多行 region 且 DECSTBM 也不行**（§4 fallback）。
- 不替代 History Web UI / ui-v4 LiveDock。
- 不改 bus/事件协议、不改 File/Ws/History/Telemetry sink。
- 排序/过滤面板：暂缓（记 backlog）。但**选中滚动触达溢出请求不是可缓项**（§6，核心目标同根）。

## 4. 渲染模型：sticky 底部 region（承重，含技术选型 bench-off）

把当前「单行 footer + `\x1b[2K\r`」推广为**持久底部区域（N 行）**。**技术选型是承重决策，v1 押错**：

- **候选 A 相对光标**（`\x1b[<n>F` + `\x1b[0J`，log-update/ink 那套，v1 默认）：region+日志超终端高、终端原生滚动时**锚点失配**（底部打 N 行触发滚动后「上移」落点错）。脆弱。
- **候选 B DECSTBM 滚动区**（`\x1b[<top>;<bottom>r`，tmux/htop 那套）：划底部 N 行为保留区、日志滚动限制在上方、保留 scrollback。稳健。
- **PoC-2 bench-off**（`exp/tui-rawmode/sticky-region.ts` vs `sticky-region-decstbm.ts`）在 Bun + 真终端 × {超高溢出 / resize / 原生滚动} 三场景对照，**实测选默认**、写结论文档。倾向 DECSTBM。

不变量与接缝：
- **横向**：每行 `truncateToWidth(columns-1)`（复用刚落地的宽度原语），横不溢出。
- **竖向**：region 高 = `min(所需, rows - 预留)`；`rows` 每次渲染读活值 + **监听 `resize` 重算锚点**（region 高变、旧行可能成孤儿——非平凡，PoC-2 验收项）。
- **定时重画 vs 原生滚动**：今天 footer 由 100ms `setInterval` 重画（[console.ts:498-508](../../src/lib/observability/sinks/console.ts#L498)）；多行 region 下须确认不与用户原生滚动打架（PoC-2 验收项）。
- 折叠 footer 是 region 的 **N=1 退化**，同一套代码。
- **fallback 决策树**：若 PoC-2 证 DECSTBM 与相对光标在 Bun 下都做不干净 → 回到「全屏 alternate screen dashboard」（§3 非目标须重访、丢 scrollback），或接受可见闪烁。此依赖显式记录，非「换转义序列」的战术调整。
- 非 TTY：region 逻辑短路，退回**今天的行为——只打日志行、无 footer**（评审校正：今天非 TTY 本就不渲染 footer，[console.ts:473](../../src/lib/observability/sinks/console.ts#L473)）。

## 5. 交互模型

**状态机**（`view`）：`collapsed`（分组 footer + dim keybar）→ `panel`（逐条表格 + 选中高亮）→ `detail`（单条全 ctx）；正交 `confirm-abort` 覆盖态。`selectedIndex` 在 panel/detail 维护。

**键位**（提议默认，PoC 后定稿）：`Space`/`Tab` 折叠↔展开 · `↑↓`(兼 `k/j`)移动选中 · `Enter` 详情 · `Esc` 逐级返回 · `x` abort→`confirm-abort`(`y` 确认/其它取消) · `c` 复制 req_id · `?` help keybar · `q`/`Ctrl-C`(`0x03`)→转发 `handleShutdownSignal("SIGINT")`。

**raw mode 全程常驻**（评审校正）：为在 collapsed 态捕获「展开」键，raw mode 须**从启动起全程开启**（含 collapsed footer）。这相对「今天完全不碰 stdin」是**真实行为变化**——接管 Ctrl-C/Ctrl-Z/流控。Ctrl-Z(SIGTSTP) 挂起在 raw mode 下失效，须文档化（或手动处理 SIGTSTP）。属 P1，不影响 P0 等价。

**面板逐条行 + detail 数据来源**（评审校正）：`RequestContextSnapshot` 默认**不带** attempts（[events.ts:72-96](../../src/lib/observability/events.ts#L72)），`AttemptSnapshot` 只随 attempt 级事件到达。terminal-ui 须像 ConsoleSink 的 `ActiveRequest`（[console.ts:48-70](../../src/lib/observability/sinks/console.ts#L48)）那样**跨事件累积** detail 数据，而非从单一快照取。detail 显示：req_id / method+path / client→resolved model / multiplier / state / elapsed / queueWait / ↑↓bytes / events / blockType / tags / thinking requested→effective / attempts。

**abort 语义**（评审校正——MAJOR-5，最强修正）：v1 的 `manager.getContext(id)?.reapInFlight()` **两处错**：① 方法名是 `manager.get(id)`（[manager.ts:61,251](../../src/lib/context/manager.ts#L61)），`getContext` 是 codec 的另一对象；② `reapInFlight()` **只** abort lifecycleSignal 不 settle（[request.ts:306-308](../../src/lib/context/request.ts#L306)）。reaper **总是成对** `reapInFlight()` + `fail()`（[manager.ts:207-208](../../src/lib/context/manager.ts#L207)，注释明说 `fail()` 是「no-active-consumer 边缘的终态记录 + 安全网」）。故 abort 动作**必须镜像 reaper**：
```
const ctx = manager.get(id)
ctx?.reapInFlight()
ctx?.<terminal settle>()   // 否则 no-consumer 请求取消了上游却永不到终态、滞留到 stale reaper
```
**客户端可观测后果**：abort 一个正在流式的请求，客户端收到 **error 帧**（reaper-cancel → stream-error → error frame，[stream.ts:71,80-89](../../src/lib/stream.ts#L71)），非优雅 done。confirm 态须显示被打断请求的 model+path+已流字节，让用户知道打断的是什么真实客户端流。

**复制 req_id**：OSC 52 写终端剪贴板 + flash；PoC-3 若不支持退回「醒目显示 req_id 供鼠标选」。

## 6. 溢出请求的可达性（评审 §6a——核心目标同根，不可缓）

竖向 clamp + `+K more below` 只显**计数**是不够的：50 个在途、region clamp 到 10 行时，第 11-50 个请求对 abort/detail **不可达**，直接削弱「选任一在途请求 → 回车/abort」的核心目标。故 **P1 明确需求**：选中窗口随 `selectedIndex` **滚动进溢出区**（选中移到可见窗口边缘时 region 视口跟随滚动）。这与本特性同根，砍了核心目标不完整。排序/过滤才是可缓的 backlog 项。

## 7. 终端安全（承重风险 · 评审 §1）

- **Ctrl-C 铁律**：raw mode 下 Ctrl-C 以 `0x03` 进 stdin（PoC-1 确认），controller 必须捕获转发 `handleShutdownSignal("SIGINT")`，否则停不下服务器。
- **崩溃/退出还原（评审 §1a HIGH）**：崩溃走 `process.exit(1)`（[main.ts:24-32](../../src/main.ts#L24)），`process.on("exit")` 同步钩子还原（`setRawMode(false)` + 显光标）。但 **Bun 下 exit-hook 同步 flush 转义序列是 `bun-node-runtime-gotchas` 雷区，未验** → **PoC-4**（`crash-restore.ts`）实测。exit-hook 还原挂在**首次启用 raw mode 的 P1**（非 P2）。
- **shutdown teardown 归属（评审 §1b）**：`shutdown.ts` **架构上不拥有终端 teardown**（[shutdown.ts:527-530](../../src/lib/shutdown.ts#L527) finalize 注释显式委托 exit hook）。**exit-hook 是唯一承重还原点**，shutdown 序列里加 setRawMode 是冗余。`bun --watch` 若以 SIGKILL 收割则不可拦截，终端跨重启残留窗口（新实例重设 raw 自愈）——记录此不可拦截窗口。
- **drain 期间 stdout 所有权 + 多次 Ctrl-C 升级（评审 §1c，须择一）**：shutdown drain 期间直接 `consola.info` 写 stdout，而 terminal-ui 独占 region——**谁在 drain 期间画底部？** 两方案择一：
  - **方案 A（推荐）**：shutdown 一开始就把终端还原到 cooked + 拆 region → 后续 Ctrl-C 变回真 SIGINT → 由 `process.on("SIGINT")` 走 phase 升级中止（[shutdown.ts:564-580](../../src/lib/shutdown.ts#L564)）。最干净，drain 期间回归纯日志流。
  - 方案 B：drain 期间仍 raw、controller 持续转发 0x03、region 让位给 shutdown 进度日志。复杂。
  - **待用户/执行期定，倾向 A。**
- **门控**：`typeof stdin.setRawMode === "function" && stdout.isTTY`（两者同真；混合 TTY 场景安全，评审确认无缺口）。全仓无运行期 stdin 消费者（`setup-claude-code.ts` 只在 server 启动前的交互 setup 用，无重叠，评审确认）。

## 8. 架构（重组后 · 评审校正）

```
src/lib/tui/
  terminal-ui.ts      # 终端所有者 + stdout 唯一写者：bus.subscribe（请求事件 + system.log）+ 持 UI 状态(view/selectedIndex)
                      #   + 累积 per-request detail（跨事件）+ 编排渲染循环。不含光标序列（下沉 region.ts）。
  render/
    footer.ts         # 折叠态分组 footer 串构建（从 console.ts 抽出）
    panel.ts          # 展开态逐条表格 + detail 视图串构建（新）
    region.ts         # sticky 底部多行 region：独占光标/diff + 宽×高 clamp + 选中滚动 + resize 重锚（新；DECSTBM/相对光标由 PoC-2 定）
    syslog.ts         # system.log 行渲染（onSystemLog/consolaPrefix 逻辑从 console.ts 迁入）
  input/
    keys.ts           # raw-mode stdin → 归一化键事件（转义序列解析）（新；唯一读 stdin/setRawMode 的目录）
  controller.ts       # 键事件 → UI 状态机迁移 + 派发 actions（新）
  actions.ts          # 副作用：manager.get(id) → reapInFlight()+settle abort；OSC52 复制（新）
```

**format.ts / log-line.ts 留在 `observability/projections/`**（评审 MAJOR-2）：它们是**多 sink + start.ts 共享的纯叶子**（[format.ts:1-14](../../src/lib/observability/projections/format.ts#L1) 头注释、[start.ts:46](../../src/start.ts#L46) 直接 import）；搬进 tui/ 是分层反转、且破坏 P0「零行为变化」。tui/render/ **import** 它们。

**terminal-ui 直接订 bus**（评审 MAJOR-3）：它是**新的交互式渲染 sink**（`bus.subscribe` 像 FileSink），**取代** ConsoleSink——不是「ConsoleSink 转喂 terminal-ui」那层含糊间接。ConsoleSink 被 terminal-ui 吸收/替换（其 footer 渲染 + system.log 协调逻辑迁入 tui/render/）。这样「恢复只读 sink 职责」才名副其实（旧 ConsoleSink 消失，新 tui sink 明确是「渲染 + 受控输入」层）。

**ESLint 结构化边界**（评审 MAJOR-3，须加）：`eslint.config.js` 加 `files: ["src/lib/tui/**"]`——tui/ 可 import `context/manager` + `observability`（订阅），**禁 import 其它 sink**；`keys/controller/region/actions` 互不 import 内部实现（`no-restricted-imports` path group 近似）；`setRawMode`/读 stdin **仅** `tui/input/` 允许（L1 存在性守卫测试兜底）。否则「干净分层」停留口头、几个月必被违反。

**并发写守卫**（评审 P-2）：JS 单线程 run-to-completion，bus handler 与键盘 handler 不会同步互相打断；真正脚枪是 **render 里出现 `await`**。硬不变量：**region 临界区内 render() 全同步、绝不 await** + 一个 reentrancy flag（照抄 [republish.ts:50-67](../../src/lib/observability/republish.ts#L50) 的 `reentrant` 守卫）。

## 9. Open Questions（PoC + 决策待定）

**PoC 实测状态（2026-07-10，pty 无人化 · 结论回填 `exp/tui-rawmode/README.md`）**：Q1/Q4 已实证闭合、Q2 DECSTBM byte 级胜出（**交互模型未被推翻**）、Q3 wire 正确。剩余真人终端复验项见下表「残留」列。

| # | 问题 | 解法 | 实测状态 |
|---|---|---|---|
| Q1 | Bun raw-mode 下 Ctrl-C 是否 `0x03`、SIGINT 是否触发 | PoC-1 `raw-ctrlc.ts` | **闭合**：Ctrl-C 以 `0x03` 进 stdin、**不产 SIGINT**、进程存活 → controller 必须捕获转发（§7） |
| Q2 | sticky region：DECSTBM vs 相对光标 | PoC-2 bench-off | **DECSTBM 胜出**（byte 级 correct-by-construction、退出 `\x1b[r` 复位）→ `region.ts` 默认 DECSTBM。**残留真人复验**：原生滚动下视觉锚点漂移 + 100ms 重画闪烁观感。**模型未推翻、§4 fallback 未触发** |
| Q3 | OSC 52 跨终端可行性 | PoC-3 `osc52-copy.ts` | **wire 闭合**（字节 `\x1b]52;c;<b64>\x07` 正确解码）。**残留真人复验**：系统剪贴板是否真写入（跨终端/tmux/ssh + clipboard 权限）；否则退回显示 req_id |
| Q4 | Bun exit-hook 同步 flush 还原终端 | PoC-4 `crash-restore.ts` | **闭合**：stdout 为 TTY 时 `process.on("exit")` 同步转义序列**被 flush**、`\x1b[?25h` 到达、退出码 1。雷区未触发。**稳健建议**：throw 点/finally 仍留同步还原、exit-hook 作兜底（stdout 若被重定向为 pipe flush 行为可能不同） |
| Q5 | user-abort 的终态 settle + provenance + 客户端语义 + 遥测计数后果 | 新 `user-abort` StreamErrorKind + 镜像 reaper 成对调用；显式报错 vs 静默待定；终态方法选择决定是否污染 per-model 失败率（telemetry 排除 aborted、计入 failed） | **P2 设计入口**（未跑 PoC，纯设计决策） |
| Q6 | drain 期间 stdout 所有权 / 多次 Ctrl-C 升级 | 方案 A（还原 cooked）vs B（持续转发），倾向 A | **待用户/执行期定**（倾向 A） |

**PoC 结论**：Q2 DECSTBM 可行 → **「可展开面板叠在日志流上」的交互模型成立、§14 全屏 dashboard fallback 不触发**。剩 Q2 视觉观感 + Q3 剪贴板两项真人复验（非阻塞架构，属实现验收）。

## 10. 分阶段（各带 commit invariants）

- **P0 重组（行为等价）** — **✅ 已实施（2026-07-10）**：`docs/plan/2026-07-10-tui-terminal-reorg-p0.md`（6 task 全绿 + 各 task 过审、golden-fixture 逐字等价）。建 `src/lib/tui/`；从 console.ts 抽 footer/syslog 渲染 → tui/render/；**format/log-line 留 projections/**；terminal-ui 直接订 bus **接管请求事件 + system.log 两条流**取代 ConsoleSink（旧 `sinks/console.ts` 已删）；加 ESLint 边界。**golden-fixture 预捕获**（从重构前 commit 锁旧 stdout 字节流）——fixture **必须含**「请求行 + 100ms footer 重画 + system.log 行」三者交织的**非空**样本（评审 §5b：正样本证捕获触达渲染路径，否则空对空空洞通过）。纯搬家、零行为变化。
- **P1 只读面板** — **✅ 已实施（2026-07-11）**：`docs/plan/2026-07-11-tui-interactive-panel-p1.md`（8 task 全绿 + 各 task 过审含 opus 集成审查；四叶子 keys/region/panel/controller + 集成 + 还原 scheme A + eslint 边界 + doc）。`region.ts` DECSTBM 多行 sticky + 宽×高 clamp + **选中滚动触达溢出**（§6，`panelContentRows` 共享 helper 对齐 controller/renderer 窗口）；`keys.ts`+`controller.ts` 展开/收回/导航；`panel.ts` 逐条 + detail（跨事件累积 attempts[]）；raw-mode 常驻（Reading B：仅显式注入 stdin 才 interactive，护 test-isolation）+ **exit-hook 还原**。无破坏性动作。真终端反馈修入：req_id 显全（`1c23e6f4`）、**面板固定高度 3 行消除空行 churn**（`cfc4f05e`）。残留打磨项（help-toggle 滚动、1↔2↔3 微动）见 `docs/todo/deferred-backlog.md`。**用户真终端验收清单见 plan 末**。
- **P2 破坏性动作**：abort（镜像 reaper `reapInFlight()`+settle + Q5 `user-abort` provenance + 客户端语义）+ req_id 复制（Q3）+ 确认门显被打断请求详情 + drain scheme（Q6）。

## 11. 测试

- `keys`：转义序列（`\x1b[A`↑ 等）→ 键事件。
- `controller`：键事件 → 状态迁移（fake 状态）。
- `region`：宽×高 clamp、截断、overflow 指示、**选中滚动进溢出**、resize 重锚（冻结时钟 + 固定 columns/rows 的 fake stdout）。
- `actions`：abort → mock `manager.get` + `reapInFlight`+settle **成对**调用；复制 → OSC52 字节。
- Ctrl-C 转发：`0x03` → mock `handleShutdownSignal`。
- 还原：destroy + **exit-hook** → `setRawMode(false)` + 显光标（PoC-4 真终端补充）。
- 非 TTY：no-op、退回「只打日志、无 footer」。
- P0 回归：golden-fixture 证 stdout 字节流逐字等价（含 system.log 交织、非空正样本）+ 既有 `tests/observability/console-*` 全绿。
- ESLint 边界：L1 守卫测试（tui/ 不 import 其它 sink、仅 tui/input 读 stdin）。

## 12. ADR（须先于 RFC 定稿、用户签字 · 评审 §7）

observability-rewrite 用 ESLint 钉死「ConsoleSink 只读 + 唯一 stdout 渲染器」不变量。本 RFC 让 tui 层获得 **stdin 读 + request lifecycle 写（abort）** 权限——实质反转。按 CLAUDE.md「ADR 改变须经用户明确同意」，须**先**补 `docs/decisions/2026-07-10-tui-terminal-ownership.md` 并由用户签字，记四个决策：① 终端所有权从 sink 层剥到 tui 层（含 lifecycle 写权限）；② 格式化件归属（留 projections/）；③ 新层 ESLint 边界；④ region 技术选型（待 PoC-2）。archived RFC / DESIGN.md「活的架构现状」留前向指针避免打架。

## 13. 变更记录（v1 → v2 吸收评审）

- **BLOCK-1**：补 §2 现状 + terminal-ui 接管 system.log 两条流成 stdout 唯一写者。
- **MAJOR-2**：format/log-line 留 projections/（不搬 tui/）。
- **MAJOR-3**：terminal-ui 直接订 bus 取代 ConsoleSink + 加 ESLint 边界 + §1 措辞改「若塞入将违反」。
- **MAJOR-4**：region 技术 DECSTBM vs 相对光标 bench-off（PoC-2）+ resize 重锚 + fallback 决策树。
- **MAJOR-5**：abort 镜像 reaper（reapInFlight+settle）+ `manager.get` 正名 + 客户端 error 语义 + Q5 provenance 前置 P2 设计。
- **HIGH/MED**：崩溃还原 PoC-4 + exit-hook 唯一承重点、drain stdout 所有权 scheme A/B、溢出请求选中滚动（§6）、golden-fixture 非空正样本、raw-mode 全程常驻真行为变化、非 TTY 不渲染 footer、detail 跨事件累积、并发 reentrancy 守卫、ADR 前置签字。

## 14. 不采纳

- 全屏 htop 式 dashboard：用户选可展开面板；**除非 Q2 逼出 alternate screen**（§4 fallback 重访）。
- 就地扩展 ConsoleSink：破坏只读 sink 不变量（本 RFC 动机）。
- format/log-line 搬进 tui/：分层反转（评审 MAJOR-2）。
- ConsoleSink 转喂 terminal-ui：职责含糊，改为 terminal-ui 直接订 bus（评审 MAJOR-3）。
- 信号/config 切换替代键盘交互：用户明确要交互式 UI。
