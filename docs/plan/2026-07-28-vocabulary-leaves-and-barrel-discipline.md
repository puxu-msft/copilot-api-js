# 计划：下一步解环 —— 词汇层剥离 + barrel 纪律（第四次剥离的前置）

> **状态**：草稿·已过两个视角评审并整改，**待用户裁决 §5 + 一轮复审**后定稿。
> **核验基线**：`65c5654c`（分支 `feat/state-foundation` 的 tip，2026-07-28）。**不是 master**——state→foundation 由同伴正在收尾、尚未合回主线。**开工位置与前提复算见 §7，别直接在 master 上照本文数字执行。**
> **工作区**：本文档在主树写、即时提交。
> **已跑门禁**：`computeCircularSnapshot()` 实测（§2）。**typecheck / 测试未跑**——PoC 只改 import 指向来量环，不构成可交付实现。
> **评审**：两个正交视角，**全部发现均已采纳、无一驳回**——[执行方视角](2026-07-28-vocabulary-leaves-review-claude.md)（3 BLOCKER / 3 MAJOR / 5 MINOR / 2 NIT）+ [判据证伪视角](2026-07-28-vocabulary-leaves-review-gpt.md)（0 BLOCKER / 7 MAJOR / 2 MINOR，四个数字独立复现一致）。本版是第 3 版。

## 1. 结论先行

**下一步最高价值的解环动作不是「再拆一个包」，而是把 core 里的词汇类型剥成叶子、并给 barrel 立规矩。** 实测它一步把环从 **43 削到 19**。

关于 backlog 里排在「state 第一」之后的 vendor 纵切（anthropic/openai/gemini），**只能说这一条经实测的窄结论**：三个 vendor 目录**当前完全不参与 SCC**（cycles=0、members=0），因此**本轮的减环收益为 0**。

> ⚠️ **第 1 版在这里写了「不做 N1–N3，vendor 纵切 day-1 走不通」——那是没有证据的因果断言，已删除。** 「当前不是承重点」与「当前拆不动」是两个命题，现有数据只支持前者；而 vendor 对 core 的出边（`gemini/convert-stream → history/types`、`openai/upstream-ws-attempt → pipeline/types`、`anthropic/tool-input-repair-stats → context/types` 等）**多数不会因 N1/N2 而消失**。要主张先后顺序，须补一个最小 vendor extraction PoC（枚举全部出边 + 分类可注入/可下沉/必须留 core + 实测 N1–N3 前后差集）。**在那之前，vendor 纵切应视为独立并行单元，不被本计划挡住。**

## 2. 实测（分支 tip `65c5654c`，post-state）

| 变体 | 内容 | 环 / 成员 |
|---|---|---|
| 基线 | —— | **43 / 50** |
| **A** | 四个诊断类型搬进零依赖叶子 + **`history/types.ts` 与 `context/types.ts` 对它们的 import 改指叶子** | **19 / 29** |
| B | A + `context/types.ts` 的 `ApiError` 绕开 `~/lib/error` barrel | 18 / 29 |
| C | B + `history/state.ts` 的 `ScopedPublisher` 绕开 `~/lib/observability` barrel | 18 / 27 |

> **口径按类型名计，不按 import 语句计**（`AskNormalizationDiag` 与 `SendMessageNormalizationDiag` 同处一条语句）。实测搬 3 个与搬 4 个**环数相同（19/29）**，第 4 个不是承重项——一并搬的理由是 N3 约定的自洽，见 N1。
>
> **⚠️ 削环量几乎全部来自 A，而 A 的削环来自【消费端改指】而非【类型搬家】。** 评审实测：只搬类型 + owner re-export、消费端不动 → **43/50，环集合与基线逐字相同**。这一点是本计划最容易被执行错的地方，N1 里再钉一次。

**这些 PoC 没有证明什么**：只改了 import 指向与类型副本，**没有** typecheck 绿、**没有**测试绿、**没有**处理 owner 侧 re-export 与重复定义。A 用的是**复制**类型定义（真实现必须是搬迁 + owner re-export，否则双份维护）。**B 的 PoC 写法本身是错的**（用了裸包名 `@hsupu/ghc-proxy-foundation`，madge 能解析但 TypeScript 会 TS2305——见 N2）。环数是唯一被证明的东西。

