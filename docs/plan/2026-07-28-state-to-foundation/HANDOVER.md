# HANDOVER：把 `state` + `state-defaults` 降为 foundation 叶子

> **状态**：进行中——范围已由用户拍板、**代码尚未动工**。本文件是**唯一入口**，接手请先读完再看别的。
> **核验基线**：`23e85aba`（2026-07-28）。此后到 `847f8bc8` 的 9 个 peer 提交**全是文档**（`git diff --name-only 23e85aba..847f8bc8` 无一 `src/`、`packages/`、`tests/` 命中），故下列实测数字在 `847f8bc8` 仍成立。**再往后接手请重跑 §3.1 的实测命令**——数字有时效（见 §6 第 1 条）。
> **工作区**：分支 `master`（本文档直接在主树提交，见 §8）；本任务**未建 worktree**、**无代码改动**；主树有并发 peer 的未提交改动十余个文件 + 3 个未追踪文件，**全部与本任务无关**。
> **已跑门禁**：`computeCircularSnapshot()` 实测（2026-07-28，见 §3.1/§3.2）。测试门禁**未跑**——本任务零代码改动，无可跑内容；`bun run test:backend` 在本机**跑不起来**（§8）。
> **前身**：monorepo 拆分 Phase 4 的第三次剥离（前两次 = `@hsupu/ghc-proxy-token` 2026-07-23、`@hsupu/ghc-proxy-telemetry` 2026-07-27，均已 landed）。

## 1. 入口指引：什么时候读什么

| 材料 | 何时读 |
|---|---|
| 本文件 §2–§4 | 动工前必读全部 |
| [KICKOFF.md](KICKOFF.md) | 起新会话时贴给自己/agent |
| [plan-token-package.md](../monorepo-split/plan-token-package.md)「通用 DomainPeel Contract」 | 写具体 plan 时（本次不是抽包，但边界守卫/过渡纪律可复用） |
| [plan-telemetry-package.md](../monorepo-split/plan-telemetry-package.md) 头部「执行期偏差」 | 想知道"上一轮为什么这么做"时 |
| 记忆 `methodology-domain-peel-execution-techniques` | 真正开始搬代码时 |
| [spec/2026-07-22-monorepo-workspace-split.md](../../spec/2026-07-22-monorepo-workspace-split.md) §7.2 | 需要理解本步在总路线中的位置时 |

**不需要读**：telemetry peel 的 T1–T5 提交本身（那是抽包，本次不抽包）。

## 2. 用户已裁定的范围（**别再重开这个议题**）

用户在 2026-07-27 的讨论中逐条收窄，最终范围是：

- ✅ **`state.ts` + `state-defaults.ts` 可以成为 foundation 的一部分**，前提是**只依赖语言/系统内置**。
- ✅ **简单 setter 留在 state**（约 30 个 `setXConfig`）——用户原话「简单的 setters 留在 state 上没问题」。**不要**把它们迁往各域，那是范围扩大。
- ✅ **state 本身不需要测试**——用户原话。所以测试专用函数不构成"必须留在 core"的理由。
- ✅ **对 state 的读写与辅助函数，可能属于子模块**——用户提出，实测证实（见 §3）。这些回各自的域。
- ❌ **不做**：单独建 `config-vocabulary` 模块（我提过，被判定多余——见 §6 第 2 条）。
- ❌ **不做**：把 30 个 config setter 拆到各域。

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

### 3.3 `state.ts` 只有 3 个值依赖，全部可解 —— 【源码读证 + 实测】

| 值依赖 | 位置 | 结论 |
|---|---|---|
| `normalizeForMatching` | `state.ts:20` ← `~/lib/models/model-name` | 该模块**零 import**；且此函数在 state 内**只被 models 逻辑用**（`:1428`/`:1429`/`:1455`/`:1456` 四处，全在 `applyDisabledFilter` 与 `getConfigDisabledIds` 内）→ **随 models 逻辑一起走，边自然消失** |
| `~/lib/token/store` 6 个符号 | `state.ts:21-30` | **只出现在 3 个 test-only 函数里**（`snapshotStateForTests:1976`、`setStateForTests:1989`、`restoreStateForTests:2009`），生产路径零使用 → 见 §4 步骤 4 的反转方案 |
| `./state-defaults` | `state.ts:2025` | 同一单元，一起走 |

