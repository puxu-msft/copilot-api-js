# HANDOVER / KICKOFF 接手方视角评审（Claude reviewer）

> **评审对象**：`docs/plan/2026-07-28-state-to-foundation/{HANDOVER,KICKOFF}.md`（工作区当前版本，含 `773773b2` 补的头部两行 + §7 产物清单、`31e39d6f` peer 对 worktree/eslint 一句的订正）。
> **评审方法**：第一人称模拟接手——对文档让我做的**每一个动作**，实地去仓库查那个位置存不存在、长什么样。不是读文档挑毛病。
> **裁判轴（调用方指定）**：长远正确 + 完整。**不使用 ROI / YAGNI**，不以「够用了 / 可以再砍范围 / 以后再说」结案。
> **不在本报告范围**（另有 reviewer 独立实测）：`70 环/63 成员 → 30/43`、`165 个文件` 等计数的算术准确性。本报告只在「计数口径影响执行动作」时提及，不复核数值本身。
> **未评审**（按要求）：§2 用户已裁定的 6 条范围、§5 的两个待裁决分叉。

---

## 总判（先说结论）

**「一个全新会话能否在不问原作者的情况下把 S1 做完？」→ 能。**

S1 是这份交接里质量最高的一步：目标模块现成（`src/lib/anthropic/refusal-policy.ts` 确实存在、41 行、零 import 已核）、要搬的两个常量位置已核（`recover-refusal.ts:100` / `:109`）、re-export 形态的坑写了（`export … from` 不绑定本地名，`recover-refusal.ts:114` 已有同款先例）、验收 oracle 是可跑的实测命令、证伪方式写了「别调整期望值去迁就」。接手方照做不会卡。

**但「能做完 S1」远不等于交接成功。真正的断点在 S2，且 S6 是一个已经注定会红的终点。** 本次发现 2 个 BLOCKER、4 个 MAJOR：

- **S6 在 S1–S5 全部做完之后仍然做不成**——`state.ts` / `state-defaults.ts` 至少还有 4 条文档从未登记的跨界依赖（详见 B-1）。接手方会在第 6 步、投入 5 个提交之后才撞上，而这 4 条边里有一条（`~/lib/token/types`）牵动的是**包分层反转**，不是搬个类型能解决的。
- **S2 的编辑面被低报了一个数量级以上**，而这一步唯一的「零改动」逃生口（在 `state.ts` 里 re-export）**被本任务的目标本身封死**（会立刻重建 state→models 环）。文档对此只字未提。

这份交接的**事实层质量很高**（证据等级标注、实测 / 读证分离、S1 的 PoC 与还原、§6 的错误清单都是真材实料），问题集中在**「已确证的事实」与「执行步骤」之间的覆盖缺口**：§3 审计的是「state 为什么在 SCC 里」，而 S6 需要的是「state 还剩哪些 `~/` 出边」——这是两个不同的问题，文档把前者当成了后者。

---

## 双视角覆盖证据

**机械核对做了什么**

- `ls` 核对 §1 入口指引表的链接：`plan-token-package.md`、`plan-telemetry-package.md`、`spec/2026-07-22-monorepo-workspace-split.md` 全部存在；`rg '^#{1,3} '` 核对 spec 章节，**§7.2 确实存在**（「阶段序列」）。**无断链**。
- 通读 spec `2026-07-22-monorepo-workspace-split.md` §2.1 / §3.1 / §5 / §5.1 / §6 / §7.1–7.4，与 HANDOVER 逐条对账。
- 逐个核对 §3.2 / §3.3 / §3.5 / §3.6 的符号位置：`recover-refusal.ts:100/109/114`、`refusal-policy.ts:15`、`state-defaults.ts:22-26`、`state.ts` 的 6 条 import 语句、`StateSnapshot`（`state.ts:1187-1190`）。
- 枚举 `state.ts` 与 `state-defaults.ts` 的**全部** import / export-from 语句（不只头部），与 §3.3 / §3.6 的清单做差集——差集非空，即 B-1。
- 读 `tests/architecture/package-boundaries.unit.test.ts` 的三个检测器（foundation / token / telemetry），确认 S6 描述的「allowlist 检测器」实际长在哪一个上。
- 读 `tests/infra/resetters-complete.unit.test.ts` 的 `EXEMPT` 表与枚举根，读 `tests/helpers/isolated-fixture.ts:76-80,138`。
- `rg -l` 各步待搬符号的消费者，逐个区分 **src / tests / 注释命中**三类。
- 全仓 grep `2026-07-28-state-to-foundation`（排除本目录）→ **零命中**，即 M-3。
- grep 两份文档的 `bun install` / `127`，确认 peer 订正无残留（见 C-0）。

**第一人称执行模拟了哪些路径**

- 完整走查 S1→S6 六步，每步问「我现在要动手，信息够吗」，并在仓库里实地找目标位置。
- 模拟 S2 的动作序列：把 `setModels` 搬到 `models/cache.ts` → 谁会红 → 我有哪几种补救 → 每种补救与本任务目标是否冲突。这条路径走到底才暴露出「re-export 逃生口被目标封死」。
- 模拟 S4 完成后跑它自己给的 oracle（`rg 'token/store' src/lib/state.ts` 归零）→ 绿 → 但 `~/lib/token/types` 仍在。这是「oracle 绿而目标未达成」的假绿路径。
- 模拟 S6 落地：把 `state.ts` 放进 `packages/foundation/src/` 后，逐条对照 `foundationHasForbiddenImport` 的判据看哪些 import 会被咬。
- 模拟「接手方不是从 KICKOFF 进来，而是从 `docs/` 摸索进来」的路径：读 DESIGN.md → 读 spec §7.2 → 读 deferred-backlog「state 第一」→ **走到的是另一套方案（reader seam），永远到不了本目录**。
- 模拟 S3 的选址决策：查 4 个 `resolve*` 的真实消费者分布 → 发现主体在 `src/routes/**` → 推演接手方最可能选的落点及其后果。

---

## 事实性发现

### BLOCKER

---

**[BLOCKER] B-1　`HANDOVER.md:140-144`（S5）+ `:146-150`（S6）+ `:100-106`（§3.6）—— S1–S5 全部做完后，`state.ts` / `state-defaults.ts` 仍有至少 4 条未登记的跨界依赖，S6 必红**

**证据（实地枚举，非推断）**

`state.ts` 的全部 import（`rg '^\s*(import|export).*from' src/lib/state.ts`）：

```
:1-5    import type { AssistantBlockLayoutStrategy, SeparatorCarrier } from "~/lib/anthropic/sanitize/assistant-block-layout"
:6      import type { ThinkingBlockSanitizeMode }   from "~/lib/anthropic/sanitize/content-blocks"
:7      import type { RepairItem }                  from "~/lib/anthropic/tool-input-repair"
:8      import type { ModelTranslation }            from "~/lib/config/schema"
:9-14   import type { Model, ModelsResponse }       from "~/lib/models/client"
:15-19  import type { CopilotTokenInfo, TokenInfo } from "~/lib/token/types"      ← 全文未登记
:20     import { normalizeForMatching }             from "~/lib/models/model-name"
:21-30  import { …6 符号…, type TokenStoreSnapshot } from "~/lib/token/store"
:32     import type { AdaptiveRateLimiterConfig }   from "./adaptive-rate-limiter"
:2035   export { … } from "./state-defaults"
```

`state-defaults.ts` 的全部 import：

```
:16    import type { ThinkingBlockSanitizeMode } from "~/lib/anthropic/sanitize/content-blocks"
:17    import type { RepairItem }                from "~/lib/anthropic/tool-input-repair"
:18    import type { ModelTranslation }          from "~/lib/config/schema"
:21-25 import { DEFAULT_REFUSAL_* × 3 }          from "~/lib/anthropic/recover-refusal"                ← S1 处理
:26    import { DEFAULT_SEPARATOR_CARRIER }      from "~/lib/anthropic/sanitize/block-layout-contract"  ← 全文未登记，且是【值】
```

与 §3.6 的清单（`AssistantBlockLayoutStrategy` / `ThinkingBlockSanitizeMode` / `RepairItem` / `ModelTranslation` / `AdaptiveRateLimiterConfig` / `Model`+`ModelsResponse` / `TokenStoreSnapshot`）做差集，**S1–S5 全做完后仍存活的边**：

| # | 残留边 | 位置 | 为什么 S1–S5 治不到 |
|---|---|---|---|
| 1 | `SeparatorCarrier` → `~/lib/anthropic/sanitize/assistant-block-layout` | `state.ts:4`，用于 `:520 readonly separatorCarrier: SeparatorCarrier` | §3.6 枚举漏了它；S5 只点名同一 import 语句里的 `AssistantBlockLayoutStrategy`。搬走一个、留下一个 → **import 语句本身不消失** |
| 2 | `CopilotTokenInfo` / `TokenInfo` → `~/lib/token/types` | `state.ts:15-19`，用于 `:1993-1994` `setStateForTests` 签名 | §3.3 只审计了 `~/lib/token/**store**`；§3.6 提了 `TokenStoreSnapshot`（来自 `store`）却没提 `types`。**S4 的 oracle 是 `rg 'token/store'` 归零——对 `token/types` 天然盲** |
| 3 | `DEFAULT_SEPARATOR_CARRIER`（**值**）→ `~/lib/anthropic/sanitize/block-layout-contract` | `state-defaults.ts:26`，用于 `:107` | §3.2 断言「承重边是三个字符串常量」——那是**削环**结论，不是**出边清单**结论。文档全文没有一处审计过 `state-defaults.ts` 的完整出边 |
| 4 | 上条的传递依赖：`block-layout-contract.ts:1 import type { ContentBlockParam } from "~/types/api/anthropic"` | 已核，该文件 86 行、**非**零依赖 | 即使把 `DEFAULT_SEPARATOR_CARRIER` 连同 `block-layout-contract` 一起搬进 foundation，也会把 `~/types/api/anthropic` 拽进来 |

其中 **#2 不是「搬个类型」能解决的，是包分层问题**：`packages/token/package.json:10-13` 声明 `"@hsupu/ghc-proxy-foundation": "workspace:*"`——token **依赖** foundation。若 `state.ts` 进 foundation 而仍 import `~/lib/token/types`（该别名经 `tsconfig.json` 解析到 `packages/token/src/types.ts`，已核），就是 **foundation → token → foundation 的包级环**。而 `package-boundaries.unit.test.ts:56-58` 的 `foundationHasForbiddenImport` 对 foundation 内**任何** `~/` 一律判违规（`ROOT_ALIAS = ~\/`），`import type` 不豁免。

**接手方会做出什么错误动作**

按 S1→S6 顺序推进，前五步每步 oracle 都绿（S4 的 `rg 'token/store'` 归零确实会归零），于是相信「前置条件已满足」，在 S6 做 `git mv` + 加守卫。此时守卫一次性爆出 4 条违规。接手方面对的是一个**没有预案的十字路口**，而且是在已经产出 5 个提交、`state.ts` 已被大改之后：