## 3. 承重结构：少数几条 type-only 边就能切断多数环

43 个环里有 26 个含相邻边 `context/types → error/index`，其中 **22 个**走下面这条完整主干（另 4 个走 shutdown/ws 或更短的 `context/request` 环）：

```
context/types → error/index → error/forward → context/request
  → context/activity-summary → history/store → history/entries → …
  → history/types → codec/openai-responses/buffered-merge-reducer
  → pipeline/frame-origin → pipeline/types → context/types
```

**⚠️ 措辞更正（第 1 版写错）**：不是「这条长环全是 type-only 边」。实测 43 个环里**只有 1 个**全部由 type-only 边构成，其余 42 个**都含 value edge**——上面链条里 `buffered-merge-reducer → pipeline/frame-origin` 是值 import（`tagFrameSynthetic`）、`error/index → error/forward` 是值 re-export。正确的说法是：**多数环可以被少数几条 type-only 边切断**——「环的组成」与「我们选来切的那条边」是两回事。混淆它们会诱导执行者对真正的 value edge 也用「搬类型」这一招。

本轮选来切的 cut edge 分两类，**修法完全不同**：

### 3.1 【A 类】诊断/词汇类型被**实现模块**拥有

`BufferedMergeDiag` 定义在 `codec/openai-responses/buffered-merge-reducer.ts`（一个 reducer 实现），却被 `history/types.ts` 与 `context/types.ts` 两个**类型模块**消费。于是「类型模块 → 实现模块」的边把 codec 拽进了 history/context 的环里。

同型的还有 `BlockLayoutRepairStats`（住 `sanitize/assistant-block-layout.ts`）、`SendMessageNormalizationDiag` 与 `AskNormalizationDiag`（同住 `anthropic/decode-tool-input-core.ts`，源码注释里自称 parallel）。

**这与上一轮 state 的承重边是同一个形状**：`state-defaults.ts` 为了三个字符串常量 import `recover-refusal.ts`。**产物类型跟着产它的代码走，是自然而然写出来的，也正是环的来源。**

实测这些类型各自只有 **3–4 个域外消费文件**（原文的「3–5」把 owner 自身算进去了）、**零测试文件消费**——爆炸半径极小，与它们撑起的 24 个环完全不成比例。

### 3.2 【B 类】类型经 **barrel** 取，而 barrel 同时导出实现

两个实例，都不是真依赖：

- `context/types.ts` 取 `ApiError`，走 `~/lib/error` —— 而 **`ApiError` 住在 `packages/foundation/src/error/classify.ts`**。core 的 `error/index.ts` 只是 re-export 它，同时还导出 `forwardError`（`forward.ts`，带 Hono `Context` + `RequestContext`）。于是一个「取 foundation 里的类型」的动作，把整个 core error 模块拉进了环。
- `history/state.ts` 取 `ScopedPublisher`，走 `~/lib/observability` barrel —— 而它在 `observability/bus.ts:73`。barrel 同时导出 `createBus` / `getBus` 等实现。

**这类边的修法本身是零成本的**（改 import 指向），但**靠人自觉不可持续**——需要机器守卫，否则下次有人写 `from "~/lib/error"` 拿类型又会长回来。**⚠️ 守卫的判据形状是个真问题，见 N2。**

### 3.3 剩余的环（A+B+C 之后的 18 个）

**不止两处**（第 1 版写成「集中在两处」，实测不成立）。C 之后打印全部 18 个环，至少有这些**互相独立**的簇：

| 簇 | 性质 |
|---|---|
| `observability/bus ↔ events ↔ context/types` | 事件目录反向依赖域类型——需真设计 |
| `history/store → entries → state → observability/bus` | history 内部环 + 对 observability 的发布依赖 |
| `codec/{anthropic,openai-cc,openai-responses}/*-cell ↔ pipeline/cell-assembly` | **三个独立环** |
| `context/activity-summary ↔ context/request` | context 内部 |
| `history/v3/projection ↔ history/v3/store` | History V3 内部 |
| `pipeline/rewrite-registry ↔ pipeline/types` | pipeline 内部 |
| `transport/http2-client ↔ transport/upstream-fetch` | transport 内部 |
| `tui/render/detail ↔ tui/render/panel` | TUI 内部 |
| `error/index → error/forward` | base 29 环 → A 后 5 → B/C 后 4 |

