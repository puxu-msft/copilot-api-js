# HANDOVER：把 `state` + `state-defaults` 降为 foundation 叶子

> **状态**：**执行中**——范围已由用户拍板（§2）、四条分叉已裁决（§5）、**S1 起代码开工**。本文件是**唯一入口**，接手请先读完再看别的。
> **核验基线**：`23e85aba`（2026-07-28）。**2026-07-28 已在 `a675064e` 重跑全部三项复验，差集为空**——详见 §3.0。**再往后接手请再重跑一次**——数字有时效（见 §6 第 1 条）。
> **工作区**：文档在主树 `master` 直接改并提交；**代码走隔离 worktree `.worktrees/state-foundation` @ 分支 `feat/state-foundation`**。主树有并发 peer 的未提交改动十余个文件 + 若干未追踪文件，**全部与本任务无关**，一律显式 pathspec 提交。
> **已跑门禁**：`computeCircularSnapshot()` 实测 + `allModuleSpecifiers()` 出边枚举 + 消费者 AST 计数（均 2026-07-28 @ `a675064e`，见 §3.0）。`bun run test:backend` 在本机**跑不起来**（§8），用 `bun scripts/parallel-test.ts unit it http`。
> **前身**：monorepo 拆分 Phase 4 的第三次剥离（前两次 = `@hsupu/ghc-proxy-token` 2026-07-23、`@hsupu/ghc-proxy-telemetry` 2026-07-27，均已 landed）。

## 3.0 复验记录 @ `a675064e`（2026-07-28）—— 【实测】

按 §6 第 4 条的三步顺序重跑，**§3.1 与 §3.7 完全对上、差集为空**，§3.5 有两处 +1 漂移。

| 项 | 原记录 @ `23e85aba` | 复测 @ `a675064e` | 判定 |
|---|---|---|---|
| §3.1 环数 / 成员 / top-6 | 70 / 63，52·50·49·48·35·32 | **完全一致** | ✅ |
| §3.7 `state.ts` 出边 | 10 条（#1–#10） | 10 条，集合相同 | ✅ 差集空 |
| §3.7 `state-defaults.ts` 出边 | 6 条（#11–#16） | 6 条，集合相同 | ✅ 差集空 |
| `state-defaults > state` 两节点环 | 在快照里 | 仍在 | ✅ |
| §3.5 ③-b `resolve*` 消费者 | prod 7 / tests 3 | prod 7 / tests 3 | ✅ |
| §3.5 ③-a models 消费者 | prod 4 / tests 101（共 105） | prod 4 / **tests 102（共 106）** | 漂移 +1 |
| `setStateForTests` 文件数 | 164 / 167 | **165 / 168** | 漂移 +1 |

**三条原表没写全的形态**（不是新的出边，是同一条边的形态遗漏——但每条都会在执行期咬人）：

1. **#10 除 import 外还有一条值 re-export**：`state.ts:2035` `export { CONFIG_MANAGED_DEFAULTS, DEFAULT_MODEL_MAPPINGS, DEFAULT_MODEL_TRANSLATION } from "./state-defaults"`。这是**对外公共表面**，S6 搬迁时要跟着走，S5 拆环时别把它当成普通内部 import 处理掉。
2. **#16 是 12 个类型不是 11 个**：除 11 个具名 `import type` 外，`state-defaults.ts:97` 还有一个**内联** `import("./state").MaxTokensContinuationOverride`。**S5 建 `state-vocabulary.ts` 时这个内联点必须一起改**——按 named-import 列表数会漏掉它，`allModuleSpecifiers()` 才抓得到（这正是 §6 第 7 条「换成目标一定会出现的锚点」的又一次兑现）。
3. **`applyDisabledFilter` 是模块私有**（`state.ts:1424`，无 `export`）。§3.5 ③-a 表里的 8 个符号中，只有 **6 个是导出符号**（`setModels` / `getRawModels` / `getConfigDisabledIds` / `resetRawModelsForTests` / `setDisabledModels` / `rebuildModelIndex`），另两个（`applyDisabledFilter` + `rawModels` 模块变量）零外部消费者、随逻辑一起走即可。

**S1 的两个前提复验通过**：`refusal-policy.ts` 仍是 41 行、**零 import** 叶子；`block-layout-contract.ts:1` 仍 `import type { ContentBlockParam } from "~/types/api/anthropic"`（**不可整搬**）。

**复验用的脚本没有留存**（一次性 scratch，跑完即删）。**重跑配方**：写一个脚本调 `tests/architecture/source-ast.ts` 的 `allModuleSpecifiers()` 枚举两个文件的出边、调 `tests/architecture/circular-deps-snapshot.ts` 的 `computeCircularSnapshot()` 量环、再用同一个 AST 走查扫 `src/**` `packages/*/src/**` `tests/**` 统计从 `~/lib/state` import 目标符号的文件数。

## 1. 入口指引：什么时候读什么

| 材料 | 何时读 |
|---|---|
| 本文件 §1.5–**§5** | 动工前必读全部。**§3.0 是复验记录**（数字以它为准，§3.1/§3.5 的原始数字标的是更早的 revision）；**§5 的 4 条分叉已由用户裁决完毕**，其中第 1 条决定 S5/S6、第 3 条决定 S4 的注册表形状、第 4 条决定 spec 0d 作废——**照办即可，别再重开**。**§2.5 与 §3.7 是评审后新加的，第一版没有，缺了它们 S6 必红** |
| [KICKOFF.md](KICKOFF.md) | 起新会话时贴给自己/agent |
| 同目录 `HANDOVER-review-{gpt,claude}.md` | 想知道某条 oracle「为什么写成这样」时——它们记着被证伪的原始版本 |
| [plan-token-package.md](../monorepo-split/plan-token-package.md)「通用 DomainPeel Contract」 | 写具体 plan 时（本次不是抽包，但边界守卫/过渡纪律可复用） |
| [plan-telemetry-package.md](../monorepo-split/plan-telemetry-package.md) 头部「执行期偏差」 | 想知道"上一轮为什么这么做"时 |
| 记忆 `methodology-domain-peel-execution-techniques` | 真正开始搬代码时 |
| [spec/2026-07-22-monorepo-workspace-split.md](../../spec/2026-07-22-monorepo-workspace-split.md) §7.2 | 需要理解本步在总路线中的位置时。**⚠️ 先读本文 §2.5**——spec §2.1 白纸黑字写着本任务「走不通」，那是 **2026-07-22 的前提**，S1–S5 拆的正是那个前提。不先读 §2.5 就去读 spec，你会以为本任务被否决了 |

**不需要读**：telemetry peel 的 T1–T5 提交本身（那是抽包，本次不抽包）。

## 1.5 本轮做了什么（**代码零改动**）

1. **实测定位承重边**：跑 `computeCircularSnapshot()` 摸清 SCC 现状，发现 `state` / `state-defaults` 参与了 70 个环里的 52 / 50 个，而把它们拴住的是几个纯字符串常量。
2. **PoC 并还原**：临时把两个 refusal 常量挪进零依赖叶子，实测 70/63 → 30/43，然后 `git checkout --` 还原（§7 有它「没有证明什么」）。
3. **与用户逐步收窄范围**：从「state 能不能进 foundation」一路收到 §2 那 6 条。中途我提过一个多余的 `config-vocabulary` 模块，被用户点破（§6 第 2 条）。
4. **因 peer 改动重测**：成稿前 HEAD 已前进 20 个提交，peer 顺手建好了 `refusal-policy.ts`，S1 的工作量被砍掉三分之一（§6 第 4 条）。
5. **两轮异模型 subagent 评审并整改**：第一轮独立复现了 PoC 数字、证伪了 4 个 oracle；第二轮以接手方第一人称走查，找出 2 个 BLOCKER。**§2.5、§3.7、S3 的选址硬约束、S6 的两层守卫、S7 都是评审后补的**——第一版没有它们，S6 会在投入 5 个提交后必红。评审报告留在同目录（`HANDOVER-review-{gpt,claude}.md`）。

**代码一行没动。** 相关提交只有文档：`cc2fb141`（初稿）、`773773b2`（补模板槽位）、`31e39d6f`（peer 订正 worktree/eslint 一句）+ 本次整改。