其余 **7 行全是 `import type`**。

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

**域外消费者：4 个文件**（`rg -ln` 实测）。

**③-b 每模型 override 解析**（纯函数，合并 shared + per-model override）：

| 符号 | 行 |
|---|---|
| `resolveBufferedCaps` | `:1874` |
| `resolveContinuation` | `:1888` |
| `resolveMaxTokensContinuation` | `:1938` |
| `resolveEffectiveMaxTokensContinuation` | `:1959` |

四个共约 45 行。**域外消费者：8 个文件**。它们是"解析"不是"存储"——读 state 的两个字段算出结果，不改 state。

**③-c 测试专用**：`snapshotStateForTests:1976` / `setStateForTests:1989` / `restoreStateForTests:2009`。**`setStateForTests` 被 165 个文件使用**（实测 `rg -l`）。

### 3.6 类型依赖不构成阻塞 —— 【推断，但机制可靠】

7 个 `import type` 全是配置词汇：`AssistantBlockLayoutStrategy`（三值字符串联合）、`ThinkingBlockSanitizeMode`（四值联合）、`RepairItem`（const 数组派生联合）、`ModelTranslation`、`AdaptiveRateLimiterConfig`（数值 config 接口）、`Model`/`ModelsResponse`（**GHC 上游 wire 类型，不是配置词汇**）、`TokenStoreSnapshot`（来自 token 包）。

机制：**叶子没有出边，所以谁依赖它都不可能成环**。把词汇的归属反转（实现模块从 state import 类型，而不是 state 从实现模块 import）即可。madge 计 type 边，所以这一步是**必须的**，不能只靠"反正 type 会被擦除"。

⚠️ **`Model`/`ModelsResponse` 需要单独决定**（见 §5 未裁决分叉）。

## 4. 执行步骤（每步带验收 oracle 与证伪方式）

> 通用不变量（每 commit）：typecheck 绿 + `bun scripts/parallel-test.ts unit it http` 绿 + 精确 pathspec lint 绿 + SCC ratchet 只减不增。
> **SCC 数字一律 `computeCircularSnapshot()` 实测，禁止从 baseline 环列表推算**（推算会高估，见 §6 第 1 条）。

### S1 — 两个 refusal 常量挪进已有零依赖叶子

- **做什么**：`DEFAULT_REFUSAL_END_TURN_TEXT` + `DEFAULT_REFUSAL_ERROR_MESSAGE` 从 `recover-refusal.ts` 迁入 `refusal-policy.ts`（该叶子已拥有第三个常量）；`recover-refusal.ts` 改成 re-export（**注意 `export ... from` 不绑定本地名**，文件内若自用需另 import——telemetry peel 踩过这个坑）；`state-defaults.ts:25` 改指 `refusal-policy`。
- **验收 oracle**：`computeCircularSnapshot()` 实测应得 **30 环 / 43 成员**（PoC 已验证）。
- **证伪方式**：若实测数字明显偏离，说明 peer 又改了图——**别调整期望值去迁就，先重跑 §3.1 摸清现状**。
- **风险**：极低（移动字符串字面量，行为逐字节不变）。

### S2 — models 逻辑回 models 域

- **做什么**：§3.5 ③-a 的 8 个符号 + `rawModels` 模块变量迁往 `src/lib/models/`（建议 `models/cache.ts`）；4 个域外消费者改 import。`state.ts` 对 `normalizeForMatching` 的 import 随之删除。
- **保留在 state 的**：`models` / `modelIndex` / `modelIds` / `disabledModels` **字段本身**（它们是状态），只是操作它们的逻辑搬走——通过既有的 `updateState` 写入口。
- **验收 oracle**：① `rg -n 'normalizeForMatching' src/lib/state.ts` 归零；② `/api/models` 与 `/api/status` 端点响应逐字节不变（起非 4141 端口测试服务器对比，或用既有 http 测试作冻结基线）；③ 全后端绿。
- **证伪方式**：`setModels` 的调用顺序（写缓存→过滤→重建索引）是有序副作用，**搬迁后必须保序**；用一个"设置 models 后立刻读 modelIndex"的正样本测试确认索引真的被重建了（不是恰好上一次的残留）。

### S3 — 4 个 `resolve*` 回各自域