- **最可能的错误动作 A**：为了让守卫变绿，**把守卫改弱**（给 foundation 检测器开一个 `~/lib/token/types` 例外，或干脆放行 `import type`）。这正好命中 §6 第 3 条自己写下的教训——「用合法写法绕过守卫」，而且这次绕过者是执行者自己。守卫从此不再保证「只依赖内置」，S6 的整个价值蒸发，但一切都是绿的。
- **错误动作 B**：临时决定把 `~/types/api/anthropic`、`block-layout-contract`、token 类型一并拖进 foundation，做出一个远超用户批准范围的搬迁决定（§2 明确「别再重开范围议题」，但这里被迫要扩范围）；且 foundation→token 的分层反转他很可能看不出来（`import type` 运行时无环，极易被判为「无害」——spec §2.1 恰恰记录过同款误判：`error/http-error.ts` 就是被 type-only 边拴住的）。
- **错误动作 C**：停下来问原作者。这是唯一正确的动作，但代价是 5 个提交之后才发现交接不完整。

**修法**

1. 在 §3 增补一条硬事实（建议编号 §3.7）：**「`state.ts` + `state-defaults.ts` 的完整出边清单 @<sha>」**，把 `rg '^\s*(import|export).*from "' src/lib/state.ts src/lib/state-defaults.ts` 的**原始输出**贴进去（机器枚举，不靠人工回忆），并逐条标注「由哪一步消除」。任何一条对不上步骤的，就是缺口。这条清单是 S6 的**前置条件定义**，缺了它 S6 没有可判定的入口判据。
2. S5 的符号清单从 5 个改为**「§3.7 清单里所有非 `node:`、非相对路径的 import，逐条给去向」**；`SeparatorCarrier` 显式补入。
3. **`~/lib/token/types` 单独升级为 §5 的第 3 个待裁决分叉**——它和 `Model` / `ModelsResponse`（现 §5 分叉 1）是同一类问题（foundation 该不该承载别的域的形状），但比后者更硬：`Model` 只是 core 内的类型，token 却是一个**已经存在、且已依赖 foundation** 的兄弟包，方向反转是分层违规而非品味问题。候选路径至少三条，需用户拍：(a) `TokenInfo` / `CopilotTokenInfo` / `TokenStoreSnapshot` 下沉 foundation（token 包改为从 foundation re-export）；(b) S4 的参与者注册表把 `setStateForTests` 签名做成**领域无关的泛型**，使 state 侧根本不需要这几个类型名——**这条与 S4 的「零领域知识」立意最自洽，我倾向它**；(c) 保留边、放弃「foundation 零 `~/`」的守卫强度（不推荐，等于自废 S6）。
4. `state-defaults.ts` 的 `DEFAULT_SEPARATOR_CARRIER` 需要一步专属处理，建议并入 S1（性质完全相同：把默认值常量挪进零依赖叶子），但必须同时解决 `block-layout-contract.ts:1` 对 `~/types/api/anthropic` 的类型依赖——最省的做法是把 `DEFAULT_SEPARATOR_CARRIER` 与 `SeparatorCarrier` 这**一对**（同一词汇的值与类型）一起放进 foundation 的新叶子，而不是搬整个 `block-layout-contract`。
5. §3.6 当前标注为 **【推断，但机制可靠】**（`HANDOVER.md:100`），而模板 `.claude/skills/session-closeout/handover.md:33` 明确要求「『推断』级的必须写明还差什么才能升到『实测』」——**这个槽位是空的，而它正是 B-1 的藏身处**。把「还差什么」写出来（差的正是「跑一遍完整出边枚举」），这个 BLOCKER 在写作阶段就会自己暴露。

---

**[BLOCKER] B-2　`HANDOVER.md:120-125`（S2）+ `HANDOVER.md:85`（§3.5 ③-a）+ `KICKOFF.md:46` —— S2 的编辑面被低报一个数量级，且唯一的零改动逃生口被本任务目标封死；文档未给任何机制**

**证据**

S2 原文：「§3.5 ③-a 的 8 个符号 + `rawModels` 模块变量迁往 `src/lib/models/`（建议 `models/cache.ts`）；**4 个域外消费者改 import**」。§3.5 ③-a 也写「**域外消费者：4 个文件**（`rg -ln` 实测）」。

实地 `rg -l` 逐符号（`src` + `tests` + `packages`）：

| 符号 | src 侧消费者 | tests 侧消费者 |
|---|---|---|
| `setModels` | `src/lib/models/client.ts`（`:13`、`:33 if (models) setModels(models)`） | **约 100 个测试文件** |
| `setDisabledModels` | `src/lib/config/config.ts` | 约 16 个测试文件 |
| `getRawModels` | `src/routes/models/internal.ts`、`packages/cli/src/start.ts` | — |
| `getConfigDisabledIds` | `src/routes/models/internal.ts` | — |
| `resetRawModelsForTests` | — | `tests/helpers/isolated-fixture.ts:76-80,138`、`tests/models/models-client.it.test.ts`、`tests/infra/resetters-complete.unit.test.ts` |
| `applyDisabledFilter` | —（state 内部） | `tests/models/internal-route.http.test.ts` |
| `rebuildModelIndex` | —（state 内部） | — |

「4 个域外消费者」是 **src 侧**口径（`models/client.ts` / `config/config.ts` / `routes/models/internal.ts` / `packages/cli/src/start.ts`，正好 4 个），口径本身自洽——**但 S2 的动作栏直接把它当成了编辑面**。测试侧确认是直接从 `~/lib/state` 具名导入的，例如 `tests/models/internal-route.http.test.ts:10`：

```ts
import { setModels, setDisabledModels } from "~/lib/state"
```

**关键点：唯一的「零改动」逃生口被目标本身封死。** 接手方最自然的补救是在 `state.ts` 里加一行 `export { setModels } from "~/lib/models/cache"`——但新建的 `models/cache.ts` 必须写 `state.models` / `state.modelIndex`（S2 明确「字段留 state，通过既有 `updateState` 写入口」），所以它必然 import state。于是 `state.ts → models/cache.ts → state.ts` 是一个**两节点环**，正是本任务要消灭的东西。S4 用「反转成注册表」换来了大批测试零改动，**S2 没有对应机制，而文档没有承认这一点**。

**接手方会做出什么错误动作**

1. 按「4 个文件」估工，开做，typecheck 一跑冒出约百个测试文件报错。此时最省事的动作就是**在 `state.ts` 加 re-export**——编译立刻绿、测试全绿、`rg 'normalizeForMatching' src/lib/state.ts` 归零（S2 的 oracle ① 也绿），**三个 oracle 全过**。只有 SCC ratchet 会咬，而 **S2 的 oracle 列表里恰恰没有列 `computeCircularSnapshot()`**（只有 §4 开头的通用不变量里有一句）。这是一条**能一路走通到提交、却把 S2 的全部价值抵消掉**的路径。
2. 或者他被 `KICKOFF.md:46`「**别改 `tests/` 下的 165 个 `setStateForTests` 调用点**」误导——这句本意只约束 S4，但接手方读到的是一条关于 `tests/` 的禁令；在 S2 撞上百个测试文件要改时，很可能把它读成「测试不该改，所以我这条路走错了」，从而放弃正确路线转向 re-export。
3. 第三种：老老实实改约百个测试文件（**这在本项目是合法且被鼓励的**——CLAUDE.md「无向后兼容负担」，强制迁移旧→新）。但他不会知道这是被批准的选择，因为文档没说；而且他会漏掉 `tests/helpers/isolated-fixture.ts:76-80`（`RESETTERS` 表从 `~/lib/state` 取 `resetRawModelsForTests`）与 `tests/infra/resetters-complete.unit.test.ts` 这个**完备性守卫**——后者按名字枚举 `src/` 与 `packages/*/src/` 下所有 `*ForTest(s|ing)` 导出并要求每个都注册或豁免，符号换文件后 `RESETTERS` 的 import 路径必须同步，否则守卫会以一种不直观的方式红。

**修法**

1. S2 的「做什么」栏把编辑面**如实写出**：src 侧 4 个 + tests 侧约 N 个（给出 `rg -l` 命令让接手方自己重数，别写死数字），并**显式点名** `tests/helpers/isolated-fixture.ts` 与 `tests/infra/resetters-complete.unit.test.ts` 这两个特殊消费者。
2. **明确写死路线选择并给理由**：「测试侧 import 路径批量改写是**已批准**的（无向后兼容负担）；**禁止**在 `state.ts` 里 re-export——那会重建 state→models 环，直接抵消本步价值。」这一句是本步最重要的一句话，现在完全没有。
3. S2 的验收 oracle 补一条：**`computeCircularSnapshot()` 实测环数不回升**——专门用来咬 re-export 逃生口。现有三条 oracle 没有一条能咬住它。
4. `KICKOFF.md:46` 那条禁令**限定作用域**：改成「S4 不得改 `tests/` 下的 `setStateForTests` 调用点（反转方案就是为此）。**注意 S2 相反**：S2 需要批量改写测试侧的 models 符号 import，那是预期内的。」——否则两步的纪律会互相污染。

---

### MAJOR

---

**[MAJOR] M-1　`HANDOVER.md:18`（§1 入口指引指向 spec §7.2）—— 与 spec 的正面冲突未对账：spec 白纸黑字写着本任务「走不通」，且为 state 规定了另一套机制**

**证据**

§1 让接手方「需要理解本步在总路线中的位置时」去读 `spec/2026-07-22-monorepo-workspace-split.md §7.2`。链接与章节都存在（已核）。但接手方读到的是：

- **spec §2.1**（`:43`）：「`state.ts` **本身不是叶子**：反向 import `models/model-name`(value) + `anthropic/recover-refusal`(value) + type 依赖 `models/client` / `config/schema` / `anthropic/sanitize`。state 是 SCC 的核心节点、被 ~83 个 src 文件 `import { state }` 依赖——**「把 state 沉到 foundation」day-1 走不通**（会拽下半个 SCC），**强化「state 实现整个留 core」的正确性**。」
- **spec §3.1 表**：core 一行明确含「散装 `lib/*.ts`（state 等）」；foundation 一行「day-1 只收『已证纯』，不贪多」。
- **spec §5**：用户裁断的 state 方案是**窄读接口 seam**（`core/state/reader-*.ts`）+ day-1 强迁 ~83 个消费端、不留双轨。
- **spec §7.2 阶段 0d**：「**剩余 0d 范围 = models 域**」——与本交接 S2 的对象**正好是同一个域**，但机制不同（0d 迁的是 `import { state }` 的**消费端**到 reader seam；S2 搬的是 state 里的**逻辑**出去）。
- `docs/todo/deferred-backlog.md:1006`：解环排序清单仍写「**state 第一**（~83 importer、SCC 入口）……每次只剥一个」。

HANDOVER 全文没有一句话说明本任务与 spec §2.1 / §5 / §7.2-0d 的关系（是推翻？是前提已变？是 0d 被吸收？）。

严格说这不是逻辑矛盾——spec 说「day-1 走不通」的**理由**（那三条 value/type 边）正是 S1–S5 要消除的东西，所以「前提变了、结论随之改变」完全成立。**但这个推理链只存在于原作者脑子里，文档里一个字都没有。**

**接手方会做出什么错误动作**

