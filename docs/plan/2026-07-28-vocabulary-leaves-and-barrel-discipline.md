# 计划：下一步解环 —— 词汇层剥离 + barrel 纪律（第四次剥离的前置）

> **状态**：草稿·未评审 —— 待 subagent 评审后定稿。
> **核验基线**：`65c5654c`（分支 `feat/state-foundation` 的 tip，2026-07-28）。**不是 master**——state→foundation 由同伴正在收尾、尚未合回主线。**本文所有数字都在那个分支上实测，合并后必须重跑。**
> **工作区**：本文档在主树写、即时提交；PoC 在 `/tmp/scc-poc`（detached，已还原并删除）。
> **已跑门禁**：`computeCircularSnapshot()` 四次实测（下表）。**typecheck / 测试未跑**——PoC 只改 import 指向来量环，不构成可交付实现。

## 1. 结论先行

**下一步最高价值的动作不是「再拆一个包」，而是把 core 里的词汇类型剥成叶子、并给 barrel 立规矩。** 实测它一步把环从 **43 削到 18**；而 backlog 里排在「state 第一」之后的 vendor 纵切（anthropic/openai/gemini），在当前图里**根本不是承重点**——那份排序写于 state 剥离之前，前提已经变了。

我知道这与「规划下一步拆包」的字面要求有出入，所以把话说清楚：**这一步做完，vendor 纵切才拆得动**；不做，它会像 state 当年一样「day-1 走不通」。

## 2. 实测（分支 tip `65c5654c`，post-state）

| PoC | 做了什么 | 环 / 成员 |
|---|---|---|
| 基线 | —— | **43 / 50** |
| **A** | 三个诊断类型（`BufferedMergeDiag` / `BlockLayoutRepairStats` / `SendMessageNormalizationDiag`）复制进零依赖叶子，`history/types.ts` 与 `context/types.ts` 的 5 条 import 改指叶子 | **19 / 29** |
| **B** | A + `context/types.ts` 的 `ApiError` 改从 `@hsupu/ghc-proxy-foundation` 直取（不再经 `~/lib/error` barrel） | **18 / 29** |
| **C** | B + `history/state.ts` 的 `ScopedPublisher` 改从 `./bus` 直取（不再经 `~/lib/observability` barrel） | **18 / 27** |

**削环量几乎全部来自 A。** B、C 各只削 1 环 / 2 成员——但它们暴露的是另一类结构问题（见 §3.2），价值不在环数。

**这些 PoC 没有证明什么**：只改了 import 指向与类型副本，**没有** typecheck 绿、**没有** 测试绿、**没有**处理 owner 侧的 re-export 与重复定义。A 用的是**复制**类型定义（真实现必须是搬迁 + owner re-export，否则双份维护）。环数是唯一被证明的东西。

## 3. 承重结构：post-state 的环几乎全由 **type-only 边** 撑着

43 个环里有 26 个穿过同一条长环：

```
context/types → error/index → error/forward → context/request
  → context/activity-summary → history/store → history/entries → …
  → history/types → codec/openai-responses/buffered-merge-reducer
  → pipeline/frame-origin → pipeline/types → context/types
```

逐条看那些边引用的是什么，全是 `import type`。它们分成两类，**修法完全不同**：

### 3.1 【A 类】诊断/词汇类型被**实现模块**拥有

`BufferedMergeDiag` 定义在 `codec/openai-responses/buffered-merge-reducer.ts`（一个 reducer 实现），却被 `history/types.ts` 与 `context/types.ts` 两个**类型模块**消费。于是「类型模块 → 实现模块」的边把 codec 拽进了 history/context 的环里。

同型的还有 `BlockLayoutRepairStats`（住在 `sanitize/assistant-block-layout.ts`）、`SendMessageNormalizationDiag`（住在 `anthropic/decode-tool-input-core.ts`）。

**这与上一轮 state 的承重边是同一个形状**：`state-defaults.ts` 为了三个字符串常量 import `recover-refusal.ts`。**产物类型跟着产它的代码走，是自然而然写出来的，也正是环的来源。**

实测这三个类型各自只有 **3–5 个消费文件**——爆炸半径极小，与它们撑起的 24 个环完全不成比例。

### 3.2 【B 类】类型经 **barrel** 取，而 barrel 同时导出实现

两个实例，都不是真依赖：

- `context/types.ts` 取 `ApiError`，走 `~/lib/error` —— 而 **`ApiError` 早就住在 `packages/foundation/src/error/classify.ts`**。core 的 `error/index.ts` 只是 re-export 它，同时还导出 `forwardError`（`forward.ts`，带 Hono `Context` + `RequestContext`）。于是一个「取 foundation 里的类型」的动作，把整个 core error 模块拉进了环。
- `history/state.ts` 取 `ScopedPublisher`，走 `~/lib/observability` barrel —— 而它就在 `./bus`。barrel 同时导出 `createBus` / `getBus` 等实现。

**这类边的修法是零成本的**（改 import 指向），但**靠人自觉不可持续**——需要机器守卫，否则下次有人写 `from "~/lib/error"` 拿类型又会长回来。

### 3.3 剩余的环（A+B+C 之后的 18 个）

集中在两处，**都不是 type-only，需要真设计**：

- `observability/bus ↔ events ↔ context/types`：`events.ts` 是事件目录，天然要引用各域的形状（`context/types`、`history/store`、`history/types`、`models/client`）。
- `history/store → entries → state → observability/bus`：history 内部环 + history 对 observability 的发布依赖。