## 2. 用户已裁定的范围（**别再重开这个议题**）



用户在 2026-07-27 的讨论中逐条收窄，最终范围是：

- ✅ **`state.ts` + `state-defaults.ts` 可以成为 foundation 的一部分**，前提是**只依赖语言/系统内置**。
- ✅ **简单 setter 留在 state**（约 30 个 `setXConfig`）——用户原话「简单的 setters 留在 state 上没问题」。**不要**把它们迁往各域，那是范围扩大。
- ✅ **state 本身不需要测试**——用户原话。所以测试专用函数不构成"必须留在 core"的理由。
- ✅ **对 state 的读写与辅助函数，可能属于子模块**——用户提出，实测证实（见 §3）。这些回各自的域。
- ❌ **不做**：单独建 `config-vocabulary` 模块（我提过，被判定多余——见 §6 第 2 条）。
- ❌ **不做**：把 30 个 config setter 拆到各域。

## 2.5 与 spec `2026-07-22-monorepo-workspace-split` 的关系（**动工前必读，否则你会以为本任务被 spec 否决了**）

spec 里有三处直接谈 state，读起来像是在否决本任务：

- **§2.1**（`:44`）：「state 是 SCC 的核心节点、被 ~83 个 src 文件 `import { state }` 依赖——**「把 state 沉到 foundation」day-1 走不通**（会拽下半个 SCC），强化「state 实现整个留 core」的正确性。」
- **§5**：给 state 定的方案是**窄读接口 seam**（`core/state/reader-*.ts`）+ day-1 强迁 ~83 个消费端。
- **§7.2 阶段 0d**：「剩余 0d 范围 = **models 域**」——与本交接 S2 的对象是同一个域。
- 另有 `docs/todo/deferred-backlog.md` 的解环排序清单仍写「**state 第一**」。

**这不是矛盾，但你必须理解为什么不是**：spec 判「走不通」的**依据**是当时 state 身上那几条实边（value import `models/model-name` + `recover-refusal`，以及一串 type 依赖）。**S1–S5 逐条拆的正是那几条依据**——前提没了，结论随之改变。spec 说的是 **day-1 走不通**，不是「永远不该做」；spec §11「error 整体上提 foundation：否决」那条的理由（「会把 state 拖进 foundation → foundation 不再是叶子」）同样只在 state 还不是叶子时成立。

**所以**：spec §2.1 / §5 / §7.2-0d 记录的是 **2026-07-22 的前提**。用户 2026-07-27 的裁定（§2）是在新前提下做的，**优先级高于 spec 的旧结论**（user-rule `user-prompt-first`）。

⚠️ **两件必须做的事**：

1. **0d 的「剩余范围 = models 域」与 S2 是什么关系，必须先答**。两者对象相同、机制不同（0d 迁的是 `import { state }` 的**消费端**到 reader seam；S2 搬的是 state 里的**逻辑**出去）。**不说清楚就会有人把两套都做一遍**，或者做完 S2 才发现 reader seam 白建。→ 已列入 §5 待裁决第 4 条。
2. **本任务落地后必须 doc-sync**：spec §2.1 / §3.1 / §5 / §7.2-0d + `deferred-backlog.md` 的「state 第一」条 + `DESIGN.md`「活的架构现状」表，全部要改到与新事实一致。**这是交付的一部分不是可选项**（→ S7）。否则 `docs/` 里会同时存在「state 留 core、走 reader seam」与「state 在 foundation」两套说法，下一个接手方必然重蹈覆辙。



## 3. 已确证的硬事实（逐条标证据等级）

### 3.1 当前 SCC 现状 —— 【实测】

`bun` 跑 `computeCircularSnapshot()`，HEAD `23e85aba`：**70 环 / 63 成员**，与 `tests/architecture/circular-deps-baseline.json` 一致。参与环最多的文件：

```
 52/70  lib/state.ts
 50/70  lib/state-defaults.ts
 49/70  lib/anthropic/recover-refusal.ts
 48/70  lib/anthropic/client.ts
 35/70  lib/copilot-api.ts
 32/70  lib/models/client.ts
```

### 3.2 承重边是「三个字符串常量」 —— 【实测 PoC，已还原】

`state-defaults.ts:25` 从 `~/lib/anthropic/recover-refusal` import 三个 `DEFAULT_REFUSAL_*`（纯字符串字面量）。把它们挪进已有的零依赖叶子 `src/lib/anthropic/refusal-policy.ts` 后实测：

> **70 环 / 63 成员 → 30 环 / 43 成员**

**注意 peer 已经走了一半**：`refusal-policy.ts`（41 行、**零 import**）是 peer 在 contentless-refusal 工作中新建的，已经拥有 `DEFAULT_REFUSAL_ERROR_TYPE`，`recover-refusal.ts:114` 再 re-export 出去。**剩下要挪的只有 `DEFAULT_REFUSAL_END_TURN_TEXT` 与 `DEFAULT_REFUSAL_ERROR_MESSAGE` 两个**，目标模块现成。

### 3.3 `state.ts` 的值依赖只有 3 个，全部可解 —— 【源码读证 + 实测】

> ⚠️ **这一节是【削环视角】的结论，不是 S6 的入口判据。** 它只回答「哪些边让 state 成环」；「state 还剩哪些跨界出边」是另一个问题，答案在 **§3.7**，两者差 5 条。**行号会漂移，一律以符号名为准**（下表 `state-defaults` 那行的 `:2025` 在成稿当天就已漂到 `:2035`）。

| 值依赖 | 位置 | 结论 |
|---|---|---|
| `normalizeForMatching` | ← `~/lib/models/model-name` | 该模块**零 import**；且此函数在 state 内**只被 models 逻辑用**（4 处，全在 `applyDisabledFilter` 与 `getConfigDisabledIds` 内）→ **随 models 逻辑一起走，边自然消失** |
| `~/lib/token/store` 6 个符号 | | **只出现在 3 个 test-only 函数里**（`snapshotStateForTests` / `setStateForTests` / `restoreStateForTests`），生产路径零使用 → S4 的反转方案。**已用正样本对照验证过这个否定性断言** |
| `./state-defaults` | | 同一单元，一起走 |

**`state-defaults.ts` 另有一个值依赖**（`DEFAULT_SEPARATOR_CARRIER`），我第一版从没审计过这个文件 → 见 §3.7 #11。

### 3.4 `state.ts` 无 I/O、无类实例、字段里无函数 —— 【实测 grep】

`rg 'node:|require\(|process\.|Bun\.'` 在 `state.ts` 只命中**文档注释**（提到 `node:tls`/`node:http2` 是在解释配置语义），无实际调用。

### 3.5 寄居在 `state.ts` 里的领域逻辑清单 —— 【源码读证，行号 @HEAD `23e85aba`】

**③-a models 域**（`ModelsResponse`/`Model` 的缓存、禁用过滤、索引重建）：

| 符号 | 行 | 为什么属于 models |
|---|---|---|
| `rawModels`（模块变量） | `:1422` | 上游 `/models` 原始响应的缓存 |
| `applyDisabledFilter` | `:1424` | 按 `disabledModels` 过滤，用 `normalizeForMatching` 归一 |
| `setModels` | `:1434` | 写缓存 + 过滤 + 重建索引 |
| `getRawModels` | `:1441` | 读未过滤缓存 |
| `getConfigDisabledIds` | `:1452` | 归一化比对求被禁 id |
| `resetRawModelsForTests` | `:1468` | 上面那个模块变量的复位 |
| `setDisabledModels` | `:1476` | 写 + 重新过滤 |
| `rebuildModelIndex` | `:2018` | 建 `modelIndex: Map<string, Model>` |

**消费者 —— 【实测，口径写死】**：从 `~/lib/state` **直接 import** 上述符号的文件，AST 扫描 @`23e85aba`：

| 口径 | 数量 |
|---|---|
| production（`src/` + `packages/`，不含 owner 自身） | **4**：`packages/cli/src/start.ts`、`src/lib/config/config.ts`、`src/lib/models/client.ts`、`src/routes/models/internal.ts` |
| tests | **102**（@ `a675064e` 复测；`23e85aba` 时是 101） |