**本计划一处都不处理**，留给下一轮（见 §6）。**下一轮别按「只剩两处」设计**——那样做完仍会剩下 codec / transport / TUI / pipeline 好几簇。

## 4. 提议的执行顺序

> 通用不变量（每 commit）：typecheck 绿 + `bun run test:backend` 绿 + 精确 pathspec lint 绿。
> **SCC 数字一律 `computeCircularSnapshot()` 实测**，禁止从 `circular-deps-baseline.json` 的环列表推算。

### N0 —— 先修 ratchet 的数学对象（**N1 的前置，且是一条既有缺陷**）

> 这一步不是本计划原有的，是判据证伪视角实测揪出来的。**它修的是既有基建，不是我引入的问题**——但不修，N1 的门禁会以一种无法解释的方式变红。

**问题**：`circular-deps-ratchet` 比较的是 `computeCircularSnapshot()` 产出的 **canonical cycle 字符串集合**，而这个集合**对删边不单调**：

- `graph.circular()` 是**非完备枚举**。snapshot 只把「起点旋转」规范化了（源码注释明说是为了「madge 从不同起点列同一个环」），但删掉一条边后，madge 会**改选此前根本没被列出的既存环**作为输出——于是凭空冒出「新环」。
- **实测**：N1 的 PoC 相对基线 `newCycles=4`（`newMembers=[]`）。这 4 个不是新造的依赖环，是重新枚举的产物。而 ratchet 断言 `expect(newCycles).toEqual([])` → **对一个纯粹的改进变红**。
- **计数同样不可靠**：实测 B→C 两侧 `count` 都是 **18**，实际是 **6 出 6 进**（`removedCycles=6, addedCycles=6, sameSet=false`）。同一个数字完全掩盖了集合的整体置换。

**两条判据都不成立**——这一点值得单独记：我在别处一直主张「计数换集合差」，但**集合差只在集合本身良定义且稳定时才更强**；当底层枚举本身不完备、不规范时，集合差继承了它的不稳定性。

**做什么**：把 ratchet 的比较对象换成**对删边单调**的量。推荐从 madge 的依赖图直接算：

- **SCC 成员集**（哪些文件在环里）——删边只会让它缩小；
- **SCC 内部有向边集**（环内部的边）——删边只会让它缩小。

对这两个集合做差，断言「无新增成员、无新增 SCC 内边」。

**鉴别力正控（三条，缺一不可）**：

1. 新增一条 SCC 内的回边 → **必须红**；
2. 删掉一条边、即使 cycle 枚举整体重排 → **必须绿**（这条正是现有守卫失败的地方）；
3. 一删一增、使 count 不变 → **必须红**（这条正是计数失败的地方）。

**为什么必须排在 N1 前面**：不修 N0 就做 N1，你会得到「环从 43 降到 19、但架构守卫红了 4 个新环」这个自相矛盾的局面，而唯一顺手的出路是重冻基线——那等于把「删边导致的重新枚举」和「真新增环」一起闭着眼接受。

### N1 —— 建词汇叶子，搬四个诊断类型　【**Blocked on §5-1**：落点未裁决前不得开工；**前置 N0**】


**做什么（三个动作，第 3 条是削环的唯一来源）**：

1. **建零依赖叶子**（落点见 §5-1），把 `BufferedMergeDiag`（含同文件的 `TerminalRepairReason`）、`BlockLayoutRepairStats`、`SendMessageNormalizationDiag`、`AskNormalizationDiag` **搬**过去。
   - ⚠️ **落点不要用 `src/lib/diagnostics/`**：那是既有的**结构化日志子系统**（`DiagnosticLevel` / `logger.ts` / `file/*` sink），概念完全不同；而且 `diagnostics/index.ts` 与 `logger.ts` **本身就是当前 43 环的成员**，在那个目录里新建文件、再顺手在它的 barrel 里加一行 re-export，会一瞬间把新叶子接进 SCC，收益全部归零且无守卫报警。