- 读完 spec §2.1 后**不敢动手**：他刚被 §2 告知「用户已裁定的范围别再重开」，转头在项目 spec 里读到同一件事被判定「走不通」+「强化 state 整个留 core 的正确性」。两个权威冲突，且 CLAUDE.md 规定 `docs/` 是单一事实源。理性动作是停下来问用户——交接失败。
- 或者更糟：**认为 spec 更权威**（它经过评审、在 `docs/spec/`，而这只是一份 plan 目录下的 HANDOVER），于是照 spec §7.2-0d 去建 `core/state/reader-*.ts` 窄读接口——**做出一套与本任务方向不同、且事后要拆掉的基础设施**。0d 的「剩余范围 = models 域」还会让他确信自己找对了地方，因为本交接的 S2 也在 models 域。
- 即使他选择相信 HANDOVER，**spec 与 backlog 仍留在错误状态**：任务做完后 `docs/` 里同时存在「state 留 core / 走 reader seam」与「state 在 foundation」两套说法，下一个接手方重蹈覆辙。

**修法**

1. HANDOVER 增补一节（建议放 §2 之后）：**「与 spec `2026-07-22` 的关系」**，三句话讲清：① spec §2.1 判「走不通」的依据是当时 state 的三条实边；② S1–S5 逐条消除的正是那三条依据，故结论随前提改变，**不是推翻用户裁断**；③ 本任务落地后，spec §2.1 / §3.1 / §5 / §7.2-0d 与 `deferred-backlog.md:1006` **必须同步**（这是交付的一部分，不是可选项）。
2. §1 的 spec 指针加一句限定：「注意 §2.1 写的『走不通』是 **2026-07-22 的前提**，本任务 S1–S5 就是在拆那个前提——读它是为了理解**为什么当时不能做**，不是当作现在的裁断。」
3. **把「0d 剩余范围 = models 域是否被 S2 吸收」列为一个明确问题**（要么在 §4 S2 里给出答案，要么进 §5 待裁决）。两者对象相同、机制不同，不说清楚就会有人把两套都做一遍。
4. 在 §4 之后增加一条**收尾待办**：doc-sync 到 spec + DESIGN.md +（如需要）ADR。按 CLAUDE.md `session-closeout` 第 ② 步，这是「完成」的一部分。现在文档里完全没有 doc-sync 待办。

---

**[MAJOR] M-2　`HANDOVER.md:148`（S6 的边界守卫描述）—— 描述与现存守卫的实际形态不符，照写会打红 3 个既有 foundation 文件**

**证据**

S6 原文：「边界守卫（**复用 `tests/architecture/package-boundaries.unit.test.ts` 的 allowlist 检测器形态**，但本次 **allowlist 只有 `node:` 与相对路径**——『只依赖内置』要变成**机器强制**）」。

实地读 `tests/architecture/package-boundaries.unit.test.ts`：

- **foundation 检测器是 denylist，不是 allowlist**（`:56-58`）：`foundationHasForbiddenImport` = 拒 `@hsupu/ghc-proxy-{core,server,cli}` + 拒任何 `~/`。**它放行任意裸 npm 包。**
- 文件里唯一的 **allowlist 检测器是 telemetry 的**（`:73-78` 注释明确对比：「telemetry 包用 **allowlist** 而非 token/foundation 的 denylist」），其允许集是「相对路径 + foundation + `node:` + package.json 已声明的 external」。
- 而 foundation 现存文件**确实在用裸 npm 包**：`packages/foundation/src/repetition-detector.ts:16 import consola from "consola"`、`packages/foundation/src/process-identity.ts:18 import consola from "consola"`、`packages/foundation/src/diff/block-align.ts:25 import { diffArrays } from "diff"`。

所以「allowlist 只有 `node:` 与相对路径」这条判据**如果按包级施加，会立刻打红这 3 个既有文件**；而如果只按 state 两个文件施加，文档没说，且「foundation = 只依赖内置」这个包级承诺也就没有机器强制。

**接手方会做出什么错误动作**

- 照字面写一个包级 allowlist 检测器 → 3 个与本任务无关的既有文件变红 → 触发 CLAUDE.md 的 `dont-ignore-existing-errors`（不许把已有失败当「与我无关」），他会认真去「修」它们，可能**把 consola / diff 从 foundation 里拆出去**——一次没人批准、超出范围、且与用户裁定的「state 进 foundation」毫无关系的重构。
- 或者相反：发现打红后**把判据放宽成和现有 foundation denylist 一样**，于是 S6 的「『只依赖内置』变成机器强制」这个核心交付**静默降级**为「和现在一样」，而验收 oracle ①（「故意加一条 `~/lib/x` import 必须变红」）**照样会绿**——因为 denylist 本来就咬 `~/`。**这是一个变异实验也抓不到的假绿**：他选的正样本恰好在新旧判据的交集里。这直接命中 §6 第 3 条自己写的教训。

**修法**

1. S6 明确区分两个层次并各自给判据：**(a) foundation 包级**沿用现有 denylist（不动既有 3 个 npm 依赖）；**(b) `state.ts` / `state-defaults.ts` 文件级**加一条更严的 allowlist——只许 `node:` + 相对路径（**这才是「只依赖语言/系统内置」的机器强制**）。或者反过来：把包级 allowlist 的 external 集合按 `packages/foundation/package.json` 的已声明依赖来算（telemetry 检测器现成的做法，`:78 TELEMETRY_ALLOWED_EXTERNALS`），这样既有文件不红、又能拒未声明的新依赖。**两种都行，但必须选一个写死**，不能留给执行者猜。
2. 「复用 allowlist 检测器形态」的指针**精确到行**：指 telemetry 检测器（`package-boundaries.unit.test.ts:73` 起），而**不是** foundation 检测器——现在这句会让人以为 foundation 已经有 allowlist 了。
3. 变异实验的正样本**不能只用 `~/lib/x`**（新旧判据都咬，无鉴别力）。至少两个正样本：① `~/lib/x`（旧判据也咬）；② **一个裸 npm 包**（如 `import x from "lodash"`）——只有新判据咬。**只有 ② 变红才证明新判据真的比旧的严**。这正是 §6 第 3 条「换判据形状」教训的正确应用。

---

**[MAJOR] M-3　整个 `docs/plan/2026-07-28-state-to-foundation/` 目录在仓库里零引用 —— 不从 KICKOFF 进来的接手方永远发现不了它**

**证据**

`rg -rn '2026-07-28-state-to-foundation' .`（排除本目录、排除 node_modules）→ **零命中**。

即：`docs/DESIGN.md`、`docs/todo/deferred-backlog.md`、`docs/spec/2026-07-22-monorepo-workspace-split.md`、`docs/plan/monorepo-split/plan-{token,telemetry}-package.md`、任何 ADR、任何记忆索引，**没有一处指向本任务**。而 CLAUDE.md 规定 `docs/` 是单一事实源、`docs/DESIGN.md`「活的架构现状」表是当前活 / wip 路径的权威，user-rule `document-in-roadmap` 要求 spec/plan 在路线图里有明确位置。

对照前两次剥离：telemetry 的 plan 被 `DESIGN.md:188` 正文点名引用（「plan `monorepo-split/plan-telemetry-package.md`」），token 同理。**本次是三次剥离里唯一没进路线图的。**

**接手方会做出什么错误动作**

- **场景一（最常见）**：新会话不是拿着 KICKOFF 启动的，而是接到「继续 monorepo 拆分 / 解 state 的环」这类任务。他按 CLAUDE.md 的指引读 DESIGN.md → spec §7.2 → `deferred-backlog.md:1006`「state 第一」，一路读到的都是 **reader seam 方案**，**永远走不到本目录**。于是从零开始重做调研，得出一套不同的方案——原作者这一轮的全部工作（含那次已还原的 PoC 和 §6 的五条教训）白费。
- **场景二**：`git log` 里看到 `cc2fb141` 提交了两份文档，但不知道它们是 live 的还是历史的（`docs/plan/` 下有大量已完成的 plan），可能当成陈旧文档略过。
- **场景三（并发 peer）**：另一个会话同期动 `state.ts` / `models/`，因为没有任何 live 文档标记「state 正在被改造」，撞车无预警。这在本仓库是高频事件——HANDOVER 自己的 §6 第 4 条就是被 peer 改动打过一次。

**修法**

1. `docs/DESIGN.md`「活的架构现状」表加一行（或在既有 monorepo 行内补一句），状态标 **`[wip]`**，指向本目录。这是四档状态注解的用途所在。
2. `docs/todo/deferred-backlog.md:1006` 的排序清单里，「state 第一」后面补一句「**→ 正在进行，见 `docs/plan/2026-07-28-state-to-foundation/HANDOVER.md`**」。这是最可能被下一个接手方读到的位置。
3. `docs/spec/2026-07-22-monorepo-workspace-split.md` §7.2 的 0d / 阶段 4+ 处加指针（与 M-1 的对账一并做）。
4. 建议同时在项目记忆库加一条 stub（对照 MEMORY.md 里 `project-*` 那批「现状 stub」的既有做法，如 `methodology-domain-peel-execution-techniques` 那条），钩子写「state→foundation 第三次剥离（文档定稿、代码未动工）」。

---

**[MAJOR] M-4　`HANDOVER.md:127-131`（S3）—— 目标模块不确定，且真实消费者主体在 `src/routes/**`，接手方极可能造出 spec 正在消除的 core→server 脏边**

**证据**

S3 只说「迁往它们的**消费域**（buffered-retry / max-tokens continuation **相关模块**）」——目标模块名没给。实地查：

**(1) 名叫「相关模块」的候选并不存在于一个确定位置。** `rg --files | rg -i 'buffer|continuation|max-token'` 在 `src/lib/` 下得到 5 个分散在三个不同目录的文件：`codec/openai-responses/buffered-merge-reducer.ts`、`pipeline/max-tokens-truncation-class.ts`、`pipeline/max-tokens-terminal-observer.ts`、`pipeline/continuation-request-builder.ts`、`anthropic/continuation-builder.ts`；`src/routes/` 下另有 2 个 `buffered-config.ts`。**没有一个是「buffered-retry 模块」。** 接手方必须自己做一遍选址调研——而这正是原作者已经做过、却没写下来的部分。

**(2) 真实消费者分布（`rg -ln` 实测）：**

| 符号 | src 侧消费者 |
|---|---|
| `resolveBufferedCaps` | `src/routes/responses/{buffered-config,ws,handler-v4}.ts`、`src/routes/chat-completions/{buffered-config,handler-v4}.ts`、`src/routes/messages/handler-v4.ts`、**`src/lib/config/config.ts:24,858`** |
| `resolveContinuation` | `src/routes/messages/handler-v4.ts:174,1323-1324` |
| `resolveMaxTokensContinuation` | **src 侧仅 `state.ts` 自身**（域外只有 `tests/config/max-tokens-continuation-config.unit.test.ts`） |
| `resolveEffectiveMaxTokensContinuation` | **同上** |

三点要害：

