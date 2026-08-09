# 评审：词汇层剥离 + barrel 纪律计划（执行方视角）

> **评审对象**：[2026-07-28-vocabulary-leaves-and-barrel-discipline.md](2026-07-28-vocabulary-leaves-and-barrel-discipline.md)（提交 `693e3b73`）
> **评审姿态**：第一人称模拟执行 N1→N3，对计划要求的每个动作实地核查仓库；不评审 §2 四个数字的算术（另有 reviewer）与 §5 两条待用户裁决的分叉。
> **裁判轴**：长远正确 + 完整（非 ROI/YAGNI）。架构健康 / 可维护性 > 向后兼容与回归风险。
> **核验基线**：与计划一致的 `65c5654c`（`feat/state-foundation` tip）。全部核查通过 `git show`/`git grep` 只读读取，以及在 `/tmp/vocab-rv1/` 内用 `git archive` 导出的**副本**上做的实测；**未对仓库做任何写操作，未进入 `.worktrees/state-foundation`**。

## 总判

**不能。** 一个全新会话在不问原作者的情况下按 §4 N1 的字面执行，**会得到 0 削环，而且 typecheck、ratchet 守卫、全后端测试统统绿** —— 没有任何自动化信号告诉它什么都没发生（实测见 BLOCKER-1）。缺的三块，按重要性排序：

1. **唯一真正削环的那个动作没写进 N1**：把 `history/types.ts` 与 `context/types.ts` 的 import 改指叶子。N1 的括注「消费端零改动」恰好指示执行方**不要做**这件事。
2. **N1 落地后的基线重冻结（`scripts/update-circular-deps-baseline.ts`）没写**，导致 N2 的验收判据②对着一个仍含那 24 个环的陈旧基线比较，形同虚设。
3. **开工位置/时机未定义**：基线分支尚未合并，而它唯一的 checkout 是禁区 worktree；master 上的 committed baseline 是 70/63 而非 43/50。

N2 另有两处**照抄即失败**（`ApiError` 不在 foundation 根 barrel 导出；`./bus` 在 `history/state.ts` 里解析到不存在的路径），以及一处**把未解决的技术问题当成已知动作**（symbol→owner 判定，本仓无现成工具且 `source-ast.ts` 头部明写这条路已被判定为死路）。

N3 是三步里唯一基本可直接执行的（两个落点都存在），只缺依赖声明与验收判据。

## 双视角覆盖证据

**机械核对做了哪些扫描 / 对账 / 查证**

- 逐个核实计划点名的 11 个路径在 `65c5654c` 上存在（三个 owner 文件、两个类型模块、`history/state.ts`、`error/index.ts`、`observability/index.ts`、`source-ast.ts`、`package-boundaries.unit.test.ts`、`coding-conventions.md`）。
- `git grep` 三个诊断类型的全部定义点与消费点（`src` + `tests`），并顺带扫出计划未列的第四个同型类型 `AskNormalizationDiag`。
- 读 `packages/foundation/src/index.ts` 全文（11 行）+ `tsconfig.json` 的 `paths`，核实 `ApiError` 的可达路径；统计 `src/` 里 `@hsupu/ghc-proxy-foundation` 的实际 import 形态（仅 2 处子路径，0 处裸包名）。
- 读 `tests/architecture/source-ast.ts` 全文，清点它提供的能力（`publicExportNames` / `allModuleSpecifiers` / `typeOnlyModuleSpecifiers` / `valueStarReExports` / 调用图助手），确认**没有**跨文件 symbol→owner 解析；读它的头部注释确认该能力被显式放弃。
- 读 `tests/architecture/package-boundaries.unit.test.ts` 全文，确认 telemetry allowlist 检测器（:87、:99）是 **specifier 级** allowlist，与 N2 需要的 **symbol 级** provenance 不同形。
- 读 `tests/architecture/circular-deps-ratchet.unit.test.ts` 全文，确认它对**下降不 fail**、且重冻结靠人跑脚本（:5、:10、:58、:62）。
- 清点 `src/lib` 下 20 个 barrel、`export *` 使用情况（仅 3 个 barrel 用），统计两个目标 barrel 的穿透规模（`~/lib/error` 113 个文件、`~/lib/observability` 73 个文件）。
- 对账 `eslint.config.js:146` 的实际 glob 与 `src/lib/observability/index.ts:12` 的契约注释（发现既有漂移）。
- 对账 `package.json:56` 的 `test:backend` 定义与计划 §7 的命令注解（发现注解不实）。
- 对账 master 与分支各自 committed 的 `circular-deps-baseline.json`（70/63 vs 43/50），确认 `65c5654c` 不是 master 祖先、merge-base 之后 master 有 3 个 commit 动过 `src/lib`。