2. **三个 owner 模块改 `export type { … } from "<叶子>"`** —— 目的是**保住既有消费者的 import 路径**（`anthropic/sanitize/result.ts:9`、`anthropic/decode-tool-input.ts:34,36`），**不是为了削环**（它的削环贡献是 0）。
   - ⚠️ **三个 owner 全部自用这些类型**（`buffered-merge-reducer.ts:73,110,118,127,193`、`assistant-block-layout.ts:116,180,181`、`decode-tool-input-core.ts:276`），而 **`export … from` 不绑定本地名**。在 `verbatimModuleSyntax` + `erasableSyntaxOnly` 下正确形态是**成对**的：
     ```ts
     import type { BufferedMergeDiag } from "<叶子>"        // 供本文件内部使用
     export type { BufferedMergeDiag } from "<叶子>"        // 供既有消费者保路径
     ```
3. **把 `src/lib/history/types.ts:14-21` 与 `src/lib/context/types.ts:1-6` 里对这四个类型的 import 改指叶子。** ← **环是被这一步削掉的。** 消费端**可以**零改动，但那样一个环都削不掉。

**验收判据**：

- ① **`history/types.ts` 与 `context/types.ts` 不再 import 那三个 owner 模块**（AST 断言，非 `rg`）——这是 A 类边被切断的直接判据，比环数更贴近目标。
- ② `computeCircularSnapshot()` 实测**落在 19 环 / 29 成员附近**——**这是观测值，不是 gate**。⚠️ **环数与 cycle 字符串集合都不能当正确性判据**（见 N0）：实测 B→C 两侧 count 都是 18，却是 **6 出 6 进**；而 N1 本身会让既有 ratchet 报出 **4 个「新环」**，那是 madge 删边后改选了此前未列出的既存环，**不是真新增**。对不上先看判据①，再按 §7 的前提谓词排查。
- ③ **叶子零出边**：`allModuleSpecifiers(parseSource(<叶子>))` 为空数组，且**没有任何 barrel re-export 这个叶子**。
- ④ 三个 owner 的原公共导出路径仍可用；无重复定义。
- ⑤ **重冻结基线**：跑 `bun run scripts/update-circular-deps-baseline.ts`，把 baseline 与代码改动**放进同一个提交**。⚠️ 两件事：**(a)** 不重冻结，后面所有 ratchet 判据都在跟一个仍含那 24 个环的陈旧集合比较，护栏对刚打下的战果完全无感；**(b)** **重冻结前必须先做 N0**——否则你是在一个「4 个新环」的红上重冻，等于把「删边导致的重新枚举」和「真新增环」一起接受了，而你无法区分它们。
- ⑥ 全后端绿。

**鉴别力正控**（每条判据都要有一个「什么变异让它红」）：

- 判据①：在 `history/types.ts` 里加回一条对 owner 的 `import type`，必须红。
- 判据③：给叶子加一条任意 import，必须红；再给某个 barrel 加一行 re-export 该叶子，也必须红。
- 判据④：在某个 owner 里**重新加一份独立的类型声明**（模拟「搬了但没删干净」），必须红。⚠️ **环数对「重复定义」完全不敏感**，这条只能靠 source guard。

**风险**：低（纯类型搬迁）。**零测试改动面**（`git grep` 覆盖 `tests/`，无测试文件消费这四个类型）。

### N2 —— barrel 穿透改直取 + 立机器守卫　【**Blocked on §5-2**：覆盖面与判据轴未裁决前不得开工】

**做什么**：

1. `context/types.ts` 的 `ApiError` 改从 **`~/lib/error/classify`** 直取（tsconfig `paths` 已把它直指 foundation 那个文件）。
   - ⚠️ **不要写裸包名 `@hsupu/ghc-proxy-foundation`**：foundation 根 barrel 全文 11 行、**没有任何 `./error/*` 的 re-export**，会 TS2305；全仓 `src/` 也**零处**裸包名 import。**更不要为此给 foundation 根 barrel 补 `export *`**——那恰恰是本步要禁的穿透，还会给它引入本仓只有 3 个 barrel 在用的 `export *` 形态。
