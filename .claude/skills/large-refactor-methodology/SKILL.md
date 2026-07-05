---
name: large-refactor-methodology
description: 当在 copilot-api-js 做大型（≥1000 行）/多 commit 结构性重构时使用——RFC-first 流程（brainstorm→docs/rfc/→≥3 轮对抗 subagent review→解 open questions→带 commit invariants 实现）、commit invariants（每 commit 终态不变量、中间态绝不半坏）、过渡态显式无害（silent/hijackConsola:false flag）、golden-fixture 预捕获（改动前锁旧代码证等价）、RFC 多 phase 三层文档结构（design/plan/prompts + README DAG/红线）、sed/grep 批量改造工具箱与两大踩坑（平行块缩进误匹配、perl 宽字符 UTF-8 全文损坏）。
---

# 大重构方法论

适用「≥1000 行 / 多 commit 结构性重构」：改类型/删函数/改 import/迁移 registry/可观测性重写等。小重构（自己一路实现、单一语义单元）不需要本 skill 的重型流程——直接 RFC/主线实现即可。本 skill 是用户 rule `60-feat-dev-workflow`（spec-driven）在本项目的操作层落地。

判据：全流程 = RFC-first → 每 commit 守 invariant + 过渡态无害 → 用 golden 证行为等价 → 交并行实现者则拆三层文档 → 批量改造用工具箱避坑。

## 1. RFC-first（先 RFC，熬过 ≥3 轮对抗 review 再动手）

数千行级重构**不要**从一句口头「我们说好了」直接开写。先 brainstorm/审计拿到带 `file:line` 证据的**具体债务清单**（别从「感觉坏了」开始设计），再写 RFC，再对抗式 review 到零 FAIL/WARN，再实现。

**为什么（每次抓住都省真实返工）：** 从口头共识直接开写的大重构，事后常暴露——
- **设计漏掉的事件源**：某次 subagent v1 review 抓出 4 个被漏的 broadcast 命名空间（`history.stats_changed`、`history.cleared`、`system.shutdown_phase_changed`、`system.rate_limit_state`）——实现时没有它们会导致前端回归。
- **倒置的假设**：原本要删中间件 finalization；subagent 抓到那会把错误可见性延迟从毫秒级膨胀到 200 秒。
- **跨章节相互冲突的决策**：`count-tokens-via-fake-completed`（决策 A）会让隔离目标（决策 B）失效。

通过 3 轮对抗 review 达到「稳定 RFC」约 30-60 分钟，避免实际代码上大得多的返工。

**流程：**
1. **先 brainstorm/审计**：拿一份 `file:line` 债务清单。
2. **写 RFC** 到 `docs/rfc/<topic>.md`：问题陈述 / 架构 / 依赖方向 / type union / sinks·模块 / cutover 计划（按 commit，NOT phase）/ 范围外 / 给用户的 open questions / 验证。
3. **subagent 对抗式 review**，用明确 prompt：「找遗漏的事件源、跨章节矛盾、虚假的自我主张、潜伏的 bug」——**不要**用泛泛的「review this RFC」。
4. **查验 subagent 发现**（见 skill `empirical-verification` / user-level `verifying-authoritative-claims`：读它引用的每个 `file:line`、独立实测裁决）。
5. **重复**直到零 FAIL/WARN（通常 2-4 轮）。
6. **请用户**在写代码前解答 RFC §open-questions。
7. **实现**，带 commit invariants（§2）。

**哪怕一轮都别跳过。** 某次 v1 RFC 有 4 FAIL+8 WARN、v2 有 3 red+4 yellow、v3 有 3 处文本自洽性问题——每轮都实打实改进了设计，没有一轮多余。

## 2. Commit invariants（每 commit 终态不变量）

多 commit 结构性重构（如 8-commit 可观测性重写），把**commit 级不变量**写进 RFC 的 cutover 章节，并在每个 commit 后验证。防止发布一个处于半破碎中间 commit 的系统（日后 bisect 落到它上毫无用处）。

**范例（可观测性重写 RFC §4）：**
> 不变量：**从 commit 2 起，每个 commit 都以全部 4 个 sink 都挂接到 bus 上结束；系统在整个切换过程中保持端到端可观测。**

这迫使 commit 2 **把 sink 挂接为空闲观察者**（收零事件、legacy 路径仍 emit、两边都可观测），而非等到 commit 3b。commit 3b 生产者原子切换、sink 在 `consumers.ts` 被删的同一 commit 成为权威。commit 2→3e 之间没有任何一个 commit 让可观测性半破碎。