- **做什么**：§3.5 ③-b 的四个纯函数迁往它们的消费域（buffered-retry / max-tokens continuation 相关模块）；8 个域外消费者改 import。
- **验收 oracle**：① `state.ts` 行数下降且不再出现 override 合并逻辑；② 既有 buffered-retry / max-tokens 测试全绿（它们是行为冻结基线）。
- **证伪方式**：这四个函数读 state 字段——搬走后它们要么继续读 state（合法，state 是叶子），要么改成接收参数。**如果选后者，必须确认所有调用点传的是同一份 live 值**，否则会静默读到快照。

### S4 — 测试 shim 反转成通用 snapshot 参与者注册表

- **做什么**：在 state 里加一个**零领域知识**的参与者注册表（`registerSnapshotParticipant({ snapshot, restore })`），token 包从 core 侧自行注册；`state.ts` 删掉对 `~/lib/token/store` 的 import；`setStateForTests` 的宽签名（接收 4 个凭据键）改为转发给已注册参与者。
- **为什么这样而不是把三个函数搬去 `tests/helpers/`**：`setStateForTests` 被 **165 个文件**使用；反转方案让这 165 个文件**一行都不用改**。
- **验收 oracle**：① `rg -n 'token/store' src/lib/state.ts` 归零；② 全后端绿且**不改任何测试文件**（改动量本身就是 oracle——若你发现要改测试，说明反转没做对）；③ 正向隔离测试：测试 A 写 4 个凭据键、测试 B 断言已复位。
- **证伪方式**：`"key" in patch` 门控要保留（区分"显式 undefined→清空"与"缺席→不动"）——token peel 记忆里明确写过这个坑。

### S5 — 配置词汇归属反转

- **做什么**：§3.6 的 5 个配置词汇类型（`AssistantBlockLayoutStrategy` / `ThinkingBlockSanitizeMode` / `RepairItem` / `ModelTranslation` / `AdaptiveRateLimiterConfig`）迁入 state（或 foundation 内 state 旁），实现模块反向 import。
- **验收 oracle**：`state.ts` 的 `import type` 只剩下 §5 分叉决定保留的那些；`computeCircularSnapshot()` 实测环数继续下降。
- **证伪方式**：`RepairItem` 是 `(typeof REPAIR_ITEMS)[number]`——**它依赖那个 const 数组**。搬类型就得连数组一起搬，或改成显式字面量联合 + 一条编译期可赋值性断言防漂移（telemetry T4 对 `TelemetryUsage` 用过这个手法）。

### S6 — `git mv` state + state-defaults → foundation

- **做什么**：物理搬迁 + tsconfig path + 边界守卫（复用 `tests/architecture/package-boundaries.unit.test.ts` 的 allowlist 检测器形态，但本次 allowlist 只有 `node:` 与相对路径——"只依赖内置"要变成**机器强制**）。
- **验收 oracle**：① 边界守卫带正样本对照（故意加一条 `~/lib/x` import 必须变红）；② `computeCircularSnapshot()` 实测 state/state-defaults 不在 `members` 里；③ `bun run build:backend` + bin `--help` + 端点表面不变。
- **证伪方式**：守卫"绿"不自证——**先做变异实验证明它会咬**（六轮评审的核心教训，见 §6 第 3 条）。

## 5. 仍待裁决的分叉（**需用户先定，别自己拍**）

1. **`Model` / `ModelsResponse` 怎么办**。它们是 GHC 上游 wire 类型（不是配置词汇），而 state 持有 `modelIndex: Map<string, Model>`。两条路：
   - (a) 一并下沉 foundation（foundation 已住着 `ghc-http-primitives`，wire 类型放旁边自洽）；
   - (b) state 的模型缓存改用结构型 + 编译期可赋值性 oracle（telemetry T4 的做法）。
   我倾向 (a)——它们是真·共享词汇；但这会让 foundation 承载 GHC API 形状，需用户认可。
2. **S2 之后 `models` 字段是否也该跟着走**。本次范围是"逻辑回域、字段留 state"，但如果 models 域最终也要抽包，字段迟早要动。**本次不动**，只是标记出来。

## 6. 我犯过的错（**比结论更有用，别重犯**）