2. `history/state.ts` 的 `ScopedPublisher` 改从 **`~/lib/observability/bus`** 直取（**写全路径**；在 `history/state.ts` 里写 `./bus` 会解析到不存在的 `src/lib/history/bus`）。
3. **立守卫**（判据形状见下）。

**⚠️ 守卫判据必须翻转成本地可判定的形态**：原稿写的「若某符号的 owner 不是该 barrel 本身则违规」**不可实现且形态错**——`tests/architecture/source-ast.ts` 没有跨文件 symbol→owner 解析，其头部还明写这条路已被三轮评审判定为死路；且 `error/index.ts` 全文 5 行全是 `export … from`、`observability/index.ts` 也无自有声明，**这两个 barrel 自己什么都不拥有**，按字面会判定 113 + 73 个导入方全部违规，原稿的「正样本②（合法用法不得咬）」在它们上**构造不出来**。

可实现的等价形状：

1. 对**名单内的 barrel**，用 `parseSource` 枚举它自身的 `export … from "X"` 子句 → 得到「名字 → 真正的 owner specifier」映射（**只需读 barrel 一个文件**；两个目标 barrel 都是 100% 显式具名 re-export，完全可枚举）。
2. 全仓扫具名 import 子句，凡从该 barrel 取到映射表里的名字即为穿透，报错直接给出「应改指 `X`」。
3. **⚠️ 「全仓无同型穿透」远不止计划列出的两行**：实测两个目标 barrel 当前已有 **43 条 type-only import 声明**。N2 不是「改两条 import 的低风险动作」——它的真实工作量由 §5-2 的两条轴决定，裁决前**不要估工**。
4. **`export *` 形态的 barrel（`system-prompt` / `ws` / `models/calibration`）先不列入名单**——它们需要多一跳 `publicExportNames(X)`，本轮不做。

**验收判据**：① 守卫测试自身即是「全仓无同型穿透」的可复算命令；② SCC 用 **ratchet 的集合差**（`newCycles` / `newMembers` 为空）——**相对 N1 重冻后的基线**，不是计数。

**鉴别力正控**：**两个正样本**——① 一条穿透 import（必须红）；② **一条合法的 barrel 用法（必须绿）**。⚠️ 由于两个目标 barrel 自身零拥有，正样本②只能取「从 barrel 取它转出的**实现**符号（如 `forwardError`）」——**这也正是 §5-2 要裁决的那条轴**：规则到底是「**类型**穿 barrel 违规」还是「任何符号穿 barrel 违规」。**裁决前无法确定正样本②的形态，所以本步真的被 §5-2 门控。**

### N3 —— 词汇归属的常驻约定　【依赖 §5-1 的裁决与 N1 的落地】

**做什么**：把「**产物/诊断类型不跟着产它的实现模块走，归零依赖词汇叶子**」写进 [docs/coding-conventions.md](../coding-conventions.md)，由该节权威维护约定；[docs/DESIGN.md](../DESIGN.md) 的「类型架构（single-source-of-truth）」节可按架构读者需要完整概述该约定并引用 coding-conventions。易变的具体落点／类型清单须引用权威节或带同一基线，不另维护一套独立状态。

**为什么必须做**：N1 只修了当前四个；**下一个写 reducer 的人还会把 diag 类型定义在 reducer 里**。不立约定，环会长回来。

**验收判据**：跨文档 grep 确认两处引用的路径与 N1 的**实际落点**一致（所以它必须排在 N1 之后、且 §5-1 已裁决）。

## 5. 需要你裁决的（**别自己拍；N1/N2 被它门控**）

1. **词汇叶子的粒度与落点**：
   - (a) 单个跨域词汇文件收全部诊断类型（**注意别落在 `src/lib/diagnostics/`**，那是日志子系统，见 N1）；
   - (b) 按域分：`codec/openai-responses/…-diag.ts`、`anthropic/…-diag.ts` 各一个零依赖叶子；
   - (c) 下沉 `packages/foundation/`。
   **我倾向 (b)**：保住域内聚（诊断类型仍归它描述的那个域），又满足零出边；(a) 造出跨域大杂烩，(c) 让 foundation 承载 core 的诊断形状、且这些类型没有跨包消费者。