**怎么用：**
- 任何 ≥3 commit 的 RFC，在切换章节写 1-3 个显式不变量（可测试陈述：「测试套件通过」「所有 sink 已挂接」「新旧路径间无双写」）。
- 每个 commit 的验证步骤（typecheck+测试+人工检查）**必须**显式含这些不变量；某 commit 无法满足就重排 commit 顺序。
- 用户说「逐 commit、每步等我确认」时严格遵守：每 commit 请求签字前做 subagent-audit，绝不打包多 commit。
- **外观性回归**（如双 consola hijack 导致 TTY footer 闪烁）即使不违反字面也违反精神；用 flag/option 把回归推迟到干净切换点。

**Anti-pattern（本会话抓到）：** commit 2 最初计划「挂 sink、hijack consola、完事」。Subagent 抓到 `ConsoleSink` + legacy `ConsoleRenderer` 双双 hijack 会互相遮蔽 → 修复是 `hijackConsola: false` 选项，用于 commit 2-3a、从 commit 4+ 默认 true。

## 3. 过渡态必须「显式无害」（ACTIVELY harmless）

「所有 sink 都已挂载」这条 invariant 是**必要但不充分**。一个在 commit N 挂载、生产者要到 commit N+2 才切换的 sink 收零事件——对读路径没问题，但若 legacy 代码**也**渲染同一份输出，重叠窗口内**两者都渲染** → 用户看到重复输出、翻倍指标、冲突的 hijack。隐式的「无害」假设会静默失效（测试通过是因为每条路径单独工作都正常；只有两路都向同一通道 stdout/WS/DB 发出时危害才显现）。

**范例（可观测性重写 commit 2-3e）：**
- Commit 2 把 `ConsoleSink` 挂到 bus；legacy `ConsoleRenderer`（经 `main.ts:initConsolaReporter`）仍装着。
- Commit 3b 原子切换生产者到 bus → `ConsoleRenderer`（经 legacy `tuiLogger.finishRequest`）和 `ConsoleSink`（经 bus `request.completed`）**都**画 `[ OK ]` 行。subagent 在 commit 3c review 抓到。
- Fix：`ConsoleSink` 加 `silent: true`，commit 2-3e 在 `start.ts` 硬编码（sink 保持订阅、sink-ordering 集成测试仍过、但不写 stdout）；commit 4 删 lib/tui 并翻回默认 false。

**怎么用：**
- 每个 commit 都问：「若 legacy 与新代码在这 commit 窗口并行运行，它们是否都写同一输出（stdout/WS/DB）？」
- 若是，新代码需**显式**的 no-op 模式，别依赖「现在还没人调用它」（调用可能通过测试/边界情况/未来 commit 泄漏进来）。常见 no-op：`silent: true`（写路径短路）、`hijackConsola: false`（不装全局状态）、仅订阅（跟踪状态但不发出）。
- 在 commit message **和** flag docstring 都记 flag 生命周期：「commits N~N+2 设 true，commit N+3 legacy 删除时翻回 false」。
- 每个 commit 边界做一次**手动 UX 检查**——typecheck/测试通过但抓不到「stdout 每行出现两次」。

## 4. Golden-fixture 预捕获（改动前锁旧代码，证行为等价）

行为保持地重构某个流/输出（bus 事件、SSE 帧、wire payload、sink 输出）时，先写 golden 断言测试并**在改动前的旧代码上跑通**——这就把当前行为**锁定**了。然后再重构；同一个不动的测试改后仍通过 = 证明等价。一个只在重构后才存在的 golden 什么都证明不了（它只是编码了新代码的行为）。这是「字节/行为等价」invariant（§2）背后的具体验证手段，能抓到全套件绿也漏掉的：事件重排、漏发/多发、payload 漂移。

**怎么用：**
- 捕获**序列 + 判别字段**（kind、field、previousState、presence 标志），**不**捕全 payload——更少误报、仍抓结构性回归。
- **归一化易变字段**（id、startTime、durationMs、时间戳）——断结构不断噪声。
- 在「改动前的 HEAD」上跑→通过（golden 锁定）→重构→须仍通过 + 连跑 N× 确认确定性。

**范例（v4 P0.3，最高风险 commit）：** `tests/context/context-bus-stream.it.test.ts` 记录 success/fail/abort 三流的 `request.*` bus 事件流（kind/field/previousState/state/hasSummary），先在双轨旧代码上通过，再在 ctx 改为直接 publish 后仍通过——证明收敛是事件流等价的。