- **消费者主体在 `src/routes/**`**，即未来的 **server 包**。而 `src/lib/config/config.ts`（core）也消费 `resolveBufferedCaps` —— **所以这四个函数不能落在 routes 侧**，否则就造出一条 `core → server` 的边。spec §7.2 阶段 1 正在**专门消除**仅存的 2 条这类脏边，其 invariant 是「`rg 'from "~/routes"' src/lib` 归零」。
- **`resolveMaxTokensContinuation` / `resolveEffectiveMaxTokensContinuation` 在 src 侧没有任何域外消费者**——只有测试用。「迁往它们的消费域」这个指令对它们**没有可执行的语义**（消费域是空的）。
- §3.5 ③-b 的「域外消费者：8 个文件」里，`src/lib/config/schema.ts` 是**注释命中**（`:213`、`:789`、`:1387` 三处都是 doc comment，无 import）。接手方会打开它找 import 却找不到。

**接手方会做出什么错误动作**

- **最可能**：看到 6 个消费者里 5 个在 `src/routes/`，把 `resolveBufferedCaps` 放进 `src/routes/responses/buffered-config.ts` 或新建一个 routes 侧模块 → `src/lib/config/config.ts` 反过来 import routes → **新造一条 core→server 脏边**，与 spec 阶段 1 的方向相反。typecheck 绿、测试绿、SCC ratchet 未必咬（跨 core/server 的边不一定成环），**没有任何 oracle 会拦住他**——S3 的两条 oracle 是「state.ts 行数下降」和「既有测试全绿」，两条都会通过。
- 或者对两个 max-tokens 函数**无从下手**（消费域为空），只好自己拍一个位置，与原作者心中的答案不同；后续 max-tokens continuation P1（记忆里标记为待做）接手时再撞一次。
- 或者花 20–40 分钟重做一遍原作者已经做过的选址调研——纯浪费，且结论可能不同。

**修法**

1. **把目标模块写死到文件路径**（四个函数各自一行，允许是「新建 `src/lib/config/resolve-overrides.ts`」这类新文件）。选址必须满足一条硬约束，建议直接写进文档：**目标必须在 `src/lib/` 内（core），不得在 `src/routes/` 内**——因为 `src/lib/config/config.ts` 是消费者，落在 routes 会造 core→server 脏边（spec §7.2 阶段 1 正在消除这类边）。
2. 给 S3 补一条验收 oracle：**`rg 'from "~/routes"' src/lib` 仍归零**（直接复用 spec §7.2 阶段 1 的 invariant）。这是唯一能咬住上述错误动作的判据。
3. 两个 max-tokens 函数**单独说明**：src 侧无域外消费者，去向由「未来 max-tokens continuation P1 会在哪里用它们」决定，而不是由现有消费者决定——或者干脆标为「与 P1 一并处理，本次只从 state 移出到 core 内某处」。**别让「迁往消费域」这句话去覆盖一个消费域为空的情况。**
4. §3.5 ③-b 的「8 个文件」标注哪些是注释命中；并在 S3 的动作栏加一句：`src/lib/config/schema.ts:213,789,1387` 与 `config.ts:309,845` 有 5 处注释写着「见 `resolveBufferedCaps` **in state.ts**」，**搬迁后必须同步改**。这不是可选的整洁工作——`docs/todo/deferred-backlog.md:282-287` 就躺着一条完全同型的欠账（「陈旧交叉引用 `state.ts:384` 指向已迁移的 `budgetToEffort`」），说明这个坑在本项目**已经复发过**；而 §6 第 5 条又恰好是「注释写错会让照着注释写的代码看起来是对的」。

---

### MINOR

---

**[MINOR] m-1　`HANDOVER.md:137`（S4 验收 oracle ①）—— oracle 只 grep `token/store`，对 `token/types` 天然盲，会给出假绿**

- **证据**：S4 的 oracle ① 是 `rg -n 'token/store' src/lib/state.ts` 归零。但 `state.ts` 有**两条**指向 token 包的 import：`:21-30` 的 `~/lib/token/store`（值 + `TokenStoreSnapshot`）与 `:15-19` 的 `~/lib/token/types`（`CopilotTokenInfo` / `TokenInfo`，用于 `:1993-1994` `setStateForTests` 的宽签名）。S4 的动作栏只说「删掉对 `~/lib/token/store` 的 import」。
- **接手方会做的错误动作**：完成 S4、oracle 全绿、认为「state 与 token 包已解耦」，带着这个错误结论推进到 S5、S6。这是 B-1 那条 blocker 得以潜伏到第 6 步的**直接机制**。
- **修法**：oracle ① 改成 `rg -n '~/lib/token' src/lib/state.ts` 归零（覆盖整个包，而非某个子模块）。**这是「换判据形状」的一个小型正例**——把 blocklist 式的精确子路径换成覆盖整个来源的形状，正是 §6 第 3 条自己总结的手法。

---

**[MINOR] m-2　`HANDOVER.md:102`（§3.6 类型清单）—— 枚举与实际 import 对不上：漏 `SeparatorCarrier`，`TokenStoreSnapshot` 归错来源，`CopilotTokenInfo`/`TokenInfo` 完全缺席**

- **证据**：§3.6 称「7 个 `import type` 全是配置词汇」并列出 8 个名字。实际（已核）：① `SeparatorCarrier`（`state.ts:4`）**不在列**；② `TokenStoreSnapshot` 被标为「来自 token 包」，但它实际来自**值 import 块** `:21-30` 的 `~/lib/token/store`，不是 7 条 `import type` 之一；③ 真正来自 `~/lib/token/types` 的 `CopilotTokenInfo` / `TokenInfo`（`:15-19`）**根本没出现**。语句总数 7 是对的，名字集合不对。
- **接手方会做的错误动作**：S5 按这份清单办事，搬完 5 个类型后以为「`import type` 只剩 §5 分叉决定保留的」（S5 的 oracle 原话），实际还剩 3 个名字、2 条语句。→ 直通 B-1。
- **修法**：§3.6 的表改为**从机器输出生成**（贴 `rg` 原始结果），一行一条 import 语句、列出该语句里的**每个**具名符号及其去向。人工回忆的清单在这类任务里必漏。

---

**[MINOR] m-3　`HANDOVER.md:62`（§3.3 表末行）—— 行号已漂移，且全文缺少「符号级重定位配方」**

- **证据**：§3.3 称 `./state-defaults` 在 `state.ts:2025`，实测当前 HEAD 是 `:2035`（10 行漂移）。文档头部已诚实声明数字有时效（「再往后接手请重跑 §3.1」），§3.5 也标了「行号 @HEAD `23e85aba`」——**但重跑指引只覆盖 SCC 数字，不覆盖行号**。
- **接手方会做的错误动作**：跳到 `:2025` 发现不是预期内容 → 开始怀疑自己是不是读错文件 / 是不是 peer 大改过 → 保守起见停下来重新审计（浪费），或者更糟：认为整份文档已陈旧而不再信任其它事实（§6 第 4 条自己写过「交接一旦陈旧，危害大于没有」——行号是最先陈旧的那一类事实）。
- **修法**：§3.5 / §3.3 的表加一列或一句脚注给**符号级定位配方**（如 `rg -n 'export function setModels' src/lib/state.ts`），并声明「行号仅供参考，以符号名为准」。本仓库并发提交频率高，行号必然漂移，这不是可以靠「重跑一次」解决的，得靠判据形状。

---

**[MINOR] m-4　`KICKOFF.md:18-24` —— 逐字复述 HANDOVER §2 的 6 条范围，违反模板明令，制造漂移风险**

- **证据**：模板 `.claude/skills/session-closeout/handover.md:5` 明确：「**KICKOFF 里凡是能指向 HANDOVER 小节号的，就不要复述**」；`:81` 又强调待办部分「**只标批准状态与建议顺序，不复述内容**」。当前 KICKOFF 把 §2 的 6 条范围（含用户原话引用）整段搬了过去，「这轮反复踩的坑」5 条也是 §6 的压缩复述而非指针。
- **接手方会做的错误动作**：两份出现分歧时不知道信哪份。**这不是假想风险**——`31e39d6f` 那次订正就必须同时改两处（`KICKOFF.md:7` 与 `HANDOVER.md:183`），只要漏一处就会留下一份自相矛盾的交接。范围条目一旦在 HANDOVER 里被用户追加裁定而 KICKOFF 没跟，接手方会照着过期范围施工。
- **修法**：KICKOFF 的范围段压成两行：「用户已批准的范围见 **HANDOVER §2**（6 条，含 2 条明确的『不做』）；**别重开这个议题**。」坑清单同理压成一行一指针（「详见 HANDOVER §6 第 N 条」）。KICKOFF 只保留**不先知道就会立刻做错**的东西：worktree / pathspec / 测试命令 / 4141 禁区 / 先读 HANDOVER。
- **例外（建议保留复述）**：§5 那条待裁决分叉在 KICKOFF 里值得保留一句「需用户先定、别自己拍」——因为它是**动手前的 gate**，指针形式容易被跳过。

---

**[MINOR] m-5　`HANDOVER.md` 缺模板 §1「背景与本轮做了什么」，`§7` 产物清单虽好但未覆盖「本轮真正的产出是什么」**

- **证据**：模板骨架 `handover.md:23-25` 要求「## 1. 背景与本轮做了什么 —— 已落地的改动，逐条给 `<sha>` 或 `file:line`」。当前 HANDOVER 从 §1 入口指引直接跳到 §2 范围。头部「前身」一行给了两次前序剥离，但**本轮做了什么**（= 一次已还原的削环 PoC + 一轮范围收窄讨论 + 一次因 peer 改动而重测）散落在 §3.2 / §6 第 4 条 / §7。
- **接手方会做的错误动作**：低估「已经付出的调研」的价值密度，跳读 §6（那是**结论之外最有价值的部分**），或者不理解为什么 §3.2 会说「peer 已经走了一半」。
- **修法**：补一节 6–8 行的「本轮做了什么」：范围讨论 → PoC → peer 改动导致重测 → 定稿两份文档（`cc2fb141` / `773773b2` / `31e39d6f`）。**代码零改动这件事本身也要写在这里**，而不只在头部状态行。

---

### NIT

---

**[NIT] n-1　`KICKOFF.md:1-3` 缺模板要求的「可整段复制」封装**

模板 `handover.md:67-73` 的 KICKOFF 骨架以「复制下面整段作为新会话的第一条消息」+ `---` 分隔线开头，正文以第二人称写给新会话（「接手 <项目> 上一轮未完的工作」）。当前 KICKOFF 是一份**说明文档**（有 `## 任务` / `## 优先级` 等小节标题，且混用第一人称「我推算 70→21」）。**接手方的错误动作**：不确定该整段粘贴还是自己摘要；粘贴后新会话读到「我」会有指代困惑（「我」是谁？）。**修法**：加分隔线与「复制下面整段」抬头，把第一人称叙述改为指针（「详见 HANDOVER §6 第 1 条」，顺带解决 m-4）。

---

**[NIT] n-2　`HANDOVER.md` 的章节编号与模板骨架不一致（§1–§8 vs 模板 §0–§6）**

模板是 §0 入口指引 / §1 背景 / §2 硬事实 / §3 待办 / §4 我犯过的错 / §5 产物 / §6 环境禁区；本文是 §1–§8。**内部自洽、KICKOFF 的交叉引用（§4 的 S1→S6、§5 待裁决）也都对得上**（已逐条核对），所以不影响使用。仅提示：若未来有跨交接的工具或索引按模板槽位取内容，编号偏移会失配。不建议为此重排——**但 m-5 指出的 §1「背景」缺位是真实槽位空缺，补上后编号会自然接近模板**。