**本计划不处理这两处**，把它们留给下一轮（见 §6）。

## 4. 提议的执行顺序

> 每步一个提交、终态绿；SCC 只减不增（`circular-deps-ratchet` 守卫）。

### N1 —— 建词汇叶子，搬三个诊断类型

- **做什么**：新建零依赖叶子（建议 `src/lib/diagnostics/vocabulary.ts`，命名待评审），把 `BufferedMergeDiag`（含它引用的 `TerminalRepairReason`）、`BlockLayoutRepairStats`、`SendMessageNormalizationDiag` **搬**过去；三个 owner 模块改为 `export type { … } from` **re-export**（消费端零改动、单一 owner、无重复定义）。
- **验收判据**：① `computeCircularSnapshot()` 实测应落在 **19 环 / 29 成员**附近（PoC 值；**别把它当保证，实测为准**）；② owner 模块的原公共导出路径仍可用；③ 全后端绿。
- **鉴别力正控**：在 owner 模块里**重新加一份独立的类型声明**（模拟「搬了但没删干净」），source guard 必须变红。**只跑环数不算**——环数对「重复定义」完全不敏感。
- **证伪方式**：若实测环数明显偏离 19，说明合并后的图变了——**别调期望值去迁就**，先重跑 §2 的基线。
- **风险**：低（纯类型搬迁 + re-export）。⚠️ **`export … from` 不绑定本地名**——owner 模块内部若自用该类型，需另行 import（上一轮踩过）。

### N2 —— barrel 穿透改直取 + 立机器守卫

- **做什么**：把 `context/types.ts` 的 `ApiError` 改从 `@hsupu/ghc-proxy-foundation` 直取、`history/state.ts` 的 `ScopedPublisher` 改从 `./bus` 直取；**并全仓扫一遍同型穿透**（经 barrel 取一个 barrel 自己不拥有的类型）。
- **守卫**：新增架构测试——**「若某符号的 owner 不是该 barrel 本身，则不得经该 barrel import 它」**。形态参考 `tests/architecture/package-boundaries.unit.test.ts` 的 **telemetry allowlist 检测器**（不是 foundation 那个 denylist）。
- **验收判据**：① 全仓无同型穿透；② 环数不回升（用 ratchet 的**集合差**，不是计数）。
- **鉴别力正控**：**两个正样本**——① 一条「经 barrel 取 foundation 类型」的新 import（新旧判据都该咬）；② 一条「经 barrel 取本 barrel 拥有的类型」（**合法，新判据不得咬**）。只有 ② 保持绿，才证明守卫没有一刀切。
- **风险**：低，但守卫的判据形状要小心——「owner 是不是 barrel 自己」需要 AST 判定，别用正则。

### N3 —— 词汇归属的常驻约定

- **做什么**：把「**产物/诊断类型不跟着产它的实现模块走，归零依赖词汇叶子**」写进 [docs/coding-conventions.md](../coding-conventions.md)，并在 DESIGN 的类型架构节留指针。
- **为什么必须做**：N1 只修了当前三个；**下一个写 reducer 的人还会把 diag 类型定义在 reducer 里**。不立约定，环会长回来。

## 5. 需要你裁决的（**别自己拍**）

1. **词汇叶子的粒度与落点**：
   - (a) 单个 `src/lib/diagnostics/vocabulary.ts` 收全部诊断类型；
   - (b) 按域分：`codec/…/diag-types.ts`、`anthropic/diag-types.ts` 各自一个零依赖叶子；
   - (c) 直接下沉 `packages/foundation/`。
   **我倾向 (b)**：保住域内聚（诊断类型仍归它描述的那个域），又满足零出边；(a) 会造出一个跨域大杂烩，(c) 让 foundation 承载 core 的诊断形状、且这些类型没有跨包消费者。
2. **N2 的守卫要不要覆盖全部 barrel**，还是只钉 `~/lib/error` 与 `~/lib/observability` 两个已知穿透点。**我倾向全覆盖**（判据一致、不留「下次换个 barrel 又长回来」的口子），但会打出更多既有违规、增加本轮工作量。

## 6. 明确不在本计划内

- **`observability/bus ↔ events ↔ context/types`** 与 **history 内部环**（§3.3）：需要真设计（事件目录该不该反向依赖域类型），不是搬类型能解决的。**下一轮**。
- **vendor 纵切（anthropic/openai/gemini 提 core 层）**：backlog 的「第二步」。**当前图里它不是承重点**，且被上面这些环缠着；等 N1–N3 + §6 第一条做完再重新测量决定。
- **`error/index → error/forward`**（4 个环）：`forward.ts` 带 Hono `Context` + `RequestContext`，是 HTTP 边界胶水，spec §11「留 core」的判断在这部分**仍然成立**（那条被推翻的只是「会把 state 拖进 foundation」那半）。

## 7. 接手须知

- **基线是分支不是 master**：state→foundation 由同伴在 `feat/state-foundation` 收尾。**合并落地后第一件事是重跑 §2 的四次测量**——数字会变，结构性结论（两类 type-only 边）大概率不变，但**这句话本身是推断、不是实测**。
- **别在 `.worktrees/state-foundation` 里做任何写操作**——那是同伴的活跃工作区。要 PoC 就像本轮一样另建 detached worktree。
- **主树有 peer 的未提交改动**（十余个文件）。一律显式 pathspec 提交，`git add -A` 绝对禁止。
- **测试命令**：`bun scripts/parallel-test.ts unit it http`（`bun run test:backend` 在本机因无 rustup toolchain 必挂）。