**第一人称执行模拟了哪些流程 / 分支**

- **实跑了 N1 的三个执行分支**（在 `/tmp` 的导出副本上，非仓库）：把三个类型搬进 `src/lib/diagnostics/vocabulary.ts` 后，
  - **v1 = 完全照 N1 字面**（owner `export type … from` re-export + **消费端零改动**）→ `computeCircularSnapshot()` = **43 环 / 50 成员**，且环集合与基线**逐字相同**（ratchet 绿）；
  - **v2 = v1 + 把两个类型模块的 import 改指叶子（只搬 3 个类型，`AskNormalizationDiag` 留在原处）** → **19 / 29**；
  - **v3 = v2 + 把 `AskNormalizationDiag` 一并搬走** → **19 / 29**（与 v2 相同）。
  基线本身我也独立复现为 **43 / 50**，与计划 §2 一致。
- 模拟「执行方看到 43 环怎么办」这条分支：按计划 :77 的证伪指引会去重跑基线并得出「合并后的图变了」——**错误结论**。
- 模拟 N2 的三步：写下 `from "@hsupu/ghc-proxy-foundation"` 会发生什么、写下 `from "./bus"` 在 `history/state.ts` 里解析到哪里、以及要实现「owner 是不是 barrel 自己」需要哪些 AST 能力、判据一旦全仓化会命中多少文件。
- 模拟 N3：在 `docs/coding-conventions.md` 的现有章节结构里找落点，在 `docs/DESIGN.md:118`「类型架构（single-source-of-truth）」节留指针。
- 模拟「同伴合并后我怎么知道前提还成立」：查 §2 的 PoC 是否可重放（已删且无编辑清单）、计划是否给了任何前提指纹（没有）。

## 事实性发现

### BLOCKER-1 —— N1 照字面执行削 0 个环，而且全绿

**位置**：计划 :74（N1「做什么」，「消费端零改动」）与 :75（验收判据①「应落在 19 环 / 29 成员附近」）自相矛盾；:19（§2 PoC A 描述）才是真动作。

**证据（实测，非推理）**：在 `65c5654c` 的导出副本上跑 `computeCircularSnapshot()`：

| 变体 | 内容 | 环 / 成员 |
|---|---|---|
| 基线 | —— | 43 / 50 |
| **v1 = N1 字面** | 三类型搬进叶子 + 三个 owner `export type … from` re-export + **消费端零改动** | **43 / 50**（环集合与基线**逐字相同**） |
| v2 | v1 + `history/types.ts:20-21`、`context/types.ts:4,6` 的 import 改指叶子 | 19 / 29 |
| v3 | v2 + `AskNormalizationDiag` 也搬 | 19 / 29 |

原因很直白：撑起那 24 个环的是**消费端的边**（`src/lib/history/types.ts:20` → `~/lib/anthropic/sanitize/assistant-block-layout`、:21 → `~/lib/codec/openai-responses/buffered-merge-reducer`，`src/lib/context/types.ts:6` 同）。类型定义搬到哪儿不改变这些边；只有把 import **改指叶子**才削。owner 的 re-export 是给**其它**消费者（`src/lib/anthropic/sanitize/result.ts:9`、`src/lib/anthropic/decode-tool-input.ts:34,36`）保路径用的，它本身**新增**一条 owner→叶子的边（无害，叶子无出边），削环贡献为零。