⚠️ **这两个数不能只看第一行**。S2 要改的 import 面是 **106 个文件**，不是 4 个。「测试零改动」这条红线**只覆盖 `setStateForTests` 调用点**（见 ③-c），**不覆盖**测试里对 `setModels` / `setDisabledModels` 的 import——那些必须跟着迁走，否则只能靠在 state 留 re-export 双轨来糊住，S2 的边界收敛就成了假完成。

**③-b 每模型 override 解析**（纯函数，合并 shared + per-model override）：

| 符号 | 行 |
|---|---|
| `resolveBufferedCaps` | `:1874` |
| `resolveContinuation` | `:1888` |
| `resolveMaxTokensContinuation` | `:1938` |
| `resolveEffectiveMaxTokensContinuation` | `:1959` |

四个共约 45 行。它们是"解析"不是"存储"——读 state 的两个字段算出结果，不改 state。

**消费者 —— 【实测，口径同上】**：production **7** 个（`src/lib/config/config.ts`、`src/routes/chat-completions/{buffered-config,handler-v4}.ts`、`src/routes/messages/handler-v4.ts`、`src/routes/responses/{buffered-config,handler-v4,ws}.ts`）+ tests **3** 个。

> 我最初写的是「8 个文件」，未标口径也未复核——**实测 production 直接 import 是 7**。别沿用这个数，按下面的命令自己重数。

**③-c 测试专用**：`snapshotStateForTests:1976` / `setStateForTests:1989` / `restoreStateForTests:2009`。

`setStateForTests` 的使用量 —— **【实测，三个 revision 一致】**：

```bash
git grep -l -w setStateForTests <rev> -- 'tests/*.ts' | wc -l   # → 165 @ a675064e（164 @ 23e85aba），其中 3 个在 tests/helpers/
git grep -l -w setStateForTests <rev> -- '*.ts'      | wc -l   # → 168 @ a675064e（167 @ 23e85aba），多出 state.ts owner + 2 个 exp/ 探针
```

> 我先前写的「165 个文件」在 `23e85aba` 口径下复现不出来，是我没记命令就报数字（**巧合的是 peer 后来加了一个文件，@ `a675064e` 恰好就是 165**——这更说明数字必须现场重数，别抄）。**执行期按上面的命令现场重数。**

### 3.6 类型依赖清单 —— 【实测，但**已被 §3.7 取代**】

> ⚠️ **别用这一节做 S5 的驱动清单，用 §3.7。** 这一节我改过两版都还是漏的（第一版漏 4 个符号，第二版漏了 `state-defaults.ts` 整个文件），原因是它是**人工枚举**。保留它只为解释「为什么这些类型可以反转」这个机制；**清单以机器枚举的 §3.7 为准**。
>
> **「推断」升「实测」还差什么**（模板要求写明，而这个空槽位正是上面那个 BLOCKER 的藏身处）：差的就是**跑一遍完整出边枚举**——现在跑过了，结果在 §3.7。

机制：**叶子没有出边，所以谁依赖它都不可能成环**。把词汇的归属反转（实现模块从 state import 类型，而不是 state 从实现模块 import）即可。madge 计 type 边，所以这一步是**必须的**，不能只靠"反正 type 会被擦除"。

三点后果：① `Model`/`ModelsResponse` 需要单独决定（§5 待裁决 1）；② token 类型（`CopilotTokenInfo`/`TokenInfo`/`TokenStoreSnapshot`）**不是 S5 的事而是 S4 的事**，且牵动包分层（§5 待裁决 3）——参与者注册表若签名里还写着 token 类型名，边根本没断；③ 验收**不要数 import 行**，用 §3.7 的 `from "` 枚举或 AST 的 `allModuleSpecifiers()`（`tests/architecture/source-ast.ts` 已有此工具）。

### 3.7 **foundation 准入清单：两个文件的完整出边逐条对账** —— 【实测，机器枚举】

> **这一节是 S6 的入口判据，也是本交接最重要的一节。** §3.3 与 §3.6 回答的是「state **为什么在 SCC 里**」（削环视角，只关心成环的边）；S6 需要的是「state **还剩哪些跨界出边**」（叶子化视角，关心**所有**出边）。**两者的答案不同**——我第一版把前者的结论直接当成了后者的前提，于是漏掉了 5 条边，其中一条会让 S6 在做完前五步之后必红。

**权威枚举方式 = AST，不是 grep**：写个小脚本调 `tests/architecture/source-ast.ts` 的 **`allModuleSpecifiers()`**，输出每个 specifier 及其 type/value 形态与具名符号。**本表就是这么核出来的**（两位 reviewer 各自独立 AST 复核过，差集为空）。

快速人工浏览可以用：

```bash
rg -n 'from "' src/lib/state.ts src/lib/state-defaults.ts
```

⚠️ **但这只是浏览，不是完整枚举**：它漏 side-effect import（`import "x"`）、`import = require`、dynamic `import("x")`、`import("x").T`，还会被字符串/注释里的 `from "` 干扰。**而且千万别退回 `rg '^\s*import'`**——本仓库的排版把 `from` 放到多行 import 的**收尾行**，那个形态会**静默漏掉全部多行 import**。我第一次枚举就是这样漏的，两位 reviewer 里也有一位在 `state-defaults.ts` 上漏了一条。（这本身就是 §6 第 3 条「判据形状」教训的一个现成实例。）

**`state.ts` 的出边**：

| # | 目标 | 形态 | 符号 | 由哪一步消除 |
|---|---|---|---|---|
| 1 | `~/lib/anthropic/sanitize/assistant-block-layout` | type | `AssistantBlockLayoutStrategy`, `SeparatorCarrier` | **S5** |
| 2 | `~/lib/anthropic/sanitize/content-blocks` | type | `ThinkingBlockSanitizeMode` | **S5** |
| 3 | `~/lib/anthropic/tool-input-repair` | type | `RepairItem` | **S5** |
| 4 | `~/lib/config/schema` | type | `ModelTranslation` | **S5** |
| 5 | `~/lib/models/client` | type | `Model`, `ModelsResponse` | **S5**（已裁决：两类型下沉 foundation，`models/client.ts` 改 re-export——§5 第 1 条） |
| 6 | `~/lib/token/types` | type | `CopilotTokenInfo`, `TokenInfo` | **S4**（已裁决：注册表做成领域无关，state 侧零 token 类型名——§5 第 3 条） |
| 7 | `~/lib/models/model-name` | **value** | `normalizeForMatching` | **S2**（随 models 逻辑走） |
| 8 | `~/lib/token/store` | **value** + type | 6 个符号 + `TokenStoreSnapshot` | **S4** |
| 9 | `./adaptive-rate-limiter` | type | `AdaptiveRateLimiterConfig` | **S5** ⚠️ 见下方注 |
| 10 | `./state-defaults` | value **+ 值 re-export** | 3 个（`state.ts:2035` 另有一条 `export … from` 把它们转出为公共表面，见 §3.0） | 同一单元，一起走 —— **但 S6 之后仍然存在，见下方 ⚠️** |

**`state-defaults.ts` 的出边**：

| # | 目标 | 形态 | 符号 | 由哪一步消除 |
|---|---|---|---|---|
| 11 | `~/lib/anthropic/sanitize/block-layout-contract` | type **+ value** | `AssistantBlockLayoutStrategy`, `SeparatorCarrier`（type）/ **`DEFAULT_SEPARATOR_CARRIER`（value）** | **S1**（值）+ **S5**（类型） |
| 12 | `~/lib/anthropic/sanitize/content-blocks` | type | `ThinkingBlockSanitizeMode` | **S5** |
| 13 | `~/lib/anthropic/tool-input-repair` | type | `RepairItem` | **S5** |
| 14 | `~/lib/config/schema` | type | `ModelTranslation` | **S5** |
| 15 | `~/lib/anthropic/recover-refusal` | **value** | 3 个 `DEFAULT_REFUSAL_*` | **S1** |
| 16 | `./state` | type（11 个具名 + **1 个内联 `import("./state").T`**） | `BufferedRetryCaps` 等 11 个 + `state-defaults.ts:97` 的 `MaxTokensContinuationOverride`，共 **12** 个（见 §3.0） | 同一单元 —— **但 S6 之后仍然存在，见下方 ⚠️** |