---

## 专项：§6「我犯过的错」的可迁移性评估（按要求逐条判断）

模板 `handover.md:48` 的判据是：「只列结论的交接会让接手会话**重犯产出这些结论的错误**」。据此逐条判「接手方在**这个具体任务里**真会重犯吗」：

| # | 内容 | 真会重犯？ | 判断依据 | 建议 |
|---|---|---|---|---|
| 1 | 拿基线环列表推算削环量（高估 8 条） | **真会，且高频** | S1 / S5 / S6 三步都要量环，而 `circular-deps-baseline.json` 就躺在仓库里、比跑 `computeCircularSnapshot()` 省事得多。诱因结构性存在 | **保留，且已做对了**——§4 开头的通用不变量里又钉了一次（`HANDOVER.md:111`），KICKOFF 也复述。这是全文最好的一条 |
| 2 | 过度设计：提议单独建 `config-vocabulary` 模块 | **不会重犯** | 该结论已被 §2 的 ❌ 条目**硬编码为范围禁令**（`:30`），接手方不可能再提；且 KICKOFF 也复述了。**这是纯自我检讨** | **压缩到一行**，或直接并入 §2 那条 ❌ 的括号说明（「理由：叶子无出边，state 自己就是词汇的家」——这句才是有价值的部分，且它已经在 KICKOFF `:24` 里了） |
| 3 | 守卫「绿」不自证（六轮评审的核心教训） | **真会，是 S6 的头号风险** | 见 M-2：现有 foundation denylist 本就咬 `~/`，接手方最可能选的正样本恰在新旧判据交集里，**变异实验会假绿** | **保留，但必须绑到具体步骤**：现在写的是「本次 S6 的边界守卫务必带变异实验」，还不够——要写「**S6 的变异实验至少要有一个『旧判据不咬、新判据才咬』的正样本**（如裸 npm import），否则实验本身没有鉴别力」。见 M-2 修法 3 |
| 4 | 写交接前没先看 `git log`，差点用陈旧事实 | **真会** | 本仓库并发提交频率极高；接手方动工时距核验基线可能又过了几十个提交 | **保留**，已在头部核验基线 + §3.1 重跑指引里兑现。**但覆盖不全**：重跑指引只覆盖 SCC 数字，不覆盖行号与消费者计数（见 m-3）。建议把「动工第一件事」明确成一条清单：重跑 §3.1 环数 + 重跑出边枚举（B-1 修法 1）+ 重数消费者 |
| 5 | 注释写错会让照着注释写的代码看起来是对的 | **真会，但文档没说会在哪里重犯** | 这不是空泛检讨——**S3 会实地撞上**：`config/schema.ts:213,789,1387` 与 `config.ts:309,845` 有 5 处注释写着「见 `resolveBufferedCaps` **in state.ts**」，S3 搬完就全是错的；**S6 的守卫注释**同理（M-2 场景里，一句「本守卫强制只依赖内置」的注释配上一个实际只咬 `~/` 的 denylist，就是原文那个坑的完整复刻） | **保留并具体化**：加一句「**本任务的两个复发点：S3 后 `config/{schema,config}.ts` 的 5 处 `in state.ts` 注释、S6 守卫自身的判据注释**」。另可指向 `docs/todo/deferred-backlog.md:282-287` 那条同型欠账作为「本项目已复发过一次」的证据 |

**小结**：5 条里 **3 条（#1 #3 #4）是高价值且真会重犯**的，#5 有真实落点但**没写出落点**，#2 是纯自我检讨、可压缩。整体质量在我见过的交接里属上乘——问题不在这一节，而在它没有和 §4 的具体步骤挂钩。**建议统一改造：每条错误后面加一行「本任务的复发点：S<n> 的 <具体动作>」**，把「教训」变成「步骤内的检查项」。

---

## 已核实无问题的项（避免下一轮重复核查）

- **§1 入口指引 5 条链接全部有效**，`spec §7.2` 章节真实存在（「阶段序列」）。**无断链**。这一条我按 BLOCKER 级标准查过，结论是干净的。
- **KICKOFF `:7` 与 HANDOVER `:183` 关于 worktree / eslint 的说法已由 peer（`31e39d6f`）订正，且两处一致、无残留**。原「必须先 `bun install`，否则 eslint exit 127」已被实测证伪并替换为「`.worktrees/` 在仓库内部、向上解析主树 `node_modules`，无 `node_modules` 的新树里 eslint 照样 exit 0」。**HANDOVER §8 无残留旧说法**（已 grep 全文 `bun install` / `127` 确认）。**此条不构成发现。**
- **KICKOFF 对 HANDOVER 的小节号交叉引用全部正确**（`§4 的 S1→S6`、`§5` 待裁决），未因 `773773b2` 的 §7 插入而失配。
- **S1 的全部执行信息已核实可用**：`refusal-policy.ts` 存在、41 行、零 import（仅 `:15` 导出 `DEFAULT_REFUSAL_ERROR_TYPE`）；两个待搬常量在 `recover-refusal.ts:100` / `:109`；`:114` 已有 `export { DEFAULT_REFUSAL_ERROR_TYPE }` 作为 re-export 形态的现成先例；`state-defaults.ts:21-25` 是待改的 import 块。
- **§3.4「state.ts 无 I/O」的结论方向可信**：全文 import 里无 `node:` / npm 值依赖（`:1-32` 已逐条列出，见 B-1 证据块），与该结论一致。
- §3.5 ③-a「域外消费者 4 个文件」的 **src 侧口径本身是准确的**（`models/client.ts` / `config/config.ts` / `routes/models/internal.ts` / `packages/cli/src/start.ts`）——问题在于把它当成了编辑面（B-2），不是数错了。

---

## 总判（详细版）

### 能否让全新会话在不问原作者的情况下把 S1 做完？

**能。** S1 的信息完备度是六步里最高的：目标模块、待搬符号、re-export 陷阱、验收 oracle（30 环 / 43 成员）、证伪方式（「别调整期望值去迁就」）、风险评估全齐，且我逐项实地核实过位置都对得上。环境噪声（peer 的 typecheck 报错、`test:backend` 跑不起来、pathspec 纪律）也在 §8 / KICKOFF 交代清楚了。接手方能独立完成并 land。

**建议在 S1 顺带解决 `state-defaults.ts:26` 的 `DEFAULT_SEPARATOR_CARRIER`**（B-1 修法 4）——它与两个 refusal 常量性质完全相同，同一步做掉最省，且能让「S1 之后 state-defaults 只剩类型依赖」成为一个真实可验证的里程碑。

### 但交接整体不合格，断点在 S2、致命伤在 S6

- **S2**：编辑面低报一个数量级，且有一条**能一路走绿到提交、却抵消本步全部价值**的错误路径（re-export），现有 oracle 拦不住（B-2）。
- **S6**：在 S1–S5 全部正确完成后**仍然会失败**，因为至少 4 条跨界依赖从未被登记，其中 `~/lib/token/types` 牵动包分层反转、需要用户裁决（B-1）。这是最严重的一条：**接手方要付出 5 个提交的代价才能发现交接是不完整的。**
- 两个 BLOCKER 有**同一个根因**：§3 审计的问题是「state 为什么在 SCC 里」（这个审计做得很扎实），而 S6 需要的是「state 还剩哪些 `~/` 出边」。前者是削环视角、后者是叶子化视角，**两者的答案不同**——SCC 只关心成环的边，叶子化关心**所有**出边。文档把前者的结论直接用作了后者的前提。补救办法很机械：**加一条机器枚举的完整出边清单，逐条对到步骤上**（B-1 修法 1）。这一条清单同时消解 B-1、m-1、m-2。

### 缺的是哪一块（一句话）

**缺一份「foundation 准入清单」——即 `state.ts` / `state-defaults.ts` 的完整出边逐条对账表，以及每条边由哪一步消除、消除不了的进 §5 待裁决。** 有了它，B-1 / m-1 / m-2 一并消失，S6 从「注定会红」变成「有明确入口判据」。

### 建议的修订顺序

1. **加 §3.7 完整出边清单**（机器枚举）→ 解 B-1 / m-1 / m-2，并把 `~/lib/token/types` 提进 §5 待裁决。
2. **改写 S2**：如实编辑面 + 禁止 re-export + 补环数 oracle → 解 B-2。
3. **加「与 spec 的关系」小节 + doc-sync 待办**，并在 DESIGN / backlog / spec 三处登记本目录 → 解 M-1 / M-3。
4. **改写 S6 守卫描述**（包级 denylist vs 文件级 allowlist 二选一写死；变异实验要有鉴别力样本）→ 解 M-2。
5. **S3 目标模块写死到文件路径 + 加 `rg 'from "~/routes"' src/lib` 归零 oracle** → 解 M-4。
6. **KICKOFF 去复述化**（m-4 / n-1），**§6 每条错误绑定复发步骤**（专项小结）。

第 1、2 条不做，这份交接不能交给新会话执行；第 3–5 条不做，执行过程中会做出方向性错误动作；第 6 条是打磨。

---

*评审者：Claude reviewer（接手方视角）。本报告只读评审，未修改仓库任何其它文件。所有 `file:line` 均于 2026-07-28 在工作区当前状态实地核对；行号可能随并发 peer 提交漂移，请以符号名为准。*

---
---

# 第二轮复审（整改后，提交 `88df93a8`）

> **复审对象**：整改后的 HANDOVER.md（342 行，新增 §1.5 / §2.5 / §3.7 / S7，S1–S6 全部重写）+ KICKOFF.md（整份重写，53 行）+ 三处外部登记。
> **方法同第一轮**：第一人称走查 S1→S7，对每条新增的事实性主张实地复核。
> **调用方指定不重复**：数值算术（另一 reviewer 已实测）、§1 链接有效性（第一轮已核）。
> **本轮结论先行**：**11 条第一轮发现全部解决（11/11），无一条打折。** 新发现 1 个 MAJOR + 3 个 MINOR + 1 个 NIT。**断点已从 S2 后移到 S6，且性质从「无预案的十字路口」降为「一步内可自解的意外红」。**

---

## 一、先认领一条对我的方法论纠正（成立）

整改方指出：我在第一轮 B-1 的证据块里用 `rg '^\s*(import|export).*from'` 枚举出边，**这个形态会静默漏掉本仓库的多行 import**（排版把 `from` 放在收尾行）。

**这条纠正完全成立，我认领。** 我复盘了自己的操作：`state.ts` 那份我确实是靠 `sed -n '1,40p'` 人工通读补齐的，结论碰巧完整；但 `state-defaults.ts` 我只读到 `:30`，**因此漏掉了 `:41 } from "./state"`**（第一轮报告里我列 5 条，实际 6 条）。这正是我自己在报告里反复要求别人做的事——**判据形状要用「目标一定会出现的锚点」而非「你以为的语法形态」**——而我在同一份报告里用错了形状。§3.7 写死 `from "` 作锚点是对的，§6 第 7 条把它记成教训也是对的。