**执行方会因此做出什么错误动作**：老老实实按 N1 做完（搬 + re-export + 不动消费端），`bun run typecheck` 绿、`circular-deps-ratchet` 绿（环集合逐字未变，守卫按设计不会响）、全后端绿——**没有任何一个门禁报警**。然后执行方手工核对验收①，发现是 43 不是 19，于是按 :77 的证伪指引「别调期望值去迁就，先重跑 §2 的基线」去重测基线，得到 43，进而得出「合并后的图变了 / PoC 数字不可信 / 这个方案没用」——**完全错误的归因**，最可能的结局是把一个正确方案判死，或者提交一个零收益却看起来完成的 commit。

**修法**：把 N1 的「做什么」改写为三个动作，且**第 3 条要标成削环的唯一来源**：
1. 建零依赖叶子，把 `BufferedMergeDiag`（含 `TerminalRepairReason`）、`BlockLayoutRepairStats`、`SendMessageNormalizationDiag` 搬过去；
2. 三个 owner 改 `export type { … } from "<叶子>"`（**目的是保住既有消费者的 import 路径，不是为了削环**）；
3. **把 `src/lib/history/types.ts:15-21` 与 `src/lib/context/types.ts:1-6` 的这些 import 改指叶子——环是被这一步削掉的。**
并把括注从「消费端零改动」改成「消费端**可以**零改动，但那样一个环都削不掉；两个类型模块必须改指」。

### BLOCKER-2 —— N2 的 `ApiError` 直取目标不存在，照抄不编译

**位置**：计划 :82（「改从 `@hsupu/ghc-proxy-foundation` 直取」）；`packages/foundation/src/index.ts`（全文 11 行，**没有任何 `./error/*` 的 re-export**）；`packages/foundation/src/error/classify.ts:30`（`ApiError` 真正的家）；`tsconfig.json` 的 `paths` 已把 `~/lib/error/classify` 直接映到该文件。

**旁证**：整个 `src/` 里**没有一处**裸包名 `from "@hsupu/ghc-proxy-foundation"`，只有 2 处子路径形态（`@hsupu/ghc-proxy-foundation/ghc-model-types`）。计划提议的 import 形态在本仓无先例。

**执行方会因此做出什么错误动作**：照抄 → `TS2305: Module '@hsupu/ghc-proxy-foundation' has no exported member 'ApiError'`。此时最顺手的「修复」是给 `packages/foundation/src/index.ts` 补一行 `export * from "./error/classify"`——**那恰恰是 N2 要禁的 barrel 穿透**（把一个符号塞进一个它不属于的公共面），而且无谓放大 foundation 的公共面、给它引入一条 `export *`（本仓 20 个 barrel 里只有 3 个用 `export *`，且 `source-ast.ts` 明确说 `export *` 是结构守卫最难处理的形态）。第二种错误动作是执行方就此认为「B 类边其实修不了」，把 N2 的这一半跳过。

**修法**：把目标写死为 `import type { ApiError } from "~/lib/error/classify"`（别名已直指 foundation，零新增概念），或 `@hsupu/ghc-proxy-foundation/error/classify`；并加一句「**不要**为此扩大 foundation 根 barrel」。顺带说明这两种写法的取舍（前者与全仓 `~/lib/error/*` 用法一致，后者更早暴露包边界），让执行方不必自己拍。

### BLOCKER-3 —— N2 的守卫判据既没有现成工具，形态本身也会「禁掉全部 barrel」

**位置**：计划 :83（「若某符号的 owner 不是该 barrel 本身，则不得经该 barrel import 它」，「形态参考 telemetry allowlist 检测器」）与 :86（「需要 AST 判定，别用正则」，风险评为「低」）。

**核查结果，两层问题**：