**配套视角（结果等价 vs 机制等价）：** 当重构是**提升/上移**逻辑（如内循环→pipeline strategy），区分**结果等价**与**机制等价**。机制理应改变（每尝试独立限流、重试日志、多记 history 行）——这是目的，不是回归。invariant 是结果（learn→retry→成功），而非字节级机制一致。

## 5. RFC 交并行实现者时：三层文档结构

当大重构 RFC **要交给一组独立实现者分别完成**（而非自己一路实现）时，文档拆**三层物理结构**（仿 `docs/v4/`，活范例 `docs/archive/2606-landed-rfcs/response-pipeline/`）：

1. **`design.md`（RFC）** — 为什么这么改 + 接口契约（§接口）+ 各 phase 的 Stage 划分 + 与既有 deferred items 的推翻/取代关系（§deferred）。回答「WHY + 契约」。
2. **`<stage>-plan.md`（master plan）** — 每个 Task 的 TDD 步骤 + **factory/锚点表**（被迁移/复用的现有函数 `file:line` + order 常量）。回答「HOW + 锚在哪」。
3. **`prompts/`（per-phase kick-off）** — 每 phase 一个**可直接粘给独立实现者的 self-contained 文件** + 一个 `README.md` 导航。回答「实现者照着干」。

**每个 per-phase prompt 的固定骨架**（self-contained，假设实现者零项目上下文 + questionable taste）：背景+为什么 / 必读（引用 design+plan+progress）/ 目标+改动锚点（含 factory `file:line` 表）/ TDD 步骤 / 验收 gate（byte-critical 则 golden 逐字节等价为硬 gate）/ 提交指引（精确 pathspec + conventional commit）/ 红线（引用 README，不在每 phase 重复）。

**`prompts/README.md` 集中承载**：① phase 导航表（含前置）② **阶段依赖 DAG**——标清哪些 phase 格式独立可并行分派、哪条链 byte-critical 严格串行不可拆、共改哪些文件需协调合并顺序 ③ **通用红线**（git checkout 禁令、细粒度暂存、golden gate、subagent 全量工具、三能力守卫等，集中一处各 phase 引用）④ 通用必读清单。

**为什么：** 多实现者并行的瓶颈不是「会不会写代码」，是「上下文与契约对不齐」——A 不知道 B 改了共享文件、不知道 order 契约、把 byte-critical 链拆开并行做。三层把契约（design）、锚点（plan）、可执行 kick-off（prompts）分离，README 的 DAG + 集中红线挡住「并行边界踩踏」和「红线在 N 个文件里漂移不一致」。这是 §1 RFC-first 的**产物组织维度**（§1 记流程，本节记产物结构）。

**怎么用：**
- 自己一路实现的小重构**不需要**三层——直接 RFC + 主线实现。三层是「分派给多人/多会话」才值得的开销。
- **battle-tested > hand-rolled（丢渲染壳、保算法核）**：byte-critical 迁移类 phase（如响应改写迁 registry）的 plan 必给 **factory 锚点表**——**复用现有算法核、不重写**。范围明确/算法性的叶子层（行+词 diff、解析、日期运算）用成熟库（如 UI block-diff 引擎 L3 叶子用 jsdiff `diffLines`/`diffWordsWithSpace`/`diffJson`），只**丢弃渲染包装层**（`diff2html` → 自己的主题渲染），**保留算法核心**（`diff`）；只有库表达不了的领域层（L1/L2/L4 按 role/type/offsetMs 对齐）才自建。别过度套「不引第三方 / 自己造」本能——手搓久经验证的算法是得不偿失的虚假节省。phase prompt 必带 golden-fixture-pre-capture gate（§4）+ commit-invariants（§2）。
- DAG 必须显式标注：哪些 phase 因 byte-critical 顺序契约**不可并行**（如「原子迁一组改写」不能逐条拆），哪些格式独立可并行但共改同一文件需排合并序。
- 收尾 phase 固定含 whole-domain audit + 文档同步 + 用决策数据重走遗留 open question（见 CLAUDE.md `scope-ambiguity-then-ask`、skill `session-closeout`），而非自动启动下一 Stage。
- `git mv` 重组已有扁平文档时，记得修相对路径引用（`../`/`../../` 随目录深度变）并核验解析。
- 不要把 rfc/spec/plan/prompt 混在一个扁平目录或单文件里——用户明确要求分层（2026-06-20）。

## 6. 批量改造工具箱（sed/grep/git status）+ 两大踩坑

多文件 API 重命名 / 导入删除 / 类型形态迁移的高效循环（约 8 commit / 约 3500 LOC 可观测性重写的工作模式）：