值得单独说一句：**这条纠正的产生方式本身是正确的做法**——整改方没有照单全收 reviewer 的证据块，而是自己重跑了枚举，于是同时抓到了两个 reviewer 都漏的 `./adaptive-rate-limiter`。我已独立复核：`src/lib/adaptive-rate-limiter.ts` 的出边确为 `consola`（`:1`）、`~/lib/error` 的 `HTTPError`（`:3`）、`./observability`（`:9`），**远不是叶子，且 S6 之后相对路径会跨包**。这条发现成立且重要。

---

## 二、第一轮发现的落实判定（11/11 全部解决）

| 编号 | 原发现 | 判定 | 复核依据 |
|---|---|---|---|
| **B-1** | S1–S5 后仍有 4 条未登记出边，S6 必红 | **已解决** | 新增 §3.7「foundation 准入清单」16 条机器枚举表。**我用 `rg -n 'from "' src/lib/state.ts src/lib/state-defaults.ts` 独立重跑，逐条比对：表与实际出边完全吻合**，含我漏掉的 `#16 ./state` 与两个 reviewer 都漏的 `#9 ./adaptive-rate-limiter`。16 条**每条都对得上一个步骤或一个待裁决分叉**，无悬空项。`~/lib/token/types` 已升为 §5 待裁决 3（三条候选 + 倾向 (b)，与我的建议一致）。`DEFAULT_SEPARATOR_CARRIER` 并入 S1 且**明确写了「不要整个搬 `block-layout-contract.ts`」**（我的修法 4 原样落地）。§3.6 降级为「已被 §3.7 取代」并补上了模板要求的「推断升实测还差什么」槽位 |
| **B-2** | S2 编辑面低报，re-export 逃生口无说明 | **已解决，且超出我的建议** | 编辑面改为 105 文件（4 prod + 101 tests）并给了口径表；「批量改测试是**已批准**的」明确写出；**re-export 从「纪律禁令」升级为「拓扑上不可用」**——这比我建议的写法更强，因为它给的是**不可辩驳的理由**而非一条可以被绕过的规矩；补了 `computeCircularSnapshot()` 环数不回升的 oracle（专咬该逃生口）；两个特殊消费者点名。**额外**：oracle ② 改用 AST 检测器而非 `rg`，并要求正样本自证——这是我没提的加强 |
| **M-1** | 与 spec 正面冲突未对账 | **已解决** | 新增 §2.5，讲清「spec 判走不通的**依据**正是 S1–S5 要拆的东西，前提没了结论随之改变」。**并且自己找到了一条我漏掉的佐证**：spec §11「error 整体上提 foundation：否决」的理由（「会把 state 拖进 foundation → foundation 不再是叶子」）同样只在 state 还不是叶子时成立——我已核实 `spec:194` 原文如此。§1 的 spec 指针加了 ⚠️ 限定语。0d 与 S2 的关系升为 §5 待裁决 4 |
| **M-2** | S6 守卫描述与实际不符 | **已解决** | 守卫拆两层：(a) 包级沿用现有 denylist **且明确「不要动它」**并写明理由（3 个既有文件用裸 npm 包）；(b) 文件级新加 allowlist。指针改指 telemetry 检测器。变异实验要求「至少两个正样本、其中一个是裸 npm 包，只有 ② 变红才证明新判据更严」——**我的修法 3 原样落地** |
| **M-3** | plan 目录全仓零引用 | **已解决，三处登记我逐一核实过命中位置** | ① `docs/DESIGN.md` 加 `[wip]` 段，含 supersede 声明 + **「要动 `state.ts` / `models/` 的并发会话请先读它」**（这句是我没想到的加强，直接服务于并发撞车预警）；② `docs/todo/deferred-backlog.md`「state 第一」条加状态 + 「别按本行下方或 spec §5 的旧方案起步」；③ spec `:45`（§2.1）与 `:135`（§7.2-0d）两处 supersede 注记，均含权威入口链接。**三处都在接手方真会经过的路径上**——DESIGN 是新会话第一站、backlog 是「下一步拆哪个」的必经处、spec §2.1 是最容易让人误判任务被否决的那一段 |
| **M-4** | S3 目标模块不确定，可能造 core→server 脏边 | **已解决** | 目标写死 `src/lib/config/model-overrides.ts`（**已核实该文件尚不存在**，是新建）；硬约束「必须在 `src/lib/` 内」+ 完整理由；补 `rg 'from "~/routes"' src/lib` 归零 oracle；5 处陈旧注释点名；两个 max-tokens 函数「消费域为空」单独说明。**额外**：把「`state.ts` 行数下降」显式列为**不作数的 oracle**——我只说它拦不住错误，整改方直接把它废了，更彻底 |
| **m-1** | S4 oracle 只 grep `token/store` 会假绿 | **已解决** | 改为 `rg -n '~/lib/token'` 归零，并在原地写明「我第一版写的是个假绿 oracle」+ 为什么（两条边）+ 这是「换判据形状」的小型正例。同时回填到 §6 第 3 条作为第二个复发点 |
| **m-2** | §3.6 类型清单三处错漏 | **已解决** | §3.6 整节降级并标注「别用这一节做 S5 的驱动清单」，S5 的驱动清单改为 §3.7。**根治方式比我建议的更好**：我建议「改为从机器输出生成」，整改方直接**废掉人工清单的驱动地位**并保留它只解释机制——因为人工清单「改过两版都还是漏的」 |
| **m-3** | 行号漂移，缺符号级定位配方 | **已解决** | §3.3 顶部加「**行号会漂移，一律以符号名为准**」并拿 `:2025→:2035` 当现成实例；§6 第 4 条给了 `rg -n 'export function setModels'` 形态的配方；KICKOFF 复述一次 |
| **m-4 / n-1** | KICKOFF 复述导致漂移 / 缺可复制封装 | **已解决** | 整份重写：加「复制下面整段」抬头 + `---` 分隔线 + 开宗明义写「两份文档重复同一件事，只会在其中一份被改时留下自相矛盾的交接」；6 条范围压成一行指针（`见 HANDOVER §2`）；坑清单每条一行 + `→ §6 第 N 条`；第一人称叙述保留极少且都带指针。**我建议保留的 §5 gate 例外也保留了**，且写得比我建议的更具体（点名第 3 条挡 S6、第 4 条决定 S2 要不要做） |
| **m-5** | 缺模板 §1「本轮做了什么」 | **已解决** | 新增 §1.5，5 条含 PoC/范围收窄/peer 重测/两轮评审，末尾「**代码一行没动**」+ 四个文档提交 sha |
| **n-2** | 章节编号与模板不一致 | **不适用**（我当时就写了「不建议为此重排」） | §1.5 的补入让编号更接近模板，符合预期 |

**没有一条是「部分解决」或「表面应付」。** 几处整改方案**强于我给的修法**（B-2 的拓扑论证、m-2 的废除驱动地位、M-4 废掉伪 oracle、M-3 的并发预警句），已在上表逐条注明。

---

## 三、本轮新发现

### [MAJOR] NEW-1　`HANDOVER.md:274`（S6 oracle ②）与 `KICKOFF.md:52`（禁区第 5 条）—— `state ↔ state-defaults` 是一个**已存在的 2 节点环**，S6 的新 oracle 必然报红，而禁区第 5 条会对这个红给出**错误的处置指引**

**证据（实地）**

S6 新增的 oracle ② 是本轮最好的补强之一（发现 `computeCircularSnapshot()` 的 madge 根是 `path.join(REPO_ROOT, "src")`、不扫 `packages/`，所以 S6 之后它会天然失明）。我已复核 `tests/architecture/circular-deps-snapshot.ts:54` 确实如此，**这条 catch 完全成立**。

但补上「扩扫描根 / `madge packages/foundation/src --circular`」之后，会立刻撞上一个**已经存在、且 S1–S5 全都不会消除**的环：

```
src/lib/state.ts:2030,2035   } from "./state-defaults"        （value）   ← §3.7 #10
src/lib/state-defaults.ts:28-41  import type {…13 个类型…} from "./state"  ← §3.7 #16
```

两条边互指。madge **确实计 type 边**（§3.6 那句话我本轮验证为真），证据是它已经躺在快照基线里：

```
tests/architecture/circular-deps-baseline.json:71
    "lib/state-defaults.ts > lib/state.ts"      ← 全库最短的 2 节点环之一
```

§3.7 把这两条边都标成「**同一单元，一起走**」——搬迁语义上正确，**但它们一起走进 foundation 之后，这个 2 节点环也原样跟着进去了**。于是 S6 的 oracle ② 第一次跑就会报出 `state-defaults.ts > state.ts`。

**接手方会做出什么错误动作**

S6 的行文把 oracle ② 的预期结果强烈暗示为「无环」（「『state 不在 `members` 里』是**路径消失**的必然结果，不是**无环的证明**」），而 `KICKOFF.md:52` 的禁区第 5 条写着：

> **别为了让 S6 的守卫变绿而把守卫改弱。守卫红说明 S1–S5 还没做完，不说明守卫太严。**

**这句话在这一条红上恰好是错的**——这个环与 S1–S5 一条边都没关系，它是 state 与 state-defaults 之间的结构性互引，第一版拆分这两个文件时就存在。接手方拿着这条禁令面对这个红，三条路都不好：

- **(a) 回头去找不存在的漏网边**：他会重跑 §3.7 枚举、发现差集为空、然后怀疑枚举命令又漏了什么（毕竟 §6 第 7 条刚教育过他「枚举形态会静默漏」），陷入自我怀疑的循环。**这是最可能发生的**，因为文档刚刚花了大力气建立「差集非空=交接陈旧」的判据，而这里差集为空却仍然红。
- **(b) 把这条环豁免掉**——这是**实质正解**（同单元互引，且不违反「只依赖语言/系统内置」：两条都是相对路径，文件级 allowlist (b) 照样放行），但禁区第 5 条明令这叫「把守卫改弱」，他会认为自己在作弊。
- **(c) 真去拆这个环**（把两文件共享的 13 个类型抽到第三个文件）——**这也是一条正当路线**，但它是一次没人批准、没在任何步骤里出现过的额外重构，且 §2 刚说过「别扩范围」。

三条路的共同点：**接手方必须在没有任何预案的情况下自己做一个方向性决定**，而文档给他的唯一指引是错的。

**修法（很轻，一段话）**

在 S6 的 oracle ② 处直接写明这条已知环，并给出裁断：

> ⚠️ **oracle ② 第一次跑必然报出 `state-defaults.ts > state.ts` 这一条环**（现基线 `circular-deps-baseline.json:71`，全库最短的 2 环之一）。**这是预期内的，不是 S1–S5 没做完**——它是两个文件之间的结构性互引（state 取默认值、state-defaults 取类型），第一版拆分时就存在，且**不违反 foundation 准入**（两条都是相对路径，文件级 allowlist 放行）。两个正当选项：**(a) 显式豁免这一对并在守卫里写明理由**（推荐，成本最低、语义诚实：它们本就是「同一单元」）；**(b) 顺手拆掉**——把两文件共享的 13 个类型抽到第三个零依赖文件。**别按 KICKOFF 禁区第 5 条去回头找漏网边，那条禁令不适用于这一条。**