⚠️ **#10 与 #16 互指，是一条 S1–S5 消不掉、会原样跟进 foundation 的两节点环**：`state.ts` 从 `state-defaults` 取 3 个值，`state-defaults` 从 `state` 取 **11 个类型**。它**已经在环快照里**（`tests/architecture/circular-deps-baseline.json:71` 的 `"lib/state-defaults.ts > lib/state.ts"`，madge 计 type 边所以它算数）。**S6 新加的 package-wide madge oracle 会立刻咬到它**——见 S5 的「顺手拆掉」方案与 S6 的预案，**别把这条红当成"S1–S5 没做完"去回头找不存在的漏网边**。

> 这是 §6 第 6 条那个教训的**第三个实例**：本表回答的是「还剩哪些出边」，而 S6 的 package-wide oracle 问的是「foundation 内部还有没有环」——**又是一个换了的问题**，而「同一单元，一起走」这个针对前一个问题的答案被我原样复用了。「S6 之后是否仍然存在」这一列就是为了让下次在写表时自己暴露。
> **这一列的形态仍不够泛化**（reviewer 指出）：列名绑死了「S6」这个具体问题，下次换成第四个问题时它照样答不上来。真正泛化的形态是「**本行结论只对哪个问题成立**」。当前形态够拦住第三次同型复发，但别指望它自动拦住第四次。

**三条我第一版完全没登记的边，逐条说明为什么它们比看上去难**：

- **#11 的 `DEFAULT_SEPARATOR_CARRIER` 是个【值】依赖，而我全文只审计过 `state.ts`、从没审计过 `state-defaults.ts` 的出边。** 它性质和三个 refusal 常量完全相同 → **并入 S1 一起做**。但它的目标模块 `block-layout-contract.ts` **不是零依赖叶子**（`:1 import type { ContentBlockParam } from "~/types/api/anthropic"`），所以**不能整个搬**——正解是把 `SeparatorCarrier`（类型）与 `DEFAULT_SEPARATOR_CARRIER`（值）**这一对**（同一词汇的值与类型）单独放进一个新的零依赖叶子。
- **#6 `~/lib/token/types` 是包分层反转，不是品味问题。** `packages/token/package.json` 已声明 `"@hsupu/ghc-proxy-foundation": "workspace:*"`——**token 依赖 foundation**。若 state 进 foundation 后仍 import token 类型，就是 `foundation → token → foundation` 的**包级环**。而 `package-boundaries.unit.test.ts` 的 `foundationHasForbiddenImport` 对 foundation 内**任何** `~/` 一律判违规，`import type` **不豁免**。→ 升级为 §5 待裁决第 3 条。
- **#9 `./adaptive-rate-limiter` 的相对路径形态掩盖了它是跨界边。** 它现在和 state 同在 `src/lib/`，看起来「同目录、无害」；但 S6 把 state 搬进 `packages/foundation/src/` 之后，这个相对路径就**不再指向同一个包**了。而 `adaptive-rate-limiter.ts` 本身**远不是叶子**（实测出边：`consola`、`~/lib/error` 的 `HTTPError`、`./observability`）。S5 的反转（让它从 state import 类型）能解决，**但前提是你知道要把它算进 S5**——按相对路径的外观很容易把它归成「自己人」跳过。

**这张表的用法**：动工前**用上面那个 AST 脚本**（不是 `rg`）重跑一次，与本表做差集。**差集非空 = 交接已陈旧，先补表再动手**。表里任何一条对不上步骤的，就是一个会在 S6 爆出来的缺口。

## 4. 执行步骤（每步带验收 oracle 与证伪方式）

> 通用不变量（每 commit）：typecheck 绿 + `bun scripts/parallel-test.ts unit it http` 绿 + 精确 pathspec lint 绿 + SCC ratchet 只减不增。
> **SCC 数字一律 `computeCircularSnapshot()` 实测，禁止从 baseline 环列表推算**（推算会高估，见 §6 第 1 条）。

### S1 — 把 `state-defaults` 的三类默认值常量挪进零依赖叶子

- **做什么（两件，性质相同，一步做完）**：
  1. `DEFAULT_REFUSAL_END_TURN_TEXT` + `DEFAULT_REFUSAL_ERROR_MESSAGE` 从 `recover-refusal.ts` 迁入 `refusal-policy.ts`（该叶子已拥有第三个常量）；`recover-refusal.ts` 改成 re-export（**注意 `export ... from` 不绑定本地名**，文件内若自用需另 import——telemetry peel 踩过这个坑）；`state-defaults.ts:25` 改指 `refusal-policy`。
  2. **`DEFAULT_SEPARATOR_CARRIER`（§3.7 #11 的值边）** 与它的类型 `SeparatorCarrier` **成对**迁进一个**新建的**零依赖叶子。**两个注意**：① **不要整个搬 `block-layout-contract.ts`**——它 `:1` 依赖 `~/types/api/anthropic`，搬过去等于把那条边一起拽进来；② **不要塞进 `refusal-policy.ts`**——那是 refusal 域的名字，装 block-layout 词汇是名实不符。建一个独立的 block-layout vocabulary 叶子。
- **验收 oracle**：
  - ① **SCC**：**实测组合 PoC（refusal + separator 一起做）仍是 30 环 / 43 成员**——【reviewer 独立复现】。**我原先写「做完第 2 件应当更低」是个没实测就下的预期，已被证伪**（正是 §6 第 1 条的同一个毛病，我在同一份文档里又犯了一次）。**执行期仍须自己重测，别把 30/43 当保证。**
  - ② **三个 refusal 字符串 + `DEFAULT_SEPARATOR_CARRIER` 的逐字 golden**——SCC 数字对字符串内容完全不敏感，typecheck 也抓不住"搬运时手滑改了一个字"。
  - ③ **单一 owner 必须用 source guard 证明，不能用值相等**。⚠️ 我原先写的「`toBe` 而非 `toEqual`」**是错的**：这四个都是 primitive string，`toBe` 与 `toEqual` 对字符串**都只是值相等**，两处独立重复的字面量照样通过。正确形态：**AST 断言旧模块只剩 re-export、不再有自己的声明**（`publicExportNames` / `valueStarReExports` 在 `tests/architecture/source-ast.ts` 已有）。
  - ④ **separator 这一对的完整契约**：`SeparatorCarrier` 与 `SEPARATOR_CARRIERS` 的 key union 编译期一致；`separatorText()` / `makeSyntheticSeparator()` 仍消费同一个新 owner；`block-layout-contract` / `assistant-block-layout` 的原公共路径仍可用。
- **证伪方式**：① 若实测环数明显偏离 30/43，说明 peer 又改了图——**别调整期望值去迁就，先重跑 §3.1 摸清现状**；② golden 必须做变异实验：改任一字符串（含 `DEFAULT_SEPARATOR_CARRIER` 的值）里的一个字符，测试必须变红；③ oracle ③ 的 source guard 也要变异：在旧模块里重新加一份独立声明，必须变红。
- **风险**：极低（移动字面量，行为逐字节不变）。**但"逐字节不变"是需要被证明的主张，不是免检理由**——上面 ②③ 就是它的证明。
- **做完这一步的里程碑**：`state-defaults.ts` 应当**只剩类型出边**（§3.7 #12–#14、#16），零值依赖。这是个可验证的中间态，值得单独确认。

### S2 — models 逻辑回 models 域