**(a) 现成工具不存在，而且这条路本仓已经判定为死路。** `tests/architecture/source-ast.ts` 提供的是 `publicExportNames`（枚举一个文件的公共**面**）、`allModuleSpecifiers` / `typeOnlyModuleSpecifiers`（枚举 specifier）、`valueStarReExports`、以及调用图助手——**没有任何跨文件的 symbol→owner 解析**。它的头部注释还专门写了这件事被放弃的经过：「Provenance tracing is a losing game — three review rounds walked it down through aliases, local re-export hops, `default`, namespace objects, `const` wrappers and cross-file chains, and each depth only closed the bypass someone had just demonstrated.」计划引用的 telemetry 检测器（`package-boundaries.unit.test.ts:87`、:99）是 **specifier 级 allowlist**（「这个 specifier 在不在允许集合里」），与 symbol 级 provenance 不同形，参考它并不能省掉任何一步。

**(b) 判据按字面全仓化会命中每一次 barrel 使用。** `src/lib/error/index.ts` 全文 5 行、**每一行都是 `export … from`**，它自己什么都不拥有；`src/lib/observability/index.ts` 全文 38 行，只有 4 条 re-export 语句，同样什么都不拥有。也就是说「barrel 自己拥有的符号」在这两个 barrel 上是**空集**，判据将判定 `~/lib/error` 的 113 个导入方和 `~/lib/observability` 的 73 个导入方**全部违规**。计划 :85 的正样本②「经 barrel 取本 barrel 拥有的类型（合法，新判据不得咬）」在这两个 barrel 上**构造不出来**——正控本身无法成立。

**执行方会因此做出什么错误动作**：三条路都错。① 一头扎进写跨文件 symbol 解析器，重走 `source-ast.ts` 头部记录过的三轮弯路（别名、`export *`、`import { op as x }; export { x }`），这是个开放式工程，被计划标成「风险：低」；② 或者按字面执行判据，去改 186 个文件的 import，把 subsystem 公共面这个抽象整体拆掉——一个计划从未授权、用户也没裁决过的架构变更；③ 或者自己悄悄把判据收窄成「只咬 `~/lib/error` 与 `~/lib/observability` 的这两个具体符号」，那就退化成硬编码两行，守不住 :57 承诺的「下次有人写 `from "~/lib/error"` 拿类型又会长回来」。

**修法**：把判据翻转成**本地可判定**的形态，并写进计划（这不是收窄范围，是换一个能实现的等价形状）：
1. 对**列入名单的 barrel**，用 `parseSource` 枚举它自身的 `export … from "X"` 子句 → 直接得到「名字 → 它真正的 owner specifier」映射（**这一步只需读 barrel 一个文件**，`error/index.ts` 与 `observability/index.ts` 都是 100% 显式具名 re-export，完全可枚举）；
2. 全仓扫 `allModuleSpecifiers` + 具名 import 子句，凡是从该 barrel 取到映射表里的名字，即为穿透，报错信息直接给出「应改指 `X`」；
3. `export *` 的 barrel（`system-prompt` / `ws` / `models/calibration` 三个）需多一跳：解析 `X` 后取 `publicExportNames(X)`。**先不把它们列入名单**，并把这条限制写进计划而不是留给执行方发现。
4. 名单范围（两个 vs 全部 20 个 barrel）正是 §5-2 要用户裁决的，但**必须补上一句判据前提**：barrel 的正当用途是 subsystem 公共面，所以规则该表述为「**类型**穿 barrel 取 → 违规（type-only 边最容易长环，且改指零成本）」还是「任何符号穿 barrel 取 → 违规（等于禁用 barrel）」——这两个的工作量差一个数量级，用户没有这条信息无法裁决 §5-2。

另外补一条 :84 缺的验收：**「全仓无同型穿透」需要给出可复算的命令**（守卫测试本身就是那个命令，跑它即可），否则「扫一遍」是个没有终止条件的动作。

### MAJOR-4 —— N1 削环后没有重冻结基线，导致 N2 的验收判据②形同虚设

**位置**：计划 :70（「SCC 只减不增（`circular-deps-ratchet` 守卫）」）与 :84（N2 验收②「环数不回升（用 ratchet 的**集合差**，不是计数）」）；`tests/architecture/circular-deps-ratchet.unit.test.ts:5,10,58,62`。