同时把 `KICKOFF.md:52` 改成：「别为了让 S6 的守卫变绿而把守卫改弱——**唯一的例外是 `state ↔ state-defaults` 那条已知的同单元 2 环（见 HANDOVER S6 oracle ②），它不算漏网边**。除此之外，守卫红说明 S1–S5 还没做完。」

**顺带**：这条也说明 §3.7 那张表可以再加一列**「S6 之后是否仍然存在」**——#10 与 #16 的答案是「存在，且构成环，已知并接受」，而不是含糊的「同一单元，一起走」。有了这一列，NEW-1 在写表的时候就会自己暴露。

---

### [MINOR] NEW-2　`HANDOVER.md:277-284`（S7）—— 清单里有 4 处**已经在本轮预先注记完毕**，S7 未区分「待改时态」与「尚未触碰」

- **证据**：S7 要改的清单是 spec §2.1 / §3.1 / §5 / §7.2-0d + backlog「state 第一」+ DESIGN。我实地核实：**§2.1（`spec:45`）、§7.2-0d（`spec:135`）、backlog、DESIGN 四处已在 `88df93a8` 加好注记**，且注记用的是**进行时**（「正在被降为」「尚待裁决」「文档已定稿、代码未动工」）。真正尚未触碰的只有 **spec §3.1**（core 一行仍含「散装 `lib/*.ts`（state 等）」）与 **§5 正文**（reader seam 方案本体）。
- **接手方会做的错误动作**：跑 S7 时打开 spec §2.1 发现「已经改过了」，于是判断 S7 整体已完成而跳过——**留下 §3.1 与 §5 正文两处未改**，以及四处**时态错误**的注记（任务 land 之后再说「正在被降为」「代码尚未动工」就是新的陈旧事实，而 §6 第 4 条刚说过「交接一旦陈旧，危害大于没有」）。
- **修法**：S7 的清单分两栏——**「已预先注记，落地后需改时态」**（spec §2.1 / §7.2-0d、backlog、DESIGN 四处，逐条给当前措辞）与**「尚未触碰」**（spec §3.1、§5 正文）。前者的验收判据是「不再出现进行时措辞」，后者是「不再描述 reader seam 为现行方案」。

---

### [MINOR] NEW-3　`HANDOVER.md:169-175`（§3.7 枚举配方）—— 命令的原始输出是 20 行、表是 16 行，「差集非空 = 交接已陈旧」这条机械判据会**误报**

- **证据**：我按文档给的命令原样跑，输出 20 行，与表差 4 行，全部是**已知的良性差异**：① `state-defaults.ts:7` 与 `state.ts:2034` 是**文档注释**里含 `from "`（`* from "~/lib/state"` sites keep working`）；② `state.ts:2030` 与 `:2035` 是**指向同一目标的两条语句**（一条 import、一条 re-export），表里合并成 #10；③ `state-defaults.ts:15` 与 `:26` 同样是同一目标的两条语句（type + value），表里合并成 #11。
- **接手方会做的错误动作**：文档把「差集非空 = 交接已陈旧，**先补表再动手**」写成了硬判据（§3.7 末尾、§6 第 4 条、KICKOFF 第 24 行三处重复）。接手方第一次跑就得到 20 vs 16，按判据他必须停下补表——**而这 4 行差异从第一天就在**。轻则浪费一轮核对，重则他「补」出 4 条假边写进表里，污染 S5/S6 的驱动清单。
- **修法**：配方加一句**预期噪声说明**：「原始输出约 20 行 > 表 16 行，差异来自 2 条注释命中（`state-defaults.ts:7`、`state.ts:2034`）与 2 处『同一目标两条语句』（`state.ts:2030/2035`、`state-defaults.ts:15/26`）。**对账的是「目标模块集合」，不是行数。**」或者把命令换成直接产出目标集合的形态（`rg -o 'from "[^"]+"' … | sort -u`），让输出与表**同构**——判据形状对齐了，误报自然消失（这正是 §6 第 3/7 条的同一个道理）。

---

### [MINOR] NEW-4　`HANDOVER.md:13`（§1 入口指引第一行）—— 必读范围写的是「§1.5–§4」，把 **§5（4 条待裁决分叉）排除在动工前必读之外**

- **证据**：§1 表第一行「本文件 §1.5–§4 | 动工前必读全部」。但 §5 有 4 条待裁决分叉，其中第 3 条（`~/lib/token/types` 包分层反转）**挡住 S4 与 S6**、第 4 条（0d 与 S2 的关系）**决定 S2 要不要做**。KICKOFF `:36` 把它列为「动手前的 gate」了，HANDOVER 自己的入口指引却没有。
- **接手方会做的错误动作**：**只有从 KICKOFF 进来的人会知道有这个 gate。** 而 §1 表第二行明确写着 KICKOFF 是「起新会话时贴给自己/agent」用的——也就是说，直接读 HANDOVER 的人（比如从 DESIGN 的 `[wip]` 段或 backlog 指针过来的并发会话，**而这正是 M-3 三处登记专门要引来的那批人**）按 §1 的指引读完 §1.5–§4 就动手，**在 S4 才发现自己撞上一个需要用户裁决的分叉**，此时 S2/S3 已经落地。
- **修法**：§1 第一行改为「§1.5–**§5**」，并在「何时读」栏补一句「**§5 是动工前的 gate：4 条分叉需用户先定，其中 2 条会挡住 S2/S4/S6**」。

---

### [NIT] NEW-5　`HANDOVER.md:34-36`、`:63-65` 残留连续空行

§2 标题与正文之间、§2.5 结尾与 §3 之间各有 2–3 个连续空行，是本轮编辑的残留。不影响渲染与理解，顺手清一下即可。

---

## 四、复审专项回答（调用方点名的 5 个问题）

**1. 断点是否后移？新断点在哪？**

**已后移，且性质改变。** 第一轮：S1 可完成，**S2 撞墙**（编辑面 25 倍误差 + 逃生口是陷阱），S6 是**投入 5 个提交后才暴露的无预案十字路口**。本轮：S1–S5 每步的信息完备度都够动手，**新断点在 S6 的 oracle ②（NEW-1）**，而它与旧断点有本质区别：

| | 第一轮的 S6 断点（B-1） | 本轮的 S6 断点（NEW-1） |
|---|---|---|
| 何时暴露 | 投入 5 个提交之后 | S6 内，加上 oracle 就立刻看到 |
| 有无预案 | 无，且 4 条边里 1 条需用户裁决 | 无，但**实质正解只有两条且都在接手方权限内** |
| 错误动作的代价 | 把守卫改弱 → 整个 S6 价值蒸发且全绿 | 回头找不存在的边 → 浪费一轮；或误以为在作弊 |
| 修法成本 | 新增一整节 + 一条待裁决分叉 | **一段话** |

**2. §3.7 是否真的解决了 B-1？**

**是。** 我用 `from "` 独立重跑枚举，**16 条与实际出边完全吻合，无遗漏、无虚构**；每条都对得上一个步骤或一个待裁决分叉，无悬空项。拿着这张表走到 S6，**唯一会撞上的十字路口就是 NEW-1**——而它不是「表漏了一条边」，恰恰相反：表把 #10/#16 都登记了，只是没标注「它们俩构成环、会被新 oracle 咬」。所以 §3.7 作为**出边清单**是完备的；缺的是一列「S6 之后是否仍然存在」。

**3. §2.5 是否解决了 M-1（先读 spec 再读 HANDOVER 的人还会不会不敢动手）？**

**会解决，而且这个「顺序反了」的场景被堵得比我预期的严实。** 我模拟了这条路径：先读 spec §2.1 → 现在**紧挨着原文就有 supersede 注记**（`spec:45`），直接给出「结论已被 supersede，但推理仍成立」+ 权威入口链接，读者根本走不到「本任务被否决了」这个结论；再往下读 §7.2-0d（`spec:135`）同样有注记且明确写「**动工前先读它，别按下面的原文起步**」。回到 HANDOVER，§1 表的 spec 那行还有一道 ⚠️ 前置提醒。**三重拦截，且都在原文旁边而不是在别处**——这是对的做法（就近拦截 > 远端声明）。**唯一残留**是 spec §3.1 与 §5 正文尚未加注记（见 NEW-2），但这两处不像 §2.1 那样会让人误判任务被否决，风险低一档。

**4. S7 与三处登记是否到位？**

**三处登记全部到位，命中位置都在接手方真会经过的路径上**（DESIGN 的 `[wip]` 段、backlog 的「state 第一」条、spec 的 §2.1/§7.2-0d），逐条核实见上表 M-3。**DESIGN 那句「要动 `state.ts` / `models/` 的并发会话请先读它」是我第一轮没想到的加强**，直接服务于本仓库最高频的风险（并发撞车）。**S7 本身有 NEW-2 的时态/范围问题**，属 MINOR。

**5. KICKOFF 重写后还有复述漂移残留吗？能否整段复制？**

**能整段复制**（有抬头 + `---` 分隔线 + 第二人称正文 + 唯一入口声明）。**复述残留基本清干净**：范围 6 条压成一行指针、坑清单每条一行 + `→ §6 第 N 条`、待办只标顺序与批准状态。**仅存两处轻微重复**，且都属于「不先知道就会立刻做错」的正当例外：① 第 13 行 worktree/eslint 那段与 HANDOVER §8 重复（**建议保留**：这是动手第一分钟就会踩的，指针形式容易被跳过）；② 第 49 行「S2 需要批量改写约 100 个测试文件」与 HANDOVER §3.5 的 105 重复——**这处建议改成指针**（「见 HANDOVER §3.5 口径表」），因为它是个**会漂移的数字**，而 KICKOFF 里的「约 100」与 HANDOVER 的「101 tests / 105 文件」已经是两个数了。这正是 m-4 想防的那类漂移，虽然当前尚未造成矛盾。

---

## 五、第二轮总判

### 现在能否让一个全新会话在不问原作者的情况下把 S1–S7 全程走完？

**能，但需要先由用户裁决 §5 的 4 条分叉——这不是缺陷，是正确处理。**

拆开说：

- **S1 / S2 / S3 / S5 / S7：可独立走完，无需问任何人。** 四步的目标、编辑面、oracle、证伪方式、已知陷阱全部齐备，我逐步模拟过动手过程，没有找到会卡住的地方。S1 与 S2 的整改质量尤其高（S1 补了字符串 golden + 引用相等断言，S2 的拓扑论证封死了唯一的错误捷径）。
- **S4 / S6：需要用户先裁决 §5 分叉 3（`~/lib/token/types`）**——文档已把它标成 gate 并给了三条候选 + 倾向意见。**这是「需要用户拍板」，不是「需要问原作者」**：接手方不需要任何原作者脑子里才有的信息，他需要的是一个决策授权。两者性质不同，前者是交接失败，后者是交接成功的标志之一。
- **S6 会额外撞上 NEW-1**（`state ↔ state-defaults` 的 2 环），文档目前给的指引是错的。**这是本轮唯一需要修的实质缺陷**，修法是一段话。

### 与第一轮的对比

第一轮我的判词是「**能做完 S1，断点在 S2，S6 是注定会红的终点**」。现在：**S1–S5 全程可走，S6 有一处一步内可自解的意外红，S7 有范围与时态的小问题。**