- **做什么**：§3.5 ③-a 的 8 个符号 + `rawModels` 模块变量迁往 `src/lib/models/`（建议 `models/cache.ts`）；**106 个直接 import 文件全部改指新家**（4 production + 102 tests——**不是 4 个**，见 §3.5 的口径表；其中 `applyDisabledFilter` 与 `rawModels` 是模块私有、零外部消费者）。`state.ts` 对 `normalizeForMatching` 的 import 随之删除。
- **保留在 state 的**：`models` / `modelIndex` / `modelIds` / `disabledModels` **字段本身**（它们是状态），只是操作它们的逻辑搬走——通过既有的 `updateState` 写入口。
- **⚠️ 两个特殊消费者，别漏**：`tests/helpers/isolated-fixture.ts` 的 `RESETTERS` 表从 `~/lib/state` 取 `resetRawModelsForTests`；`tests/infra/resetters-complete.unit.test.ts` 是个**完备性守卫**，它按名字枚举 `src/` 与 `packages/*/src/` 下所有 `*ForTest(s|ing)` 导出并要求每个都注册或豁免——符号换文件后 import 路径不同步，它会以一种不直观的方式红。
- **⚠️ 批量改测试 import 是【已批准】的，不是权宜之计**：项目 CLAUDE.md 的「无向后兼容负担」明确允许强制迁移旧→新。别因为要动一百个文件就怀疑路线走错了。
- **⚠️ 唯一的"零改动"逃生口在本步【不可用】，而且原因不是纪律而是拓扑**：在 `state.ts` 里加 `export { setModels } from "~/lib/models/cache"` 看似能让 101 个测试免改——但 `models/cache.ts` **必须** import state（字段留在 state），于是 `state.ts → models/cache.ts → state.ts` 立刻是个**两节点环**，正是本任务要消灭的东西。S4 用「反转成注册表」换来了大批测试零改动，**S2 没有对应机制**——这是两步的实质差别，别把 S4 的经验套过来。
- **验收 oracle**：① `rg -n 'normalizeForMatching' src/lib/state.ts` 归零；② **全仓（含 tests）不得再从 `~/lib/state` import 这 8 个符号**——用 AST 检测器，不用 `rg`（别名 import、多行 import、`import type` 都能骗过正则）；③ **AST 断言 `state.ts` 不 re-export 这 8 个符号中的任何一个**（`publicExportNames` + `valueStarReExports`）——这才是咬住 re-export 逃生口的判据；④ **SCC 用集合差不用计数**：复用 `circular-deps-ratchet` 的 `newCycles` / `newMembers` 均为空，**外加一条内容断言：不得存在同时包含 `state` 与 `models/cache` 的环**；⑤ `/api/models` 与 `/api/status` 端点响应逐字节不变（**先把改动前的响应存成 baseline artifact**，起非 4141 端口测试服务器采样；事后再采一次没有对照物）；⑥ 全后端绿。
- **⚠️ 我原先在这里写「环数不回升专门用来咬 re-export」——那是个错的绝对断言**。S2 同时移走 `normalizeForMatching` 与原 models 逻辑边，删掉的旧环**完全可能多于新增的两节点环**，于是 `count` 不回升照样绿。**ratchet 的鉴别力来自集合差（新环/新成员），不来自计数。** 这是我在同一份文档里第二次把「某个 oracle 一定咬得住」当成推理结果而不是实验结果。
- **证伪方式**：① oracle ② 的检测器**先在合成正样本上证明它会命中**（写一行 `import { setModels as sm } from "~/lib/state"` 确认变红）——否则"零命中"只证明了你的正则不认识这种写法；② **oracle ③④ 的正控**：临时在 `state.ts` 加一行 re-export + 让 `models/cache.ts` import state，**必须变红**；③ `setModels` 的调用顺序（写缓存→过滤→重建索引）是有序副作用，**搬迁后必须保序**，用一个"设置 models 后立刻读 modelIndex"的正样本测试确认索引真的被重建了（不是恰好上一次的残留）。

### S3 — 4 个 `resolve*` 回各自域

- **做什么**：§3.5 ③-b 的四个纯函数迁往 **`src/lib/config/model-overrides.ts`（新建）**；10 个直接 import 文件改指新家（7 production + 3 tests，清单见 §3.5）。
- **⚠️ 选址是有硬约束的，别按"迁往消费域"字面理解**：这四个函数的消费者主体在 `src/routes/**`（未来的 server 包），但 `src/lib/config/config.ts`（core）**也**消费 `resolveBufferedCaps`。**落在 `src/routes/` 内会造出一条 `core → server` 脏边**，而 spec §7.2 阶段 1 正在**专门消除**仅存的这类边。**硬约束：目标必须在 `src/lib/` 内。**
- **⚠️ 两个 max-tokens 函数的消费域是空的，但【不许当死代码删】**：`resolveMaxTokensContinuation` / `resolveEffectiveMaxTokensContinuation` 在 src 侧**只有 `state.ts` 自己**用（域外只有一个测试文件）。「迁往消费域」这句话对它们没有可执行语义——本次只需把它们从 state 移出到 core 内同一个新文件，**最终去向由未来的 max-tokens continuation P1 决定**（该特性 P0 已 landed、P1 待做，见记忆 `project-max-tokens-continuation-spec`）。**看到"无 production consumer"就删掉是错的**——项目纪律明令不得以「清理死代码/无消费者」为名擅删。
- **⚠️ 搬完必须同步 5 处陈旧注释**：`src/lib/config/schema.ts:213,789,1387` 与 `config.ts:309,845` 写着「见 `resolveBufferedCaps` **in state.ts**」。这不是可选的整洁工作——`docs/todo/deferred-backlog.md` 里躺着一条**完全同型**的欠账（陈旧交叉引用指向已迁移的符号），说明这个坑在本项目**已经复发过**。
- **验收 oracle**：① 全仓（含 tests）不再从 `~/lib/state` import 这 4 个符号（同 S2 的 AST 检测器 + 正样本自证）；② **`rg 'from "~/routes"' src/lib` 仍归零**（直接复用 spec §7.2 阶段 1 的 invariant——这是唯一能咬住"落在 routes 侧"的判据）；③ 既有 buffered-retry / max-tokens 测试全绿（它们是行为冻结基线）。
- **不作数的 oracle**：「`state.ts` 行数下降」「不再出现 override 合并逻辑」——那是实现形状不是行为，删错东西也能让它成立。
- **证伪方式**：这四个函数读 state 字段——搬走后它们要么继续读 state（合法，state 是叶子），要么改成接收参数。**如果选后者，必须确认所有调用点传的是同一份 live 值**，否则会静默读到快照：写一个"改 state 后立刻再调一次，结果必须跟着变"的正样本测试。

### S4 — 测试 shim 反转成通用 snapshot 参与者注册表

- **做什么**：在 state 里加一个**零领域知识**的参与者注册表（`registerSnapshotParticipant({ snapshot, restore })`），token 包从 core 侧自行注册；`state.ts` 删掉对 `~/lib/token/store` 的 import **以及对 `CopilotTokenInfo` / `TokenInfo` / `TokenStoreSnapshot` 三个类型的依赖**（见 §3.6——签名里还写着 token 类型的话，边根本没断，注册表就白做了）；`setStateForTests` 的宽签名（接收 4 个凭据键）改为转发给已注册参与者。
- **为什么这样而不是把三个函数搬去 `tests/helpers/`**：`setStateForTests` 的调用遍布 **165 个测试文件**（@ `a675064e`）；反转方案让这些**调用点**一行都不用改。
- **⚠️ 红线的准确形状（我第一版写错了两次）**：
  - **第一次**：写成「不改任何测试文件」。那是个**确定会假绿的 oracle**——注册必须有一个明确的接线点，而测试进程根本不走 production composition root。现有的测试地板是 `bunfig.toml` 的三个 preload（`sandbox-paths` → `install-token-deps` → `install-telemetry-deps`），它们只装 ambient ports、**不注册任何 snapshot participant**。所以 S4 **必然要改** preload / fixture / `tests/token/credential-store-isolation.it.test.ts` 这类集中式接线文件。把"零 churn"定得过宽，只会逼着实现者选一个"没注册就静默忽略 token 键"的形状——那样现有测试照旧全绿，而凭据隔离其实已经没了。
  - **第二次**：把文件数当成调用点数。**165 是文件数**（@ `a675064e`）；直接调用点是 **600 多个**（实测 `rg -o 'setStateForTests\(' tests/ | wc -l` → 628，AST 口径 622——差额是注释/字符串命中，**执行期以 AST 为准，并现场重数**）。红线的正确表述是「**这些文件里的每一个调用点，实参不变**」。