**证据**：ratchet 是「只在**新增**时 fail」，下降不 fail，重冻结靠人手跑 `bun run scripts/update-circular-deps-baseline.ts`（守卫头部与失败信息里都写了）。计划全文**没有一处**提到这个脚本或提交 `circular-deps-baseline.json`。

**执行方会因此做出什么错误动作**：N1 把环削到 19 后不重冻结，committed baseline 仍是 43 环 / 50 成员。于是 N2（乃至之后任意一个 peer 会话）把那 24 个环里的任何一个加回来，ratchet 依然全绿——因为它们都还在基线集合里。N2 的验收②「用 ratchet 的集合差」此时**衡量的是一个已经过期的集合**，执行方以为自己有护栏，实际上护栏对刚打下来的战果完全无感。

**修法**：给 N1 补第 4 条验收：「跑 `bun run scripts/update-circular-deps-baseline.ts`，把 `tests/architecture/circular-deps-baseline.json` 与代码改动**同一个提交**落地；重冻后 ratchet 仍绿」。并在 N2 的验收②里点明「集合差是相对 N1 重冻后的基线」。

### MAJOR-5 —— 「在哪棵树上开工、什么时候开工」没有定义，而唯一的 checkout 是禁区

**位置**：计划 :4（核验基线 = 分支 tip）、:110-111（§7 接手须知）。

**证据**：`65c5654c` **不是** master 的祖先；master 上 committed 的 `circular-deps-baseline.json` 是 **70 环 / 63 成员**，分支上是 43 / 50；merge-base 是 `a675064e`，此后 master 另有 3 个 commit 动过 `src/lib`。而 `feat/state-foundation` 唯一的工作区是 `.worktrees/state-foundation`——计划 :111 自己划为禁区。

**执行方会因此做出什么错误动作**：新会话默认在主树 master 上开工（计划没说别的），量到 ~70 环、找不到 §3 描述的那条长环形状，然后要么按 master 的图重做分析（浪费且结论会与计划冲突），要么误以为自己读错了计划。次糟的分支：为了对上数字而进禁区 worktree 动手，直接踩到同伴的活跃工作区。

**修法**：§7 补一节「什么时候可以开始」，给三选一并写清判据：(a) **推荐**——等 `feat/state-foundation` 合回 master 后，在主树基于 master 起新 worktree 执行（此时 §2 的基线需重测，见 MAJOR-6）；(b) 若必须先行——从 `feat/state-foundation` 的 tip **另起一个自己的分支 + 自己的 worktree**（绝不进 `.worktrees/state-foundation`），并接受合并后 rebase；(c) 明确不可选——在 master 上按本计划的数字执行。

### MAJOR-6 —— 「合并后重跑 §2 的四次测量」不可执行，且没给任何「同伴改了东西」的检测手段

**位置**：计划 :5（「PoC 在 `/tmp/scc-poc`（detached，已还原并删除）」）、:110（「合并落地后第一件事是重跑 §2 的四次测量」）。

**证据**：四个 PoC 的树已删除，§2 只留散文描述。我这次重建时踩到的具体歧义：A 行写「`history/types.ts` 与 `context/types.ts` 的 **5 条 import** 改指叶子」——按 import **语句**数才是 5 条，而其中两条语句里各含 `AskNormalizationDiag` + `SendMessageNormalizationDiag` 两个名字（`src/lib/history/types.ts:15-19`、`src/lib/context/types.ts:1-5`）。按「5 条语句都改指」理解会连 `AskNormalizationDiag` 一起搬（我的 v3），按「只搬计划列的 3 个类型」理解则第 4 个留在原处（我的 v2）。两者环数**恰好都是 19 / 29**，所以这次没造成数字分歧——但这是运气，不是计划说清楚了。

**执行方会因此做出什么错误动作**：要么跳过重测（于是丢掉计划自己指定的证伪锚点，后面所有偏差都无从归因），要么凭散文重建四个 PoC（我花了三轮才把 v1/v2/v3 的语义分清），而且重建出的 A 到底是 v2 还是 v3 语义无从确定。更关键的是：**同伴在合并时若因冲突改了这几个文件，执行方没有任何手段发现**——计划只说「结构性结论大概率不变」并诚实标注这是推断，但没给检测方法。

