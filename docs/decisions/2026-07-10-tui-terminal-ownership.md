# ADR: TUI 终端所有权 —— 交互层从只读 sink 剥离

- **状态**：Accepted（用户 2026-07-10 签字：「这个反转没问题」）
- **日期**：2026-07-10
- **相关**：反转 [observability-rewrite](../archive/2606-landed-rfcs/observability-rewrite.md)（其把 ConsoleSink 定为 "read-only display" 并用 ESLint 钉死分层边界 [eslint.config.js:166-214](../../eslint.config.js#L166)）的部分决定；驱动特性 RFC [interactive-tui-live-panel](../rfc/2026-07-10-interactive-tui-live-panel.md)；CLAUDE.md `architecture-health-first` / `subagent-explicit-rubric`（ADR 反转须用户签字）

## 背景

observability-rewrite（landed RFC）把散落的 `src/lib/tui/` god-module 解散，建立 bus→sinks 架构，并确立一条承重不变量：**ConsoleSink 是纯只读显示**（原文 "ConsoleSink (pure read-only display)"），配套 ESLint `no-restricted-imports` 结构性钉死——sinks 之间不互引、routes 不 import sinks/bus、低层子系统不 import observability。当时 ConsoleSink 订 bus 事件、只把它们渲染到 stdout，从不反向改动任何请求状态；这条「显示层零副作用」是它能第一个 attach、能被安全推理的根基。

现在用户要**交互式 live query TUI**：终端里可展开在途请求面板、选中某条、**abort 它**。这引入两个 ConsoleSink 从未有过的能力：① **读 stdin**（raw-mode 键盘输入）；② **写 request lifecycle**（abort 一个在途请求，经 `manager.get(id).reapInFlight()` + 终态 settle）。二者都是**控制** concern，与「只读显示」不变量正面冲突。

摆在面前的是一个架构决策：**把控制能力硬塞进只读 sink（破坏不变量），还是新建一个拥有终端的层、让 sink 回归纯显示？**

### 澄清：这是「呈现/逻辑」两分演进为「呈现/逻辑/控制」三分（用户 2026-07-10 签字点）

分层要分两个时代看，避免把本决策误记为「首次拆分呈现与逻辑」：

- **observability-rewrite 之前的 `tracker.ts`** 确实**杂糅**：一个 class 同时管请求状态机 + footer 队列 + 渲染派发（那份 RFC 记为 D1 god-module）。「以前呈现与逻辑杂糅」指的是这个时代。
- **observability-rewrite 已完成呈现/逻辑分离**：请求状态机在 `context/`、纯呈现在 sink 层，ConsoleSink 当时已是「只读呈现」。

故本决策**不是**首次分层，而是在已分层基础上**引入第三个 concern——控制/输入**（读 stdin + abort 请求）。真正的架构轴是三分：**呈现（render）/ 逻辑（context 请求状态机）/ 控制（input + actions）**。核心判断（呈现与逻辑必须分层）成立且已由前一次重写落地；本次是从两分演进到三分，并给呈现一个专属的家 `src/lib/tui/`，把新引入的控制 concern 与呈现同置于该层、但内部再拆 render/input/controller/actions 各自单一职责——控制永不回流到*其它* sink，逻辑（状态机）永远留在 `context/`。

## 定夺

**新建 `src/lib/tui/` 层拥有终端交互界面；渲染从 ConsoleSink 移出、控制（stdin 读 + lifecycle 写）为新层独有能力；ConsoleSink 被 tui 的交互式渲染 sink 取代。以新的 ESLint 边界重新结构性钉死 tui 层的依赖，而非放宽旧的只读约束。**

四个具体决策：

### 决策 1：终端所有权从 sink 层剥到 tui 层（含 lifecycle 写权限）

- `src/lib/tui/terminal-ui.ts` 作为**终端唯一所有者 + stdout 唯一写者**：`bus.subscribe` 请求事件 + `system.log` 两条流（取代 ConsoleSink 的渲染 + system.log 协调），持 UI-view 局部状态（view/selectedIndex），编排渲染循环。
- **控制能力是 tui 层独有、不回流 sink**：stdin 读只在 `tui/input/`；request lifecycle 写（abort）只在 `tui/actions.ts`，经 `manager.get(id)` 取 live ctx。**请求状态机仍在 `context/`**——tui 只驱动既有的 `reapInFlight()`+settle，不新造状态机（不复活 god-module）。
- **不放宽「显示层零副作用」到 ConsoleSink**：旧 ConsoleSink 消失，不是给它加控制能力。新 tui sink 是一个**职责明确的「渲染 + 受控输入」层**，与「纯只读 sink」是两类东西——observability-rewrite 对*其余* sink（File/Ws/History/Telemetry）的只读约束**不变**。

### 决策 2：共享纯格式化件留在 observability/projections/

`format.ts` / `log-line.ts` 是**多消费者共享的纯叶子**（ConsoleSink/未来 exporter + `start.ts` bootstrap 都 import，见 [format.ts:1-14](../../src/lib/observability/projections/format.ts#L1) 头注释、[start.ts:46](../../src/start.ts#L46)）。**不搬进 tui/**（那是分层反转：bootstrap 与其它 sink 反向 import 一个显示子系统）。tui/render/ **import** 它们。

### 决策 3：新 tui/ 层以 ESLint 结构性钉死边界（延续而非放弃 observability-rewrite 的治理手法）

`eslint.config.js` 加 `files: ["src/lib/tui/**"]`：可 import `context/manager` + `observability`（订阅）；**禁 import 其它 sink**；`keys/controller/region/actions` 互不 import 内部实现（`no-restricted-imports` path group 近似）；`setRawMode`/读 stdin **仅** `tui/input/`（L1 存在性守卫测试兜底）。理由：observability-rewrite 的教训正是「口头分层会被侵蚀，须结构性钉死」——新层同样对待，否则几个月后 tui 内部边界必被违反。

### 决策 4：region 渲染技术由 PoC 实测选定（DECSTBM vs 相对光标）

多行 sticky region 的锚定技术是承重决策，不凭直觉。PoC-2（`exp/tui-rawmode/`）在 Bun + 真终端对照 DECSTBM 滚动区 vs 相对光标，按超高/resize/原生滚动三场景实测选默认（倾向 DECSTBM）。此决策**待 PoC 回填**后在本 ADR 补记。

**补记 ①（2026-07-11，原始选型欠账）**：PoC-2b（`exp/tui-rawmode/sticky-region-decstbm.ts`）真终端实测确认 **DECSTBM 滚动区**胜相对光标（相对光标在底部写触发全屏滚动时 mis-anchor，DECSTBM 不会）——落地为 `src/lib/tui/render/region.ts`。

**补记 ②（2026-07-11，演进——DECSTBM 适合恒定几何、不适合跨视图变高）**：DECSTBM 选型正确但不完整。后续用户真终端实测暴露：**任何 DECSTBM 滚动区几何变化都扰动日志流**（视图切换 collapsed/panel/detail 高度不同 → 吃日志行/留空行/footer 泄漏）。经 PoC 对照两方案（MODE A 恒定高度区 vs MODE B 内联 footer+按需区）实测裁决 **MODE A**，演进为完整渲染模型：**交互实例始终恒定高度 DECSTBM 区（collapsed 补空行）+ detail 走备用屏幕 + fix A 每拍重申明自愈 + 三态 emergencyWrite 输出协调**。决策 1（终端所有权）、2（格式化件位置）、3（ESLint 边界）不变；**BLOCK-1 单渲染模型不变量被保留而非反转**（MODE A 让 collapsed 也走 Region，实例级 mode 两分无会话内切换）。权威见 spec/plan [2026-07-11-tui-render-model-layered](../spec/2026-07-11-tui-render-model-layered.md)、DESIGN.md「交互式 live 面板」节。

**补记 ③（2026-07-17，最终现状）**：用户随后否决 MODE A 默认常驻两空行，最终活模型改为 collapsed N=1 + panel N≤3 + scroll-before-grow；detail 仍走备用屏。2026-07-17 的结构化日志/TUI 重构进一步把 owner 内部拆成 `ActiveRequestStore`、`KeyDecoder`、`TerminalSession`、`OutputArbiter`，`TerminalUi` 只编排；stdout 同步/异步 EPIPE 在 OutputArbiter 内熔断，stderr 由独立 EmergencyOutput 防崩。终端所有权仍单一，未回流 observability sinks；权威见 [RFC](../rfc/2026-07-17-tui-structured-logging.md) 与 DESIGN.md。

## 备选方案（未采纳）

- **就地扩展 ConsoleSink 加输入/abort**：最少改动，但**破坏 ESLint 钉死的「只读显示」不变量**——把控制副作用注入显示路径，正是 observability-rewrite 刻意消除的耦合（D9「两个广播通道」的同类病）。放弃它换取「进度快」是短期将就，违反 architecture-health-first。
- **放宽旧 ESLint 约束、允许 sink mutate**：会让*所有* sink 都可能获得副作用能力，侵蚀整个 bus→sinks 架构的可推理性。本 ADR 反其道——**只给新 tui 层授权、且用新边界重新钉死**，其余 sink 只读约束不动。
- **format/log-line 搬进 tui/**：分层反转（决策 2 已述）。
- **不写 ADR、RFC 内联决策**：本决策反转 ESLint 钉死的前不变量，按项目「ADR 改变须用户明确同意」必须独立成文 + 签字，不能藏在 RFC 实施细节里。

## 后果

- **正向**：交互式 TUI 得以实现，同时 sink 层只读职责被**恢复而非破坏**（旧 ConsoleSink 的显示逻辑迁走、控制能力隔离在新层）；新层同样受 ESLint 结构性治理，分层健康可持续；请求状态机不被 UI 层污染（仍在 context/）。
- **代价/边界**：新增一个有状态、双角色（订 bus 读 + 调 manager 写）的层，模块图更复杂；raw-mode 全程常驻是相对「今天不碰 stdin」的真实行为变化（接管 Ctrl-C/Ctrl-Z）；须补配套 ESLint 规则 + L1 守卫，否则治理落空。控制写权限**严格限定** `tui/actions.ts` 经 `manager.get` 单点，不扩散。
- **对 landed RFC 的处理**：observability-rewrite 已归档；在其文档或 DESIGN.md「活的架构现状」留前向指针指向本 ADR，避免两份文档对「ConsoleSink 是否只读」打架。