- **必须定义并各自有测试的注册表语义**（少一条就是留给下一轮的坑）：重复注册、**缺失 participant 时 fail-fast 还是忽略**、participant 抛错、snapshot/restore 的顺序、snapshot 的类型身份、`"key" in patch` 的显式 undefined 门控（区分"显式 undefined→清空"与"缺席→不动"，token peel 记忆里写过）。
- **验收 oracle**：① **`rg -n '~/lib/token' src/lib/state.ts` 归零**——注意是**整个 token 包**，不是 `token/store`。我第一版写的 `rg 'token/store'` 是个假绿 oracle：state 有**两条**指向 token 的边（`token/store` 的值 + `token/types` 的 `CopilotTokenInfo`/`TokenInfo`），只 grep 前者会在后者仍在的情况下变绿，让人带着"state 与 token 已解耦"的错误结论一路推进到 S6。**这是"换判据形状"的一个小型正例**——把精确子路径换成覆盖整个来源的形状。② **全仓 `setStateForTests(...)` 调用点的 AST 快照前后相等**：对每个 CallExpression 记 **`文件路径 + 该文件内的词法调用序号 + 规范化实参文本`** 三元组，比对改动前后的集合。⚠️ **不要用"全局实参 multiset"**——那样两个调用点互换整份实参也会通过。③ 正向隔离测试：测试 A 写 4 个凭据键、测试 B 断言已复位；④ 生产侧与测试侧**各有一个注册点**，且各自有一条集成测试证明它接上了。
- **⚠️ oracle ② 不能用 `git diff --stat -- tests/` 做**（我第一版就是这么写的，无鉴别力）。两个原因：**(a)** S2/S3 已经合法地改过约 104 个测试文件的 import，S4 的 diff 必然被前序 churn 污染，按文件路径排除区分不出来；**(b)** 它证明的是"文件没改"，而红线是"**调用点的实参**没改"——实现者完全可以在一个因 S2 而本来就允许改动的文件里，顺手删掉一个 `setStateForTests({ copilotToken: undefined })`，凭据清空语义就此回归，而 stat oracle 显示通过。**按文件路径做的排除，恰好在允许改动的地方留了洞。**
- **证伪方式（这步的核心）**：① **三个 mutation 都必须让对应 oracle 变红**——删掉 production 的注册、删掉 test-floor 的注册、改掉任意一个 `setStateForTests` 调用的某个凭据键。只测注册表这个 primitive 本身（"注册了就能取到"）是不够的：那种测试在两处接线全断的情况下依然全绿。

### S5 — 配置词汇归属反转

- **做什么**：**驱动清单是 §3.7，不是一个手写的符号列表**——§3.7 里所有标着「S5」的边（#1–#4、#9、#11 的类型侧、#12–#14），逐条把词汇的归属反转：实现模块从 state import 类型，而不是 state 从实现模块 import。
- **⚠️ 别用手写清单**：我第一版在这里写死了 5 个类型名，实测漏了 4 个（`SeparatorCarrier` 与三个 token 类型）——**人工回忆的清单在这类任务里必漏**。以 §3.7 的机器枚举为准，做完再跑一次枚举确认差集为空。
- **⚠️ 同一词汇有两条路径**：`AssistantBlockLayoutStrategy` / `SeparatorCarrier` 在 `state.ts` 来自 `assistant-block-layout`、在 `state-defaults.ts` 来自 `block-layout-contract`（前者 re-export 后者）。**反转后要指向同一个 owner**，别留两条。
- **⚠️ `./adaptive-rate-limiter` 是跨界边**（§3.7 #9）：相对路径的外观容易让人当成"自己人"跳过，但 S6 搬走之后它就跨包了，且该模块本身依赖 `consola` / `~/lib/error` / `./observability`，绝非叶子。
- **⚠️ 顺手把 `state ↔ state-defaults` 那条环也拆了（§3.7 #10/#16）**——**放在本步做，不要留到 S6**。理由：S5 正在把词汇**搬进** state，拆环是把类型**搬出** state，两个反向动作放在相邻两步会让同一批类型被摸两次，而且执行者要在"哪些归 `state.ts`、哪些归第三个文件"上做一次没有判据的划分。**正解：本步建一个 `state-vocabulary.ts` 承接全部词汇**（S5 反转进来的 + `state-defaults` 需要的那 12 个，**含 `state-defaults.ts:97` 那个内联 `import("./state").MaxTokensContinuationOverride`**），#16 的边顺手就没了。
  - **实测那 12 个类型的外部消费者很少**：`CompiledRewriteRule` 5 个文件、`CompiledSystemPromptEntry` 2 个、5 个各 1 个、4 个**零消费者**。
  - **⚠️ 这里需要在 `state.ts` 留一层 `export type { … } from "./state-vocabulary"` 让那 8 个外部消费者零改动——而这条 re-export 【不会造环】，与 S2 那条被拓扑封死的 re-export 性质【完全相反】**：第三个文件是叶子、对 state 无回边。**你刚在 S2 被教育过"别留 re-export"，别把那条纪律错误地套到这里。** 判据不是"re-export 是坏的"，而是"**这条 re-export 会不会造回边**"。
  - **不要**把那 11 个类型塞进 `state-defaults.ts` 反向让 `state` import。拓扑上成立，但该文件的模块注释自述「holds ONLY the default data, decoupled from the State type shape」——塞进 State 字段类型正好违反它的自述职责。
- **验收 oracle**：① 重跑 §3.7 的 AST 枚举，`state.ts` / `state-defaults.ts` 的出边**只剩下 §5 分叉决定保留的那些 + 指向新词汇文件的边**；② `computeCircularSnapshot()` 实测环数继续下降，且 `circular-deps-baseline.json:71` 那条 `state-defaults > state` 两节点环**消失**。
- **证伪方式**：`RepairItem` 是 `(typeof REPAIR_ITEMS)[number]`——**它依赖那个 const 数组**。搬类型就得连数组一起搬，或改成显式字面量联合 + 一条编译期可赋值性断言防漂移（telemetry T4 对 `TelemetryUsage` 用过这个手法）。

### S6 — `git mv` state + state-defaults → foundation

> **入口判据**：动工前重跑 §3.7 的枚举，两个文件的出边必须**只剩 `node:` 与相对路径**。差集非空就别开始——S6 不是"搬过去再看守卫怎么说"，那是在用守卫做本该 S1–S5 做完的事。

- **做什么**：物理搬迁 + tsconfig path + 边界守卫。
- **⚠️ 守卫要分两层，别混成一个**（我第一版把这句写错了，说"复用 foundation 的 allowlist 检测器"——**foundation 的检测器根本不是 allowlist**）：
  - **(a) foundation 包级**：沿用现有的 `foundationHasForbiddenImport`（`package-boundaries.unit.test.ts`），它是个 **denylist**（拒 `@hsupu/ghc-proxy-{core,server,cli}` + 拒任何 `~/`），**放行任意裸 npm 包**。**不要动它**——foundation 现存文件确实在用裸 npm 包（`repetition-detector.ts` 与 `process-identity.ts` 的 `consola`、`diff/block-align.ts` 的 `diff`），改成严格 allowlist 会打红 3 个与本任务无关的既有文件，逼你去做一次没人批准的重构。
  - **(b) `state.ts` / `state-defaults.ts` 文件级**：**新加**一条更严的 allowlist——只许 `node:` 与相对路径。**这才是"只依赖语言/系统内置"的机器强制。** 形态参考**telemetry 的检测器**（同文件内，注释里明确对比过「telemetry 用 allowlist 而非 token/foundation 的 denylist」），不是 foundation 的。