**修法**：
1. 把「重跑四次测量」降级为「重跑**基线**一次 + N1 落地后实测一次」（B/C 的边际值只有 1 环，重跑它们对决策没有信息量）；
2. 补一组**可复算的前提谓词**，让执行方在合并后一条命令验完：
   - `git log --oneline 65c5654c..HEAD -- src/lib/context/types.ts src/lib/history/types.ts src/lib/codec/openai-responses/buffered-merge-reducer.ts src/lib/anthropic/sanitize/assistant-block-layout.ts src/lib/anthropic/decode-tool-input-core.ts` 为空 → 前提未被合并触碰；
   - 非空则逐条核对：三个类型仍由那三个 owner 定义、两个类型模块仍从 owner 直接 import；
   - `computeCircularSnapshot()` 的 count 记录为新基线（**不必等于 43**，重要的是 N1 前后的差）。

## 主观建议 / 次要事实性发现

### MINOR-7 —— 「`export … from` 不绑定本地名」写成了条件句，实际三个 owner 全部命中

**位置**：计划 :78（「owner 模块内部**若**自用该类型，需另行 import」）。

**证据**：三个 owner **全部**自用——`buffered-merge-reducer.ts:73,110,118,127,193`（`TerminalRepairReason` 与 `BufferedMergeDiag` 都用）、`assistant-block-layout.ts:116,180,181`、`decode-tool-input-core.ts:276`。

**执行方会因此做出什么错误动作**：把它当罕见情况，只在报错处逐个补。typecheck 会咬住所以不会静默错，但在 `verbatimModuleSyntax` + `erasableSyntaxOnly` 下正确形态是**成对**的（`export type { X } from "<叶子>"` **加** 一条独立的 `import type { X } from "<叶子>"`），计划没给这个样板，执行方容易先试 `export type { X }` + 本地 `X` 引用、再试重复声明，绕两圈。

**修法**：把「若」改成「三个 owner 都需要」，并附一段 4 行样板。

### MINOR-8 —— 漏了第四个同型类型 `AskNormalizationDiag`（不承重，但与 N3 的约定自相矛盾）

**位置**：计划 :44（同型类型清单）；`src/lib/anthropic/decode-tool-input-core.ts:162`（定义，与 `SendMessageNormalizationDiag:253` 同一个 owner、同一个形状，注释里自己写着「parallel to `AskNormalizationDiag`」）；消费点 `src/lib/context/types.ts:3`、`src/lib/history/types.ts:17`（与 `SendMessageNormalizationDiag` **同一条 import 语句**）。

**实测**：搬（v3）与不搬（v2）**环数完全相同（19 / 29）**——它不是承重项，我不把它说成削环收益。

**执行方会因此做出什么错误动作**：两个方向都可能错。① 按 §2-A 的「5 条 import」措辞把整条语句改指叶子，却发现叶子里没有 `AskNormalizationDiag` → 临时决定要不要一起搬，而计划没授权；② 或严格只搬 3 个，于是 `context/types → decode-tool-input-core`、`history/types → decode-tool-input-core` 两条 type-only 边留着，而 N3 马上要写下的约定（诊断类型归零依赖词汇叶子）**第二天就有一个仓库内的反例**，且是同一个文件里的孪生类型。

**修法**：在 :44 补上第四个类型，明写「一并搬，环数收益为 0，理由是 N3 约定的自洽」；同时把 §2-A 的措辞从「5 条 import」改成按**类型名**计数，消除语句/名字的歧义。

### MINOR-9 —— 建议落点 `src/lib/diagnostics/vocabulary.ts` 与既有子系统撞名，且该目录本身就在环里

**位置**：计划 :74、:96（§5-1 选项 a）。