2. **barrel 守卫的两条轴**（原稿只问了覆盖面，漏了更要紧的判据轴）：
   - **轴一·判据**：「**只有 `import type` 穿 barrel 算违规**」（type-only 边最容易长环，改指零成本）还是「任何符号穿 barrel 都算违规」（等于禁用 barrel 这个抽象）。**两者工作量差一个数量级。我倾向前者。**
   - **轴二·覆盖面**：只钉 `~/lib/error` 与 `~/lib/observability` 两个已知穿透点，还是全部 20 个 barrel。**量化影响**：全覆盖需处理 `~/lib/error` 的 113 个导入方 + `~/lib/observability` 的 73 个导入方（在轴一选「任何符号」时；选「type-only」则远小于此）。**我倾向全覆盖 + type-only 判据**。

## 6. 明确不在本计划内

- **`observability/bus ↔ events ↔ context/types`** 与 **history 内部环**（§3.3）：需要真设计（事件目录该不该反向依赖域类型）。**下一轮。**
- **vendor 纵切（anthropic/openai/gemini 提 core 层）**：backlog 的「第二步」。**当前图里不是承重点**，等 N1–N3 + §6 第一条做完再重新测量决定。
- **`error/index → error/forward`**（4 个环）：`forward.ts` 带 Hono `Context` + `RequestContext`，是 HTTP 边界胶水，spec §11「留 core」在这部分**仍然成立**（被推翻的只是「会把 state 拖进 foundation」那半）。
- **`observability/index.ts:12` 的契约注释与 `eslint.config.js:146` 的实际 glob 不一致**（注释说 history 不得 import observability，glob 里 history 不在内、注释后文自己也写了豁免）。**既有漂移、不是本计划引入**；顺手修可以，别被它带偏成一次 DI 重构。

## 7. 开工位置、时机与前提复算

**什么时候可以开始**（三选一，判据写死）：

- **(a) 推荐**：等 `feat/state-foundation` 合回 master 后，在主树基于 master 起**新** worktree 执行。此时须按下面的前提谓词重算。
- **(b) 若必须先行**：从 `feat/state-foundation` 的 tip **另起自己的分支 + 自己的 worktree**（`git worktree add --detach` 或新分支），接受合并后 rebase。**绝不进 `.worktrees/state-foundation`** —— 那是同伴的活跃工作区。
- **(c) 明确不可选**：在 master 上按本文的数字执行。`65c5654c` **不是** master 祖先，master committed 的 `circular-deps-baseline.json` 是 **70 环 / 63 成员**，§3 那条长环形状在 master 上找不到。

**合并后的前提复算**（一条命令验完，不必重跑四个 PoC）：

```bash
git log --oneline <合并点>..HEAD -- \
  src/lib/context/types.ts src/lib/history/types.ts \
  src/lib/codec/openai-responses/buffered-merge-reducer.ts \
  src/lib/anthropic/sanitize/assistant-block-layout.ts \
  src/lib/anthropic/decode-tool-input-core.ts
```

- **为空** → 前提未被合并触碰，§3 的结构结论直接可用。
- **非空** → 逐条核对：四个类型仍由那三个 owner 定义、两个类型模块仍从 owner 直接 import。
- 无论哪种，**跑一次 `computeCircularSnapshot()` 记为新基线**——**不必等于 43**，重要的是 N1 前后的差。

**只需重跑基线一次 + N1 落地后一次**；B/C 的边际值各只有 1 环，重跑它们对决策没有信息量。

## 8. 环境与禁区

- **测试命令用 `bun run test:backend`**（= `bun scripts/parallel-test.ts unit it http`，两者逐字等价）。**它不构建 native**——依赖 `native/history-search` 的测试走 `describe.skipIf(...)` 自动跳过，**不会红**；会构建 native 的只有 `test:ci`。
  > ⚠️ 本文第 1 版写着「`test:backend` 在本机因无 rustup toolchain 必挂」，**那是错的**，且危险：带着这个预期开工，会把 N1 引入的**真实**失败当成已知环境问题挥手放过——正是 CLAUDE.md 记下的 2026-07-28 那次事故的形状。
- **主树有 peer 的未提交改动**（十余个文件）。一律显式 pathspec 提交，`git add -A` 绝对禁止。
- **绝不碰用户跑在 4141 端口的主服务器**。