- **验收 oracle**：① 边界守卫带**两个**正样本（见下）；② **package-wide 无环证明**（见下）；③ `bun run build:backend` + bin `--help` + 端点表面不变。
- **⚠️ 变异实验必须有鉴别力**：只用 `~/lib/x` 做正样本**证明不了任何东西**——旧的 denylist 本来就咬 `~/`，新旧判据在这个样本上没有差别，你会得到一个"变红了"的假信号。**至少两个正样本**：① `~/lib/x`（新旧都咬）；② **一个裸 npm 包**（如 `import x from "lodash"`）——**只有新判据咬**。只有 ② 变红才证明新判据真的更严。
- **⚠️ `computeCircularSnapshot()` 在本步会天然失明**：它的 madge 根是 `path.join(REPO_ROOT, "src")`（实测 `tests/architecture/circular-deps-snapshot.ts`），**不扫描 `packages/`**。state 搬出 `src/` 之后，"state 不在 `members` 里"是**路径消失**的必然结果，不是无环的证明。**必须**扩扫描根到各 workspace 包，或另加一条 `madge packages/foundation/src --circular`；并**做正控**：临时在 foundation 内造一个相对环，确认新 oracle 变红后还原。
- **⚠️ 补上那条 oracle 之后，它可能咬到一条【已知的、预期内的】环**：`state.ts ↔ state-defaults.ts`（§3.7 #10/#16，已在 `circular-deps-baseline.json:71`）。**如果 S5 已按建议建了 `state-vocabulary.ts`，这条环在 S5 就没了、S6 不会看到它。** 若你选择不在 S5 拆，那么它会在这里出现——**这一条不是 S1–S5 没做完**，它是这两个文件之间的固有互指（值 ↔ 类型）。**别回头去找不存在的漏网边**（此时 §3.7 差集为空，你会转而怀疑枚举命令又漏了什么，而那是死路）。两个正当处理，任选其一并写明理由：**(a)** 回头去 S5 拆掉（推荐，环快照会真降）；**(b)** 显式豁免，注明「同一逻辑单元的值↔类型互指，随迁移原样保留」。
- **证伪方式**：守卫"绿"不自证——上面几条 ⚠️ 就是它的证明方式（六轮评审的核心教训，见 §6 第 3 条）。

### S7 — doc-sync（**交付的一部分，不是可选项**）

- **做什么**：把 `docs/` 里所有仍按旧前提描述 state 的地方改到与新事实一致。**必改文件清单**（required-file assertion，少一个就是没做完）：
  - `docs/spec/2026-07-22-monorepo-workspace-split.md` §2.1（「day-1 走不通」）/ §3.1（core 一行含散装 `lib/*.ts`）/ §5（reader seam 方案）/ §7.2 阶段 0d / §11（「error 上提会把 state 拖进 foundation」的否决理由）；
  - `docs/todo/deferred-backlog.md` 的解环排序清单「state 第一」条；
  - `docs/DESIGN.md`「运行时选项」节 + 「活的架构现状」表。
  > 前四处已在文档定稿期加了 supersede 注记（`88df93a8`），**但那只是"标记为旧前提"，不是"按落地结果改写"**——S7 要做的是后者。
- **⚠️ 验收不能只 grep 架构短语**：旧事实有**四个维度**，只扫「留 core / 走不通 / reader seam」这类措辞会在大量 stale 内容仍在时假绿。四个维度各跑一次：
  1. **旧路径**：`src/lib/state(-defaults)?\.ts` —— S6 之后这个路径不存在了，文档里每处引用都要改；
  2. **被迁符号的旧 owner**：`resolveBufferedCaps` / `setModels` / `setDisabledModels` / `getRawModels` / `StateSnapshot` 等，凡是描述成「在 `state.ts` 里」的都错了；
  3. **旧架构短语**：`reader seam` / `reader-*.ts` / `窄读接口` / `state 整个留 core` / `走不通`；
  4. **排序清单**：`state 第一`。
- **验收 oracle**：上述四维检索的每条命中都已处理，或已显式标注为历史前提。
- **证伪方式**：**每个维度各放一个正样本证明检索触达了目标**——拿一条你已知存在的旧说法（比如 spec §5 里的 `reader-*.ts`、DESIGN 里的 `src/lib/state.ts`）验证 grep 能命中。**否则"零命中"只说明你的检索式不对**，这正是本项目「通过/空/干净结论不自证」那条纪律的直接应用。

## 5. 分叉裁决结果（**2026-07-28 用户已拍板，别再重开**）

> 原文的四条待裁决分叉已由用户逐条定案（AskUserQuestion，2026-07-28）。下面保留每条的原始选项与理由，便于日后回看「为什么选了这条」。

1. **`Model` / `ModelsResponse`** → ✅ **(a) 一并下沉 foundation**。它们是 GHC 上游 wire 类型，state 持有 `models: ModelsResponse` 与 `modelIndex: Map<string, Model>` 字段（本次不搬字段），所以 state 必须拿到这两个类型。
   - **落地形态**：挪进 `packages/foundation/src/`（挨着已有的 `ghc-http-primitives.ts`），`src/lib/models/client.ts` 改为 re-export → **86 个消费端零改动、零重复定义、单一 owner**。
   - 未选 (b)「state 侧结构型 + 编译期可赋值性断言」：`Model` 是个约 40 字段的 interface，复制一份等于长期双份维护；断言只防漂移、不消除重复。
   - 未选 (c)「保留边、放宽 S6 守卫」：等于自废 S6 的核心交付。
   - **代价（已认可）**：foundation 从「只装协议管道常量」扩成也装 GHC 响应体形状。
2. **S2 之后 `models` 字段是否跟着走** → **本次不动**（范围就是「逻辑回域、字段留 state」）。models 域将来若抽包，字段迟早要动，此处只做标记。
3. **`~/lib/token/types`（§3.7 #6，包分层反转）** → ✅ **(b) S4 的参与者注册表做成领域无关**，使 state 侧**根本不出现 token 类型名**，三条边（`token/store` 的值 + `token/types` 的两个类型 + `TokenStoreSnapshot`）一次性消失。
   - **为什么**：与 S4「零领域知识」的立意自洽，且不让 foundation 承载别域形状。
   - **实现要点**：patch 形状由各域自己贡献（泛型参数，或 TS `declare module` 声明合并）。**红线仍是 165 个测试文件的调用点实参不变**——所以不能简单退化成 `Record<string, unknown>` 把实参类型安全丢掉。**具体机制在 S4 动工时定，但「state 侧零 token 类型名」是硬判据。**
   - 未选 (a)「三个 token 类型下沉 foundation」：机制更简单，但 `TokenStoreSnapshot` 与 store 实现耦合较紧，且 foundation 会承载凭据域形状。
   - 未选 (c)「保留边、放宽守卫」。
4. **spec §7.2 阶段 0d 与 S2 的关系** → ✅ **0d 作废，被本任务吸收**。
   - **理由**：reader seam 的立论是削环（spec §5 的 day-1 承诺）；state 成叶子后**叶子无出边、谁依赖它都不成环**，削环由拓扑直接解决，再建 `core/state/reader-*.ts` 是纯 churn。
   - **「窄读接口」的封装/爆炸半径收益若仍想要，另立独立 backlog 条目**，不作为本任务前置。→ **S7 必须把 spec §7.2-0d 与 §5 改写成这个结论**，并在 `deferred-backlog.md` 留下那条独立条目。

## 6. 我犯过的错（**比结论更有用，别重犯**）

> 每条都标了**本任务的复发点**——教训不绑到具体步骤上，读的时候会点头、做的时候照样踩。

1. **拿基线环列表推算削环量，高估了 8 条**。我先用 `circular-deps-baseline.json` 的环列表模拟"切掉某条边"，算出 70→21；实际跑 madge 是 70→29（本次重测 30）。原因：基线是**规范化后的环列表**，在这个表示上切一条边会把本可经其它路径成立的环也算没了。**教训：SCC 数字只认 `computeCircularSnapshot()` 实测。**
   → **复发点：S1 / S2③ / S5② / S6** 四处都要量环，而 `circular-deps-baseline.json` 就躺在仓库里、比跑 madge 省事得多，诱因是结构性的。

2. **过度设计：提议单独建 `config-vocabulary` 模块**。理由已写进 §2 的 ❌ 条目（叶子无出边，state 自己就是词汇的家）。→ **不会复发**（已被范围禁令硬编码），列在这里只是留个来由。