**证据**：`src/lib/diagnostics/` 是**结构化日志子系统**（`types.ts` 里是 `DiagnosticLevel` / `DiagnosticValue` / `DiagnosticError`，另有 `logger.ts`、`file/*` sink），与「请求诊断产物类型」完全是两件事；更要紧的是 `src/lib/diagnostics/index.ts` 与 `src/lib/diagnostics/logger.ts` **本身就是当前 43 环的成员**（实测成员表）。

**执行方会因此做出什么错误动作**：在一个既有 barrel 目录里新建文件，非常自然地顺手在 `src/lib/diagnostics/index.ts` 里加一行 re-export（该目录的既定风格），**一瞬间把新叶子接进 SCC**，N1 的收益全部归零——而且没有任何守卫会报警（ratchet 只看新增环，叶子进环若不构成新环则无声）。次生问题：`diagnostics/vocabulary.ts` 与 `diagnostics/types.ts` 并排，后来者无法从名字分辨谁是日志词汇、谁是请求诊断词汇。

**修法**：不论 §5 最终选哪个落点，都在 N1 里写死两条：① **叶子不得被任何 barrel re-export**；② 加一条零出边守卫——用现成的 `allModuleSpecifiers(parseSource(leaf))` 断言为空数组（工具已有，成本几行），并配一个正控（给叶子加一条 import 必须变红）。这条守卫也正好补上 :76「鉴别力正控」目前只覆盖「重复定义」的空缺。若最终选 §5-1(a)，另建议换一个不与日志子系统撞名的落点。

### MINOR-10 —— `./bus` 在 `history/state.ts` 里解析不到，且 barrel 头注释会误导执行方

**位置**：计划 :55、:82（「`history/state.ts` 的 `ScopedPublisher` 改从 `./bus` 直取」）。

**证据**：`src/lib/history/state.ts:1` 现在是 `import type { ScopedPublisher } from "~/lib/observability"`；`ScopedPublisher` 定义在 `src/lib/observability/bus.ts:73`。在 `history/state.ts` 里写 `./bus` 解析为 `src/lib/history/bus`——**不存在**（`src/lib/history/` 下只有 `v3/terminal-bus.ts`）。正确写法是 `~/lib/observability/bus`。

附带一个既有陷阱：`src/lib/observability/index.ts:12` 的依赖契约注释写着「`lib/{request,anthropic,openai,gemini,history,ws}/` MUST NOT import from this module」，但 `eslint.config.js:146` 的实际 glob 是 `src/lib/{request,anthropic,openai,gemini,ws}`——**history 不在内**，而且同一段注释后文自己写明「`lib/history/*` is exempt」。这是既有文档漂移，不是本计划引入的。

**执行方会因此做出什么错误动作**：照抄 `./bus` → 模块解析失败（自纠成本低，但白费一轮）。更值得防的是第二个：执行方为了搞清能不能改，去读 barrel 头注释，得到「history 根本不该 import observability」的错误结论，于是要么把改动扩大成一次 DI 重构（远超本计划范围），要么判定这条边动不了而跳过。

**修法**：计划里把路径写全为 `~/lib/observability/bus`；并加一句「`src/lib/observability/index.ts:12` 的契约注释与 `eslint.config.js:146` 的实际 glob 不一致（history 实为豁免），别被它带偏——顺手修注释可以，但不属于本计划」。

### MINOR-11 —— §7 的测试命令注解不实，会诱导执行方把真红当环境问题

**位置**：计划 :113（「`bun run test:backend` 在本机因无 rustup toolchain 必挂」）。

**证据**：`package.json:56` 里 `test:backend` **就是** `bun scripts/parallel-test.ts unit it http`，与计划推荐的命令逐字相同；且按 CLAUDE.md（2026-07-28 起），各测试档位脚本**已不再构建** `native/history-search`，依赖它的测试走 `describe.skipIf(!isNativeHistorySearchAvailable())`——有产物就跑、没有就显式 skip，**不会红**。会构建 native 的只有 `test:ci`。

**执行方会因此做出什么错误动作**：带着「本机跑全后端注定挂」的预期开工，于是把 N1 引入的**真实**失败当成「已知的 toolchain 问题」挥手放过——这正是 CLAUDE.md 记下的 2026-07-28 那次事故的形状（「环境性的红太容易被当成既有失败挥手放过」）。