1. **`sed -i` 批量编辑**（逐行正则、就地）：
   ```bash
   sed -i 's/tracker\.getActiveRequests/tracker.getActive/g' src/lib/shutdown.ts tests/shutdown/shutdown.unit.test.ts
   sed -i '/import { tuiLogger } from/d; /tuiLogger\.clear()/d' tests/helpers/test-bootstrap.ts
   ```
   对重复性替换比 Edit 快、确定性、一次 shell 调用作用于数十文件。
2. **`grep -rn` 验证零残留**：`grep -rn "tuiLogger\|TuiLogEntry\|TuiRenderer" src/ tests/ --include="*.ts"` 非空=漏了某处，迭代。
3. **`git status --short` 跟踪范围蔓延**：`git status --short | grep -v '^??'`（tracked）、`git diff --stat`（per-file 行 delta）——发现不该改的文件（sed 正则太宽松）。
4. **区分「代码引用」与「注释引用」**：`grep -rn "tuiLogger" src/ tests/ --include="*.ts" | grep -v "^\s*\*\|//"`；docstring 里的残留通常是有意保留的历史上下文。

**踩坑（务必避）：**
- **`sed` 会静默搞乱多行模式**。任何跨行的内容用 Edit/Read。
- **缩进敏感的 perl/sed 替换会跨「平行块」误匹配**（给 `state.ts` 加 config 字段时踩 2 次）：`state.ts` 有两个**字段赋值行只差缩进**的平行块——`mutableState` init（**2-space**）和 `resetConfigManagedState`（**4-space**）。用 2-space pattern `perl -0pi -e 's/(  foo: X,\n)/$1  bar: Y,\n/'` 给 init 加 `bar` 时，该 pattern **也匹配 4-space 行**（4 个前导空格里末 2 个 + `foo`），于是在 reset 块插入**错位的 2-space 重复行**、且**漏掉真正的 init 块**。症状：grep 该字段出现 **6** 处（含 1 个缩进不对的错位重复）而非预期 5 处。**解法**：给这类平行块加字段**用 Edit + 唯一后续行上下文**，别用缩进 pattern；非要 perl 则 `^  foo`（`^` 锚行首、精确 2 空格）+ 后跟唯一行。**对账**：`grep -c "<字段>" src/lib/state.ts` 应=5，多了就是错位重复。
- **perl `-0pi` 的替换串含宽字符（`\x{2462}`=③、emoji 等 >U+00FF）会静默破坏整个 UTF-8 文件**（给 context/types.ts + 测试加带 ③ 的注释时踩）：perl 默认按 latin1（字节）读文件，但替换串里的宽字符让 perl 把**输出**当 Unicode 编码——于是文件里**所有已存在的多字节 UTF-8**（`─`/`→`/`—`/中文）被按 latin1 重新解释再编码 → 全变 mojibake。信号：perl 打印 `Wide character in print at -e line 1`。**typecheck 不报**（损坏在注释/字符串里）。**检测**：`grep -rl "âââ\|é¡¶" <files>`。**解法**：`git checkout -- <file>` 还原（此处该文件必须无未暂存改动，否则先重新 Edit）+ 用 **Edit 工具**重加。**根原则**：任何替换串含非 ASCII（中文注释、box-drawing、箭头、③②①、emoji）**一律用 Edit 不用 perl/sed**——本仓库源码注释大量中文 + box-drawing，perl 几乎必踩。
- `sed -i 's/foo/bar/g' file file` 作用于多文件但**不递归**。递归用 `grep -rln "foo" src | xargs sed -i 's/foo/bar/g'`。
- 批量删除后也要删如今未使用的导入——TypeScript 会报错，那就是提示。
- 批量编辑之间始终跑 `bun run typecheck`，别叠 5 个批量编辑再 debug 一堵墙类型错误。
- heredoc + `sed` 撑不住 commit message 里的特殊字符——用 `git commit -F file` 或仔细转义（反引号会破坏 bash 解析）。

**何时不该用 sed：** 字符串/模板字面量内部（错配风险高）、TypeScript 签名变更（多行、用 Edit）、需保留格式细节时。

**组合生产力配方：**
```bash
sed -i 's/oldAPI(/newAPI(/g' src/ -r --include="*.ts"   # 1. bulk edit
grep -rn "oldAPI" src/ tests/ | head                    # 2. verify
bun run typecheck 2>&1 | tail -20                        # 3. let TS find remaining
# 4. fix holdouts with Edit; 5. verify again; 6. bunx eslint --fix <changed files>
```

跨独立文件的多个 Edit **消息内并行提交**（见 CLAUDE.md `no-premature-stop`）；推过 typecheck 损坏态直到下一个 green 才停（同上）。