3. **守卫"绿"不自证——这是刚过去那六轮评审的核心教训**。telemetry peel 的合并态审跑了六轮，每轮异模型 reviewer 都用**合法且能编译**的写法绕过我刚加固的守卫（别名导出、`export *`、注释夹在 token 之间、`catch` 分支、没人调的 helper、可选链……）。两次真正的转折点都不是"更强的守卫"，而是**换判据形状**（blocklist→allowlist）和**换不变量位置**（把顺序契约搬进 runtime 自己）。详见记忆 `methodology-relocate-invariant-when-guard-cannot-keep-up`。
   → **复发点：S6 的边界守卫，且陷阱已经摆好了**——现有 foundation denylist 本来就咬 `~/`，你最可能选的正样本恰好落在新旧判据的交集里，**变异实验会假绿**。S6 那条「至少两个正样本、其中一个是裸 npm 包」就是为此写的。
   → **第二个复发点：S4 的 oracle**。我自己在第一版就犯了这个错——`rg 'token/store'` 是个精确子路径判据，对 `token/types` 天然盲。**换成覆盖整个来源的形状**（`rg '~/lib/token'`）才咬得住。

4. **写交接前没先看 `git log`——差点用陈旧事实**。本文成稿前 HEAD 已从我实测时前进 20 个提交，其中 peer 大改了 `recover-refusal.ts`（还顺手建了 `refusal-policy.ts` 这个正是我需要的零依赖叶子）。**我重测后才发现 S1 的工作量已被 peer 砍掉三分之一**。教训：交接一旦陈旧，危害大于没有。
   → **复发点：动工第一件事**。而且**重跑范围不止 SCC 数字**——按顺序跑完这三样再动手：① §3.1 的环数；② **§3.7 的出边枚举**（差集非空就先补表）；③ §3.5 的消费者计数。**行号一律以符号名为准**（`rg -n 'export function setModels' src/lib/state.ts`），本仓库并发提交频繁、行号必然漂移，§3.3 表里 `state-defaults` 那行的 `:2025` 在成稿当天就已经漂到 `:2035`。

5. **注释写错会让照着注释写的代码看起来是对的**。同一轮我在一个守卫的文档里写「try/catch/finally 都不 gate 正常路径」——对 `catch` 是错的，于是"把生产调用从 try 移进 catch"编译通过、正常路径永不执行、守卫全绿。自洽且完全错。
   → **复发点一：S3 之后**，`config/schema.ts:213,789,1387` 与 `config.ts:309,845` 那 5 处「见 `resolveBufferedCaps` in state.ts」会全部变成谎言。`docs/todo/deferred-backlog.md` 里躺着一条**完全同型**的欠账，证明这个坑在本项目已经复发过一次。
   → **复发点二：S6 守卫自身的判据注释**。一句「本守卫强制只依赖内置」配上一个实际只咬 `~/` 的 denylist，就是原坑的完整复刻。

6. **把「削环视角」的审计结论当成了「叶子化视角」的前提**。§3.3 / §3.6 回答的是「state 为什么在 SCC 里」，我直接拿它当成了 S6 的入口判据——但 SCC 只关心**成环的**边，叶子化关心**所有**出边。差集是 5 条，其中一条（`~/lib/token/types`）牵动包分层反转。**照第一版的六步走完，S6 会在投入 5 个提交之后必红**，而那时最省事的动作是把守卫改弱——正好命中第 3 条自己写的教训。
   → **这就是 §3.7 存在的原因**。**教训：问题换了，答案就得重新算一遍，别复用形状相似的旧结论。**
   → **同一个毛病我在两轮评审里一共犯了三次**：① 削环结论当叶子化前提（本条）；② §3.7 回答「还剩哪些出边」，而 S6 的 package-wide oracle 问的是「foundation 内部还有没有环」——「同一单元，一起走」这个答案被原样复用，漏掉了 `state ↔ state-defaults` 那条会跟进 foundation 的两节点环；③ 见第 8 条。**三次都是「问题变了、答案没跟着变」，而每一次我都以为自己已经吸取教训了。** §3.7 那张表现在有一列「S6 之后是否仍然存在」，就是把这个检查做成表格槽位、不靠记性。

7. **用 `^\s*import` 枚举出边，静默漏掉全部多行 import**。本仓库的排版把 `from` 放在多行 import 的收尾行。**教训：枚举类判据要从"你以为的语法形态"换成"目标一定会出现的锚点"**（这里最终是 AST），这又是第 3 条同一个道理的实例。两位 reviewer 里也有一位在 `state-defaults.ts` 上踩了同一个坑。

8. **给自己新写的 oracle 断言"它一定咬得住"，而那只是推理不是实验**。整改时我给 S2 加了「环数不回升」并写道「**专门用来咬 re-export 逃生口，前两条 oracle 对它全绿**」——错的：S2 同时移走了别的边，删掉的旧环完全可能多于新增的两节点环，`count` 不回升照样绿。**鉴别力来自集合差（新环/新成员），不来自计数。** 同一轮我还写了「`toBe` 而非 `toEqual` 能证明是同一份绑定」——对 primitive string **两者都只是值相等**，两处独立字面量照样通过。
   → **教训：oracle 的鉴别力和代码的正确性一样，是需要被实验证明的，不能靠推。** 我在文档里教育别人「守卫绿不自证」，转头就给自己新写的三个 oracle 下了没做实验的绝对断言。**复发点：你新加的每一个 oracle，都要问"什么变异能让它红"，答不上来就是没鉴别力。**

## 7. 产物清单

| 产物 | 路径 | 已提交? | 它**没有**证明什么 |
|---|---|---|---|
| 本交接 + kick-off | `docs/plan/2026-07-28-state-to-foundation/{HANDOVER,KICKOFF}.md` | 是 | — |
| 两份异模型评审报告 | 同目录 `HANDOVER-review-{gpt,claude}.md` | 是 | GPT 那份独立复现了 PoC 数字并证伪了 4 个 oracle；Claude 那份以接手方视角找出 2 个 BLOCKER。**两份都没有覆盖对方的领域**——GPT 没做接手方走查，Claude 明确声明不复核数值。**也都漏了 `./adaptive-rate-limiter` 这条边**（§3.7 #9），是我在整改时枚举出来的。别把「两轮评审过了」当成完备性证明 |
| S1 削环 PoC | **无留存**——改完实测完即 `git checkout --` 还原 | 否（有意不留） | 它只证明了「挪走那两个常量后 madge 图变成 30 环/43 成员」。它**没有**证明：改完 typecheck 绿、测试绿、`recover-refusal.ts` 的 re-export 形态可用（PoC 期间恰好撞上 `export … from` 不绑定本地名的 TS2304，是当场手工绕过的），更**没有**证明 state 因此就成了叶子——S1 只削环，state 落地 foundation 要等 S6 |
| 上一轮 telemetry peel 的执行期偏差记录 | [plan-telemetry-package.md](../monorepo-split/plan-telemetry-package.md) 头部 | 是 | 那是抽包流程的经验，本次**不抽包**，只有边界守卫与过渡纪律可复用 |

**没有 `exp/<topic>/` 目录**：本轮唯一的实验是一次可在 30 秒内重跑的削环量测，配方已完整写进 §3.2 与 §4/S1，留一份实验目录只会多一处会漂移的事实源。**重跑配方**：把 `DEFAULT_REFUSAL_END_TURN_TEXT` / `DEFAULT_REFUSAL_ERROR_MESSAGE` 移入 `src/lib/anthropic/refusal-policy.ts`、`state-defaults.ts:25` 改指该文件，然后跑 `computeCircularSnapshot()`。

## 8. 当前环境状态（接手须知）

- **`rustup` 无任何已安装 toolchain** → `bun run test:backend` 的前置 `build:history-search` **必挂**。用 `bun scripts/parallel-test.ts unit it http`（等价全后端档）。修法：`rustup default stable`。
- **主树有并发 peer 的未提交改动**（十几个文件）。一律显式 pathspec 提交，`git add -A` 绝对禁止。
- **typecheck 当前有 peer 在飞的报错**（`PostCommitAbortKind` / `retry-giveups`）——**不是你引入的**，别去"修"它，只确认自己的改动没新增错误。
- 代码改动走隔离 worktree（`git worktree add .worktrees/state-foundation -b feat/state-foundation`；`.worktrees/` 在仓库内部、向上解析主树 `node_modules`，**不是依赖隔离环境**——原文的「否则 eslint exit 127」已被实测证伪，无 `node_modules` 的新树里 eslint exit 0）；**本交接文档本身留在主树**。