1. **拿基线环列表推算削环量，高估了 8 条**。我先用 `circular-deps-baseline.json` 的环列表模拟"切掉某条边"，算出 70→21；实际跑 madge 是 70→29（本次重测 30）。原因：基线是**规范化后的环列表**，在这个表示上切一条边会把本可经其它路径成立的环也算没了。**教训：SCC 数字只认 `computeCircularSnapshot()` 实测。** 我在给用户的第一版结论里就报了推算值，事后自己纠正。
2. **过度设计：提议单独建 `config-vocabulary` 模块**。用户一句"state 本身就可以是词汇的家"点破——**一旦 state 是真叶子，谁依赖它都不成环**，独立词汇模块是白加一层。教训：先想清楚"叶子无出边"这个性质能覆盖多少，再决定要不要造新抽象。
3. **守卫"绿"不自证——这是刚过去那六轮评审的核心教训**。telemetry peel 的合并态审跑了六轮，每轮异模型 reviewer 都用**合法且能编译**的写法绕过我刚加固的守卫（别名导出、`export *`、注释夹在 token 之间、`catch` 分支、没人调的 helper、可选链……）。两次真正的转折点都不是"更强的守卫"，而是**换判据形状**（blocklist→allowlist）和**换不变量位置**（把顺序契约搬进 runtime 自己）。本次 S6 的边界守卫务必带变异实验。详见记忆 `methodology-relocate-invariant-when-guard-cannot-keep-up`。
4. **写交接前没先看 `git log`——差点用陈旧事实**。本文成稿前 HEAD 已从我实测时前进 20 个提交，其中 peer 大改了 `recover-refusal.ts`（还顺手建了 `refusal-policy.ts` 这个正是我需要的零依赖叶子）。**我重测后才发现 S1 的工作量已被 peer 砍掉三分之一**。教训：交接一旦陈旧，危害大于没有。
5. **注释写错会让照着注释写的代码看起来是对的**。同一轮我在一个守卫的文档里写「try/catch/finally 都不 gate 正常路径」——对 `catch` 是错的，于是"把生产调用从 try 移进 catch"编译通过、正常路径永不执行、守卫全绿。自洽且完全错。

## 7. 产物清单

| 产物 | 路径 | 已提交? | 它**没有**证明什么 |
|---|---|---|---|
| 本交接 + kick-off | `docs/plan/2026-07-28-state-to-foundation/{HANDOVER,KICKOFF}.md` | 是（`cc2fb141`） | — |
| S1 削环 PoC | **无留存**——改完实测完即 `git checkout --` 还原 | 否（有意不留） | 它只证明了「挪走那两个常量后 madge 图变成 30 环/43 成员」。它**没有**证明：改完 typecheck 绿、测试绿、`recover-refusal.ts` 的 re-export 形态可用（PoC 期间恰好撞上 `export … from` 不绑定本地名的 TS2304，是当场手工绕过的），更**没有**证明 state 因此就成了叶子——S1 只削环，state 落地 foundation 要等 S6 |
| 上一轮 telemetry peel 的执行期偏差记录 | [plan-telemetry-package.md](../monorepo-split/plan-telemetry-package.md) 头部 | 是 | 那是抽包流程的经验，本次**不抽包**，只有边界守卫与过渡纪律可复用 |

**没有 `exp/<topic>/` 目录**：本轮唯一的实验是一次可在 30 秒内重跑的削环量测，配方已完整写进 §3.2 与 §4/S1，留一份实验目录只会多一处会漂移的事实源。**重跑配方**：把 `DEFAULT_REFUSAL_END_TURN_TEXT` / `DEFAULT_REFUSAL_ERROR_MESSAGE` 移入 `src/lib/anthropic/refusal-policy.ts`、`state-defaults.ts:25` 改指该文件，然后跑 `computeCircularSnapshot()`。

## 8. 当前环境状态（接手须知）

- **`rustup` 无任何已安装 toolchain** → `bun run test:backend` 的前置 `build:history-search` **必挂**。用 `bun scripts/parallel-test.ts unit it http`（等价全后端档）。修法：`rustup default stable`。
- **主树有并发 peer 的未提交改动**（十几个文件）。一律显式 pathspec 提交，`git add -A` 绝对禁止。
- **typecheck 当前有 peer 在飞的报错**（`PostCommitAbortKind` / `retry-giveups`）——**不是你引入的**，别去"修"它，只确认自己的改动没新增错误。
- 代码改动走隔离 worktree（`git worktree add .worktrees/state-foundation -b feat/state-foundation` 后**必须 `bun install`**，否则 eslint exit 127）；**本交接文档本身留在主树**。