**修法**：改成「用 `bun run test:backend`（= `unit it http`，不构建 native；依赖 native 的测试自动 skip）」，删掉 toolchain 说辞。

### NIT-12 —— N3 缺依赖声明与验收判据

**位置**：计划 :88-91。

**证据**：两个落点都存在——`docs/coding-conventions.md`（现有章节：代码风格 / 发射与识别两条轴 / 配置读留在装配层 / 注释规范 / 测试组织 / 实现前门禁 / 依赖选型 / 诊断日志），`docs/DESIGN.md:118`「类型架构（single-source-of-truth）」。

**执行方会因此做出什么错误动作**：N3 的约定文本必须点名 §5-1 最终定下的**实际落点路径**，所以 N3 隐含依赖 §5-1 与 N1 完成；计划把它排在最后但没说这层依赖，执行方若并行起草会写出指向 `src/lib/diagnostics/vocabulary.ts` 的约定，而最终落点可能是按域分的 (b)。另外 N3 没有验收判据，容易停在「写了一段话」。

**修法（2026-08-08 按 `one-authority-allows-contextual-restatement` 更新）**：标注「N3 依赖 §5-1 的裁决与 N1 的落地」；coding-conventions 新增权威约定节，DESIGN.md 类型架构节可按架构语境完整概述并引用该节；用跨文档 grep 确认两处权威指向、语义与 N1 实际落点一致。旧建议中的“DESIGN 只能留指针／同一事实只写一处”已被新规则取代，不再作为验收条件。

### NIT-13 —— N1 / N2 与 §5 的门控关系没写出来

**位置**：计划 :74（「建议 `src/lib/diagnostics/vocabulary.ts`，命名待评审」）、:82，对照 §5（:93「需要你裁决的（**别自己拍**）」）。

**执行方会因此做出什么错误动作**：N1 读起来像「有默认值、可以直接开工」，执行方按 (a) 建好叶子、搬完、提交，用户随后裁决 (b) 按域分——整个 N1 返工。N2 更极端：§5-2 的裁决决定它是改 2 个文件还是覆盖 20 个 barrel / 186 个导入方，执行方无法估工。

**修法**：在 N1、N2 标题下各加一行「**Blocked on §5-1 / §5-2**：未裁决前不得开工」，并把 §5-2 的两个选项各补一个量化影响（已知穿透点 2 处 vs 全覆盖需处理 `~/lib/error` 113 个导入方 + `~/lib/observability` 73 个导入方，且判据形态需先解决 BLOCKER-3(b) 的「barrel 自己什么都不拥有」问题）。

## 计划中经核查**成立**的部分（避免只报问题造成误判）

- §2 基线 43 环 / 50 成员：我独立复现一致。
- §3.1 的结构性论断：三个类型确实由实现模块拥有、被两个类型模块消费，边确实是 `import type`（madge 计入 type-only 边，`source-ast.ts` 与 telemetry 守卫的注释也都以此为前提）。
- 三个类型的**可叶子化**：三个 interface 的字段全是原语 / 字面量联合 / 数组，唯一的跨类型引用就是计划已经点名的 `TerminalRepairReason`（同文件）。搬迁不会拖入新依赖。
- **无测试文件消费这三个类型**（`git grep` 覆盖 `tests/`），N1 无测试改动面。
- §3.2 关于 `ApiError` 真正住在 `packages/foundation/src/error/classify.ts` 的判断正确（只是 N2 给的 import 目标错，见 BLOCKER-2）。
- §6 把 `observability/bus ↔ events ↔ context/types` 与 history 内部环排除在外：与我实测的 v2/v3 剩余 19 环的成员分布一致，这两处确实需要真设计。
- 计划自己标注的「这些 PoC 没有证明什么」（:25）与「这句话本身是推断、不是实测」（:110）是诚实且有价值的自我限定——本报告的多数修法是把这些限定**变成可执行的检查**，而不是推翻它们。