第一轮我指出的根因——「§3 审计的是『state 为什么在 SCC 里』，S6 需要的是『state 还剩哪些 `~/` 出边』，两者答案不同」——不仅被采纳为整改的组织原则，还被写进 §6 第 6 条固化为可迁移的教训（「**问题换了，答案就得重新算一遍，别复用形状相似的旧结论**」）。**而 NEW-1 恰好是同一个教训的第三个实例**：§3.7 回答的是「还剩哪些**出边**」，S6 的新 oracle ② 问的是「foundation 内部**还有没有环**」——又是一个换了的问题，而 #10/#16 那两行「同一单元，一起走」的结论被原样复用了。这不削弱整改的价值，反倒说明这个教训值得再固化一次。

### 建议的修订清单（按成本排序）

1. **NEW-1**：S6 oracle ② 加一段已知环说明 + KICKOFF 禁区第 5 条加例外。**一段话，必做**——不做的话接手方会在 S6 拿着一条错误指引原地打转。
2. **NEW-4**：§1 必读范围 §1.5–§4 → §1.5–**§5**。**一个字符，必做**——它保护的正是 M-3 三处登记专门引来的那批人。
3. **NEW-3**：§3.7 配方加预期噪声说明（或换成输出目标集合的形态）。
4. **NEW-2**：S7 清单分「已预先注记待改时态」与「尚未触碰」两栏。
5. **NEW-5**：清连续空行；KICKOFF `:49` 的「约 100」改指针。

前两条做完，这份交接就可以交给全新会话执行（余下的分叉交用户拍板）。

---

*第二轮复审完成。所有 `file:line` 与命令输出均于 2026-07-28 在工作区当前状态实地复核；本轮我独立重跑了 §3.7 的出边枚举、madge 扫描根、循环基线、三处登记命中、bunfig preload、S3 目标文件不存在性、resolve\* 的测试侧消费者口径。只读评审，未修改仓库任何其它文件。*

---
---

# 第三轮：修复确认（`2919c26c`）

> 只做修复确认，不重开议题。复核方式：实地读改动后的 §1 / §3.7 / S6 / S7 / §6 / KICKOFF，并为判断选项 (b) 的可行性实测了那 12 个类型的外部消费者分布。

## 一、NEW-1 的三处修复：**全部到位**，预案成立

| 处 | 判定 |
|---|---|
| §3.7 #10/#16 加「S6 之后仍然存在」标注 + 表下 ⚠️ 段 | **到位**。点名 `circular-deps-baseline.json:71`、写明「madge 计 type 边所以它算数」、写明 S1–S5 碰不到 |
| S6 预案 | **到位**。两个正当选项 + 明确「别回头找不存在的漏网边（此时 §3.7 差集为空，你会转而怀疑枚举命令又漏了什么，而那是死路）」——把我指出的那条最可能的错误路径原样堵死了 |
| KICKOFF 禁区第 5 条具名例外 | **到位**，且措辞同时从「守卫红**说明**」软化为「守卫红**通常**说明」——这一改比加例外本身更重要，它把一条绝对断言降级成了默认判断 |

### Q1：选项 (b)「把 12 个类型抽到第三个文件」我能看见的坑

**结论：(b) 可行且成本低**（实测那 12 个类型的外部消费者极少：`CompiledRewriteRule` 5 个文件、`CompiledSystemPromptEntry` 2 个、`BufferedRetryCaps`/`BufferedRetryContinuation`/`CacheControlMode`/`CacheTtl`/`WarmupPolicy` 各 1 个，`MaxTokensContinuationConfig`/`LoggingConfigState`/`ThinkingBlockMessagePolicy`/`UnknownEndpointLogging` **各 0 个**）。四个坑：

1. **⚠️ 最可能的错误动作：执行者会因为刚被 S2 教育过而不敢留 re-export。** (b) 需要在 `state.ts` 留一条 `export type { … } from "./state-vocabulary"` 才能让那 8 个外部消费者零改动——**这条 re-export 不会造环**（第三个文件是叶子、无回边），与 S2 那条被拓扑封死的 re-export **性质完全相反**。但 KICKOFF 禁区第一条写着「别在 `state.ts` 里留 re-export」，S2 又刚用一整段论证过它有多坏。**建议在 (b) 里补一句**：「这里的 re-export 与 S2 被封死的那条不同——S2 的 `models/cache.ts` 必然回指 state 故成环，而这个共享类型文件是叶子、无回边，re-export 安全。」不写这句，执行者要么不敢用、要么用了心里没底。
2. **时机应该是 S5 而不是 S6。** S5 正在把配置词汇**搬进** state，(b) 是把 12 个类型**搬出** state——两个反向动作放在相邻步骤，同一批类型被摸两次，而且执行者还得在「哪些词汇归 `state.ts`、哪些归第三个文件」上做一次**没有判据的划分**。**合并进 S5 一次做完**更省也更有判据：建一个零依赖的 `state-vocabulary.ts`，S5 反转进来的词汇（#1–#4、#9、#11-type、#12–#14）与这 12 个共享类型**全都落它**，`state.ts` 与 `state-defaults.ts` 都从它取——#16 的环顺手就没了，不必等到 S6 再处理。
3. **S6 里那个括号选项「或直接放进 `state-defaults` 由 `state` 反向 import」拓扑上成立、语义上错。** `state-defaults.ts` 的模块注释（`:3-5`）自述「holds ONLY the default data, **decoupled from the State type shape**」——把 State 的字段类型塞进去正好违反它的自述职责，撞项目 CLAUDE.md 的「命名反映实际职责」。**建议删掉这个括号或标注为不推荐**，否则它是一个下次会被人当成名实不符来重构的债。
4. **若 `RepairItem` 这类派生类型（`(typeof REPAIR_ITEMS)[number]`）也进这个文件，const 数组要跟着进**，该文件就不是 types-only 而含值。对 foundation 准入无碍（相对路径照样放行），只是别指望它是纯类型文件——S5 的证伪方式已经提示了这个机制，此处只是提醒它会落到同一个文件里。

### Q2：§3.7 那一列是否真能让下次自己暴露

**部分能，且是真进步，但没有完全脱离自觉。**

把检查从"记性"变成"表格槽位"是对的——空槽位显眼，这正是模板 `handover.md:3` 的同一原理。但这一列的**列名绑定了一个具体问题**（「S6 之后是否仍然存在」）。**下次如果 oracle 换成第四个问题**——比如抽包时问「foundation 内部有没有跨文件的**值**依赖」，或者「哪些符号构成包的公共 API 表面」——这一列答不上来，还是得靠人想到要加新列。

真正泛化的形态是把列名换成**「本行结论只对哪个问题成立」**（给每行结论标注它的适用问题域），换问题时不匹配会自己跳出来。不过这属于「更好」而非「必须」：**当前形态已经足以拦住第三次同型复发**，而 §6 第 6 条现在把三次实例并列写出来（这一点做得很好——把「我以为已经吸取教训了」这句写进去，比任何抽象教训都有效）。

## 二、Q3：NEW-2 / 3 / 5 与 NIT

| 编号 | 判定 |
|---|---|
| **NEW-2**（S7 范围与时态） | **已解决，且强于我的建议**。我只建议分「待改时态 / 尚未触碰」两栏；实际做成了 **required-file assertion**（少一个就是没做完）+ 明确「supersede 注记只是"标记为旧前提"，不是"按落地结果改写"」+ **四维检索**（旧路径 / 被迁符号的旧 owner / 旧架构短语 / 排序清单）+ 每维正样本自证。**还补进了 §11**——那是我第二轮才发现的佐证点，能想到它也要 doc-sync 是对的 |
| **NEW-3**（枚举配方噪声） | **已解决，且是升级而非打补丁**。我建议加噪声说明；实际把权威枚举改成 **AST（`allModuleSpecifiers()`）**，`rg` 降级为"仅浏览"并列出它漏什么（side-effect import / `import = require` / dynamic import / 字符串注释干扰）。噪声问题被溶解而不是被注释掉。**留两处残留，见下** |
| **NEW-5**（连续空行） | **未修**。`HANDOVER.md:34-36`、`:63-65` 仍是 3 连续空行。纯 NIT，不影响任何判断 |

### 本轮唯一的实质残留（MINOR）

**`KICKOFF.md:24` 仍写死 `rg -n 'from "' …` 作为「动工第一件事」的第 2 项**，而 HANDOVER §3.7 刚刚把这条 `rg` 降级为「**只是浏览，不是完整枚举**」。同时 §3.7 末尾「动工前重跑一次**枚举命令**，与本表做差集」里的"枚举命令"现在也有歧义（AST 脚本 还是 rg？）。

- **接手方会做的错误动作**：按 KICKOFF 逐条执行复验，用一个已被降级的方法去跑「**差集非空就先补表再动手**」这条硬判据——而这条判据的整个价值就建立在枚举的完备性上。
- **这是 m-4（KICKOFF 复述导致漂移）的一个活实例**：HANDOVER 改了方法，KICKOFF 里的复述版本没跟上。正好印证了当初把复述压成指针的理由。
- **修法**：KICKOFF `:24` 改成「**§3.7 的出边枚举（用它指定的 AST 方式，不是 `rg`）**」；§3.7 末尾的"枚举命令"改成"AST 枚举"。**两处各一行。**

## 三、最终 verdict

**能。一个全新会话可以在不问原作者的情况下把 S1–S7 全程走完**（`§5` 的 4 条待裁决分叉按第二轮的定性算「需要用户决策授权」，不是交接失败——文档已把它们标成 gate、给了候选路径与倾向意见，且 §1 必读范围已改到 `§1.5–§5`，从 DESIGN / backlog 指针进来的人不会再错过这道 gate）。

三轮的断点迁移：

| 轮次 | 断点 | 性质 |
|---|---|---|
| 第一轮 | **S2 撞墙**；S6 是投入 5 个提交后才暴露的无预案十字路口 | 交接失败 |
| 第二轮 | **S6 的意外红**（`state ↔ state-defaults`），且禁令给出错误指引 | 一步内可发现，但指引是错的 |
| 第三轮 | **无阻断点**。唯一残留是 KICKOFF `:24` 指向一个已降级的枚举方法 | 两行修订 |

余下两条（KICKOFF `:24` 的枚举方法 + 那两处连续空行）都不阻断执行，可以在动工时顺手带过。

**最后一句评价**（不是发现，是判断）：这份交接现在的价值密度已经明显高于「一份交接文档」——§6 的 8 条教训里有 5 条是**在评审过程中被证伪后回填的**，其中第 8 条（「给自己新写的 oracle 断言它一定咬得住，而那只是推理不是实验」）是本轮最有迁移价值的一条：**它抓的是"我在文档里教育别人守卫绿不自证，转头就给自己新写的三个 oracle 下了没做实验的绝对断言"这个具体的自我不一致**，比任何抽象原则都更可能在下次被真正想起来。这条值得考虑固化进项目 skill 或记忆库，而不只是留在这份交接里。

---

*第三轮确认完成。本轮实地核对：§1 / §3.7 / S6 / S7 / §6 第 6·8 条 / KICKOFF 全文 / 12 个共享类型的外部消费者分布 / 连续空行位置。只读评审，未修改仓库任何其它文件。*
