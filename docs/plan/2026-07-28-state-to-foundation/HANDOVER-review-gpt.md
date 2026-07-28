# `state` → foundation 交接文档对抗评审

## 评审范围与结论

- **评审对象**：`HANDOVER.md`、`KICKOFF.md`，以及模板 `.claude/skills/session-closeout/{SKILL,handover}.md`。
- **评审基线**：文档自报基线 `23e85aba`，评审时仓库 HEAD `c716d921`；文档自身截至 `31e39d6f` 无内容变化。
- **verdict**：**修复 MAJOR 后再交接执行**。
- **计数**：BLOCKER 0，MAJOR 4，MINOR 4，NIT 0。

## 已实测确认、无需返工的部分

1. **SCC 基线与 S1 PoC 数字正确。**
   - 基线命令：`bun -e 'import { computeCircularSnapshot } from "./tests/architecture/circular-deps-snapshot.ts"; ...'`
   - 输出：`{"count":70,"members":63}`；高频成员分别为 `state.ts 52/70`、`state-defaults.ts 50/70`、`recover-refusal.ts 49/70`、`anthropic/client.ts 48/70`、`copilot-api.ts 35/70`、`models/client.ts 32/70`，与 HANDOVER §3.1 一致。
   - PoC：把 `DEFAULT_REFUSAL_END_TURN_TEXT`、`DEFAULT_REFUSAL_ERROR_MESSAGE` 临时迁入 `refusal-policy.ts`，`recover-refusal.ts` 改为 import + re-export，`state-defaults.ts` 改指该叶子，再运行 `computeCircularSnapshot()`。
   - 输出：`{"count":30,"members":43}`。随后执行 `git checkout -- src/lib/anthropic/recover-refusal.ts src/lib/anthropic/refusal-policy.ts src/lib/state-defaults.ts`；变异前后 `git status --short` 逐字一致，未留下 PoC 残留。
2. **§3.5 的 15 个符号定义行号准确。** 命令：`git show 23e85aba:src/lib/state.ts | rg -n '^(let rawModels|function applyDisabledFilter|export function ...)'`。输出逐项命中 HANDOVER 所列 `1422/1424/1434/1441/1452/1468/1476/2018`、`1874/1888/1938/1959`、`1976/1989/2009`。
3. **models 与 resolve 的“域外消费者”若明确指 production direct-import 文件，则 4 与 7（不是 8）。** AST 扫描 `import { ... } from "~/lib/state"`：models production direct import 为 4 个文件；resolve production direct import 为 7 个文件，详见 MAJOR-1。
4. **token/store 否定断言正确。** 先用已知正样本命令 `git show 23e85aba:src/lib/state.ts | rg -n 'snapshotTokenStoreForTests\(|restoreTokenStoreForTests\(|setStore...\('`，确认检查能命中 6 个调用；输出只在 `1977`、`1998–2001`、`2011`，分别位于 `snapshotStateForTests`、`setStateForTests`、`restoreStateForTests`。再运行 `git grep -n '~/lib/token/store' 23e85aba -- ':!src/lib/state.ts' ':!tests/**' ':!docs/**' ':!archive/**' ':!refs/**'`，输出为空。因此“这 6 个值符号只被 3 个 test-only 函数使用、生产路径零使用”成立。
5. **`23e85aba..847f8bc8` 确实未改 `src/`、`packages/`、`tests/`。** 命令：`git diff --name-only 23e85aba..847f8bc8 | rg '^(src|packages|tests)/' || true`，输出为空；全范围共 28 个文档／skill 文件。

## 事实性发现

### [MAJOR] HANDOVER.md:84-95、S2:121、S3:128 — “域外消费者”计数口径不清，S2/S3 按文档执行会漏改大量测试 import

**实测命令与输出**：

```text
bun - <<'TS'
// TypeScript AST 扫描所有 @23e85aba 的 `import { ... } from "~/lib/state"`
// 对 §3.5 的 models 与 resolve 符号集合求直接 import 文件并分 production/tests
TS
```

输出：

```text
models total 105 prod 4 tests 101
resolve total 10 prod 7 tests 3
```

models 的 4 个 production direct-import 文件确为：

```text
packages/cli/src/start.ts
src/lib/config/config.ts
src/lib/models/client.ts
src/routes/models/internal.ts
```

resolve 的 7 个 production direct-import 文件为：

```text
src/lib/config/config.ts
src/routes/chat-completions/buffered-config.ts
src/routes/chat-completions/handler-v4.ts
src/routes/messages/handler-v4.ts
src/routes/responses/buffered-config.ts
src/routes/responses/handler-v4.ts
src/routes/responses/ws.ts
```

所以 HANDOVER §3.5 的“4 个文件”只有在“production direct-import 文件”口径下正确；“8 个文件”与基线不符，实测是 7。更关键的是，S2 写“4 个域外消费者改 import”、S3 写“8 个域外消费者改 import”，会让执行者误以为总改动面仅这些文件，实际还有 **101 个测试 direct-import models 符号、3 个测试 direct-import resolve 符号**。这与 KICKOFF:45“别改 `tests/` 下的 165 个 `setStateForTests` 调用点”不是一回事：可以且必须迁移测试里的 `setModels`、`setDisabledModels`、`resolve*` import；只要求 `setStateForTests` 调用点零改动。

**失败场景**：执行者只迁 4／8 个文件后删除 state re-export，typecheck 大面积失败；若为省事保留 state re-export，则 S2/S3 的边界收敛目标假完成，state 继续暴露领域逻辑的双轨表面。

**修复建议**：

- 把两个计数明确写成“production direct-import 文件：4／7”。
- 同时列出“测试 direct-import 文件：101／3；测试 import 也必须迁到新 owner，但 `setStateForTests` 调用不动”。
- S2/S3 oracle 增加 AST 或 `rg` 正控：迁移后全仓（含 tests）不得再从 `~/lib/state` import 这些符号；先在合成正样本上证明检测器会命中 aliased／multiline import。

### [MAJOR] HANDOVER.md:132-137、KICKOFF.md:45 — S4 的“全后端绿且不改任何测试文件”是确定的假绿 oracle，并且与正确实现所需的测试接线冲突

**实测依据**：

- 当前 token store 隔离由 `state.ts` 直接 import token store，并在 `snapshotStateForTests()`／`restoreStateForTests()` 中同步调用，见 `state.ts:1976-2011`。
- 测试 floor 只有 `bunfig.toml:16` 的 `install-token-deps.ts`，该 preload 只调用 `installDefaultTokenDeps()`；它没有注册 snapshot participant。
- 已有正向测试 `tests/token/credential-store-isolation.it.test.ts:24-57` 证明当前四凭据转发和跨测试复位，但没有测试“没有 participant 注册时 fail-fast”或“默认 token participant 已注册”。

**为什么 oracle 会假绿**：文档方案把 token 包改为“从 core 侧自行注册”，但同时把“不改任何测试文件”当 oracle。一个最容易实现且能让现有全套件绿的形状，是 state 注册表在无 participant 时静默忽略 token 键／只处理 state；如果测试 floor 未显式装 token participant，现有多数测试仍可能靠前后默认空状态通过，尤其 `setStateForTests` 的 165 文件计数并不等于 165 个凭据语义 oracle。反过来，若注册发生在 production composition root，而测试直 import state、未走该 root，测试与生产接线会分叉。

**更直接的矛盾**：“token 包从 core 侧自行注册”需要一个明确 composition-root 接线点；该接线要么进 bunfig preload／fixture（测试文件必须改），要么靠 import side effect（隐藏时序依赖），要么 state 自己 import token 注册函数（重新引回边）。所以“不改任何测试文件即正确”不是 oracle，而是在阻止补上必要的 integration wiring test。

**修复建议**：

- 删除“且不改任何测试文件（改动量本身就是 oracle）”；改成“165 个 `setStateForTests` 调用点不改，但允许／要求修改集中式 preload、fixture、resetter 与 token 隔离测试”。
- 明确唯一注册 owner 与时机：production composition root、bunfig test preload、每测试 reset 后是否重装。
- 注册 API 必须定义并测试：重复注册、缺失 participant、participant 抛错、snapshot/restore 顺序、snapshot 类型身份、`"key" in patch` 的显式 undefined。
- 增加 mutation：删除 production 注册与删除 test-floor 注册都必须使各自 integration oracle 变红；不能只测 registry primitive。

### [MAJOR] HANDOVER.md:145-149、KICKOFF.md:37 — S6 建议“复用现有 foundation allowlist 形态”会把已知假绿守卫当模板；现有 guard 与“只依赖内置”契约不一致

**实测命令与输出**：

```text
rg -n '^import|from "|import\(' packages/foundation/src --glob '*.ts' \
  | rg -v 'from "\.|from "node:|import\("node:'
```

输出包含：

```text
packages/foundation/src/diff/block-align.ts: import { diffArrays } from "diff"
packages/foundation/src/process-identity.ts: import consola from "consola"
packages/foundation/src/repetition-detector.ts: import consola from "consola"
```

现有 `foundationHasForbiddenImport()` 位于 `tests/architecture/package-boundaries.unit.test.ts:50-58`，是 regex denylist，只拒 `@hsupu/ghc-proxy-{core,server,cli}` 与 `~/`。ESLint `eslint.config.js:347-375` 也是 denylist，并明确允许 bare external。因此它不是 HANDOVER 所说的“allowlist 检测器形态”，更不表达“只有 node: 与相对路径”。它还继承 telemetry 六轮已经实证过的 regex 盲点，例如 token 间注释与 type-only／ImportType 形态。

**失败场景**：执行者照文档“复用现有形态”只加 `~/lib/x` 正控；守卫会红，但 state 仍可合法引入 `consola`、`diff`、任意新 npm 包或某些合法语法形态，S6 oracle 全绿而“只依赖语言／系统内置”已破坏。

**修复建议**：

- 明确写“不得复用现有 foundation regex denylist；复用 telemetry 的 TypeScript-AST `allModuleSpecifiers()` 技法，为迁入的 state/state-defaults 建独立严格 allowlist：仅相对路径与 `node:`”。
- 正控至少覆盖：`~/`、任意 bare external（如 `consola`）、其他 workspace 包、type-only import、`import("x").T`、dynamic import、require、token 间注释。
- 负控覆盖相对 import 与 `node:`。
- ESLint 镜像也必须是真 allowlist；不要用 `group: ["**", "!allowed"]` 的已知 OR 陷阱。

### [MAJOR] HANDOVER.md:145-149 — S6 的 SCC oracle 在物理搬迁后天然看不见目标文件，不能证明新 foundation 路径无环

**实测证据**：`tests/architecture/circular-deps-snapshot.ts:53-60` 的 `computeCircularSnapshot()` 只运行：

```ts
madge(path.join(REPO_ROOT, "src"), ...)
```

它不扫描 `packages/foundation/src`。S6 把 `state.ts`、`state-defaults.ts` 移出 `src/` 后，`members` 自然不再含旧路径，即使新文件在 `packages/foundation` 内通过相对 import 构成环，或被某个包路径反向引用。故“state/state-defaults 不在 members”在 move 完成后是路径消失 oracle，不是无环 oracle。

**失败场景**：`packages/foundation/src/state.ts ↔ packages/foundation/src/state-defaults.ts` 形成两文件环；`computeCircularSnapshot()` 仍报告旧 state 不在 members，S6 验收通过。

**修复建议**：

- 扩 `computeCircularSnapshot()` 的扫描根到所有 workspace package，或新增 package-wide madge snapshot／foundation 专项 `madge packages/foundation/src --circular`。
- 做正控：临时在 foundation 两个 fixture／真实文件间造相对环，确认新 oracle 变红后还原。
- S6 仍可保留“core SCC members 不含旧 state”，但只能作为迁移完成的辅助断言，不能替代 package-wide 无环证明。

### [MINOR] HANDOVER.md:97、KICKOFF.md:45 — “`setStateForTests` 被 165 个文件使用”缺少精确定义，按文档基线无法复现

**实测命令与输出**：

```text
for rev in 23e85aba 847f8bc8 773773b2; do
  git grep -l -w setStateForTests "$rev" -- 'tests/*.ts' | wc -l
done
```

三个 revision 都输出 **164**。其中含 3 个 `tests/helpers` 文件；排除 helpers 是 161。`git grep ... -- '*.ts'` 全仓为 167（含 `state.ts` owner + 2 个 `exp/` 探针）；当前工作区 `rg -l -w ... tests` 因 peer 新增文件为 164。没有得到 165 的稳定口径。

**修复建议**：把数字改为“基线 `23e85aba`：164 个 tests 文件（其中 3 个 helpers）直接出现该符号；另有 2 个 exp 探针；调用点保持零改动”，并把精确计数命令写进文档。或者避免脆弱数字，写“约 160 个 test 文件”，但 HANDOVER 的硬事实表更推荐精确命令＋输出。

### [MINOR] HANDOVER.md:99-105、S5:139-143 — 类型依赖清单与迁移范围漏掉 `SeparatorCarrier`、token snapshot／credential 类型，接手方会在 S5 后才撞到额外边

**实测命令**：

```text
git show 23e85aba:src/lib/state.ts | rg -n '^import type|SeparatorCarrier|CopilotTokenInfo|TokenInfo|TokenStoreSnapshot'
```

输出显示：

- `SeparatorCarrier` 位于 `state.ts:4`，用于 `State.separatorCarrier:520`；HANDOVER §3.6 的“7 个 import type”清单未列它。
- `CopilotTokenInfo`、`TokenInfo` 位于 `:16-17`，用于 `setStateForTests` 宽签名 `:1993-1994`。
- `TokenStoreSnapshot` 位于 `:29`，用于 `StateSnapshot.tokenStore:1190`。

文档把 S5 写成迁移 5 个配置词汇，然后“state.ts import type 只剩 §5 分叉决定保留的那些”；但 S4 注册表设计必须同时解决 token participant snapshot 类型与凭据 patch 类型，否则 state 仍依赖 token 包。`SeparatorCarrier` 也需与 `AssistantBlockLayoutStrategy` 一起处理。

**修复建议**：将 §3.6 改为按来源完整列出全部 type edges，并在 S4/S5 各自标归属：token 类型由通用 participant 的 erased／generic contract 消化；`SeparatorCarrier` 与 block-layout vocabulary 一起迁或反转。验收用 AST `allModuleSpecifiers(state.ts)`，不要只数 import 行。

### [MINOR] HANDOVER.md:112-117 — S1 的 SCC 数字 oracle正确，但缺少字节／导出契约 oracle，已知的 TS2304 坑仍可在验收后才暴露

文档产物清单 `HANDOVER.md:172` 自己承认 PoC “没有证明 typecheck 绿、测试绿、re-export 形态可用”，且 PoC 期间真实撞过 `export … from` 不绑定本地名。S1 通用门禁包含 typecheck，但没有独立锁定两个默认字符串及原公共导入路径仍可用。若迁移时字符串被编辑、或 `recover-refusal.ts` 只 re-export 而内部使用缺 import，SCC 数字仍是 30/43；typecheck 只能抓后者，不能抓字符串语义漂移。

**修复建议**：S1 增加两条小 oracle：

1. `recover-refusal.ts` 原公共导出路径与 `refusal-policy.ts` owner 导出的常量引用相等／可赋值；
2. 两个默认字符串逐字 golden（或对现有真实 refusal frame 的默认输出断完整文本）。

并做 mutation：改一个字符时 golden 必须红。

### [MINOR] KICKOFF.md:6、HANDOVER.md:182 — “新 worktree 必须先 bun install，否则 eslint exit 127”与项目当前 node_modules 向上解析事实冲突，写成硬性必然结论会误导排障

项目 CLAUDE.md 与 memory 已记录：`.worktrees/` 内会向上解析主树 `node_modules`，新树并非依赖隔离；真正稳定缺失的是 gitignored native 构建产物。交接模板 `session-closeout/SKILL.md:50` 也明确写了同一事实。KICKOFF 把 `bun install` 写成“必须，否则 eslint exit 127”过度绝对，接手者遇到 lint 正常时会怀疑 worktree 建错，或无谓重跑 install。

**修复建议**：改成“先检查依赖解析；若该 worktree 没有可用 node_modules，再 `bun install`。不要把主树 node_modules 继承当成环境隔离；native gitignored 产物按测试档约定处理”。

## S1–S6 oracle 审计摘要

| 步骤 | 判定 | 说明 |
|---|---|---|
| S1 | 部分有效 | 30/43 可复现；缺默认字符串与旧导出路径 oracle。 |
| S2 | 部分有效 | modelIndex 正样本是好 oracle；consumer 数量与迁移范围漏 tests，端点“逐字节不变”需先保存独立 baseline artifact。 |
| S3 | 假绿风险 | “state 行数下降／不再出现 override 逻辑”是实现形状而非行为；既有测试能锁部分 merge 语义，但文档需列全 7 个 production + 3 个 test direct imports，并加全仓旧表面归零 guard。 |
| S4 | **假绿** | “不改任何测试文件”会阻止必要 test-floor wiring；缺 missing／duplicate participant 与 production/test composition-root oracle。 |
| S5 | 部分有效 | SCC 数字会反映 src 内 type edge，但清单不全；`RepairItem` 可赋值性建议正确。 |
| S6 | **假绿** | 现有 foundation guard 不是严格 allowlist；`computeCircularSnapshot()` 不扫描 moved package。 |

## 交接遗漏的高价值坑点

1. **迁移测试 import 与不改 `setStateForTests` 调用点是两件事。** 文档当前把“测试零 churn”说得过宽，接手者容易保留 state re-export 双轨。
2. **participant registry 是新的 module-global lifecycle。** 必须定义 reset／重复注册／注册顺序／并发测试隔离；否则它会成为下一轮 telemetry deps holder 式跨文件泄漏。
3. **SCC scanner 的根目录是 `src`。** 物理迁包后，原 ratchet 对新包天然失明；这是不先知道就会错误宣称成功的关键坑。
4. **foundation 现有边界是 denylist 且允许 npm external。** 用户这次裁定“只依赖内置”，必须新增更严格的 state 专项契约，不能把 foundation 当前惯例当目标契约。

## 可读性与 KICKOFF 评价

HANDOVER 的章节顺序、证据等级、错误复盘、产物“不证明什么”总体清楚，S1 优先级也突出，没有因篇幅淹没核心路径。主要可读性问题不是冗长，而是几个未定义口径的短句（“域外消费者”“165 个文件”“不改任何测试文件”）看起来比实际更确定，恰好会驱动错误执行。KICKOFF 将这些口径进一步压缩成硬性红线，放大了误导，应在 HANDOVER 修正后同步改写。


---

# 第二轮复审（整改提交 `88df93a8`）

## 范围与总判

- **复审对象**：`88df93a8` 对 HANDOVER/KICKOFF 及 live docs 的整改。
- **本轮 verdict**：**仍需修复 MAJOR 后，才适合交给新会话执行。**
- **本轮新增／残留计数**：MAJOR 3，MINOR 2。
- **已确认的关键改进**：§3.7 完整出边表已补齐；第一轮的 4 个 MAJOR 与 4 个 MINOR 均有实质整改，没有发现“表面改字、机制未改”的敷衍项。

## 第一轮发现落实判定

| 第一轮发现 | 判定 | 复审结论 |
|---|---|---|
| MAJOR-1：S2/S3 消费者口径漏 tests | **已解决** | HANDOVER 已明确 models 为 4 production + 101 tests、resolve 为 7 production + 3 tests；S2/S3 动作栏改为 105／10 个 direct-import 文件全迁。独立 AST 扫描复现相同数字。 |
| MAJOR-2：S4“不改任何测试文件”假绿 | **部分解决** | 已正确缩为“164 个 `setStateForTests` 调用点零改动”，允许并要求改 preload/fixture/credential isolation；补了 production/test 双注册 mutation。但“164 调用点 diff 为空”的具体命令仍会漏大批测试文件，见本轮 MAJOR-1。 |
| MAJOR-3：S6 复用 foundation denylist | **已解决** | 已分成既有包级 denylist + state 两文件专项严格 allowlist，且要求裸 npm 正控来证明新判据真的更严。 |
| MAJOR-4：SCC scanner 搬迁后失明 | **已解决** | 已明确 `computeCircularSnapshot()` 只扫 `src/`，要求 package-wide madge／扩根并做 foundation 相对环正控。 |
| MINOR-1：165 计数不可复现 | **已解决** | 改为基线 164，给出可复现命令并区分 3 个 helpers。 |
| MINOR-2：类型依赖清单不全 | **已解决** | §3.6 明确降级，§3.7 以完整出边表取代；`SeparatorCarrier`、token types、`TokenStoreSnapshot`、`AdaptiveRateLimiterConfig` 均已纳入。 |
| MINOR-3：S1 缺字节／导出 oracle | **部分解决** | 三个 refusal 字符串的逐字 golden + 公共路径引用相等是有效补强；但新增的 separator value/type 也需要对应 contract oracle，且 `toBe` 对字符串不能证明“同一绑定”，见本轮 MINOR-1。 |
| MINOR-4：worktree `bun install` 绝对断言 | **已解决** | peer 已修正，当前 KICKOFF 不再把向上解析 node_modules 的情况写成必然失败。 |

## §3.7 完整性复核

### 独立 AST 枚举

实测命令：

```text
bun - <<'TS'
import ts from "typescript"
// `git show 23e85aba:<file>` → ts.createSourceFile → 枚举顶层 ImportDeclaration
TS
```

结果与 §3.7 的目标集合完全一致：

```text
state.ts：10 个唯一 module specifier
state-defaults.ts：6 个唯一 module specifier（block-layout-contract 同时有 type + value 两条 import）
```

逐项对账：

- `state.ts` #1–#10 全命中，符号集合准确。
- `state-defaults.ts` #11–#16 全命中，#11 的 type/value 双形态准确。
- **差集为空。**

整改者指出 `./adaptive-rate-limiter` 的相对路径伪装是正确的新发现；我第一轮确实没有把相对边纳入 leaf-admission 审计。第一轮的 `rg` 用于符号定义行号，不受多行 import 问题影响；但第一轮类型边判断依赖人工读证，§3.7 的 AST 枚举现在是更可靠的 SSOT。

### 消除路由复核

- #1–#4、#9、#11 type 侧、#12–#14 → S5：成立。尤其 #9 必须反转 owner，不能随 state 物理搬迁。
- #5 → 待裁决 1：成立。
- #6 → 待裁决 3：成立。`packages/token` 已依赖 foundation，反向 import token types 会造包级环。
- #7 → S2：成立。
- #8 → S4：成立，但 S4 通用注册表签名必须彻底擦除 token 类型名。
- #10/#16：同单元内部边，物理同迁可以保留。
- #11 value 侧 → S1：方向成立，但“值+类型这一对迁入新 leaf”的消费接线还需完整 oracle，见 MINOR-1。
- #15 → S1：成立。

### S1 合并两件事后的 SCC 数字

我独立做了组合 PoC：除两个 refusal 字符串外，再把 `SeparatorCarrier` + `DEFAULT_SEPARATOR_CARRIER` 临时迁入零依赖 leaf，并让 `block-layout-contract.ts` import/re-export，再跑 `computeCircularSnapshot()`。

输出仍为：

```json
{"count":30,"members":43}
```

随后对四个变异文件执行 `git checkout --`，状态恢复。因此 HANDOVER “第 2 件应当更低”这一预期不成立；它没有额外削掉 madge 当前枚举的环。正确写法应是“组合 PoC 实测仍为 30/43；不要预设更低，执行期重测”。这是文档事实修正，不影响 S1 一并消除值边的必要性。

## 本轮事实性发现

### [MAJOR] HANDOVER.md:252 — S4 的“164 个调用点 diff 为空”命令会漏绝大多数 tests 子目录，oracle 可假绿

当前写法：

```text
git diff --stat -- tests/ | rg -v 'helpers/|credential-store-isolation' 应为空
```

问题有两层：

1. 它会把所有非 `helpers/`、非 `credential-store-isolation` 的测试文件改动都视为违规，但 S2/S3 已明确、合法地修改约 104 个测试 import。因此在 S4 commit 基于前序 commits 的正常分支上，若不精确限定 diff range／符号调用行，oracle 会被前序测试 churn 污染；若只看 S4 commit，又无法证明 164 个调用点的内容没改，只能证明文件 stat 情况。
2. 更关键的是，“调用点 diff 为空”应该验证 `setStateForTests(...)` 调用表达式，而不是按文件路径排除。实现者可以在既有 test 文件里改变／删除 credential patch，同时文件本来就因 S2 import 迁移被允许改，stat oracle 无法区分，显示通过或被噪声淹没。

**失败场景**：S2 已改 101 个 tests import；S4 顺手把其中一个 `setStateForTests({ copilotToken: undefined })` 删除。按“允许前序 import churn”的人工解释，文件改动被放行；credential clear 语义已回归。

**修复建议**：在 S4 前后用 TypeScript AST 提取并规范化全仓 164 个 `setStateForTests` CallExpression 的 `file + start + argument text/hash`，断言 multiset 相等；或者先生成 committed artifact，再 compare。正控：改一个 credential key／删一个调用必须红。文件 stat 只能做辅助提示，不能作为 oracle。

### [MAJOR] HANDOVER.md:233 — S2 的“环数不回升”咬不住 state re-export 逃生口，文档对 oracle 能力的绝对断言错误

HANDOVER 声称 SCC oracle“专门用来咬 re-export 逃生口，前两条对它全绿”。拓扑推理并不支持这个绝对结论：

```text
state.ts -> models/cache.ts -> state.ts
```

确实会形成两节点环，但在 S1 已从 70 环降到约 30、S2 同时移走 `normalizeForMatching` 及原 models 逻辑边时，**总环数完全可能继续下降或持平**。ratchet 的“只减不增”比较集合而非语义目标；若新增两节点环同时删除更多旧环，`count` 不回升仍可绿。现有 ratchet 会因 new cycle/new member 变红，但 HANDOVER 只写“环数不回升”，接手者可能只比较 count。

**修复建议**：oracle 应明确复用 `circular-deps-ratchet` 的集合差（`newCycles`、`newMembers` 均为空），并加内容断言：不得出现同时含 state 与 models/cache 的 cycle；更直接地，用 AST 禁止 `state.ts` re-export 这些 8 个 symbol，且 production/tests 全部从新 owner import。正控：临时加 re-export + cache→state import，必须红。不要写“count 不回升”。

### [MAJOR] HANDOVER.md:283-284 — S7 doc-sync grep 只能覆盖三种措辞，会在大量 stale state 路径／架构表仍存在时假绿

提议 oracle：

```text
rg -n 'state' docs/ | rg -i '留 core|走不通|reader seam'
```

我实际运行后，命中主要来自 HANDOVER 与评审报告；但更宽的检查：

```text
rg -n 'state.*(core|reader)|core.*state|state-read|reader.*state|src/lib/state' docs/spec/... docs/todo/... docs/DESIGN.md
```

显示还有大量需要 S7 处理的形态，例如：

- `docs/DESIGN.md:187` 活架构表仍把 `src/lib/state.ts` 与 lifecycle 并列；
- `docs/DESIGN.md:325` 仍写 `resolveBufferedCaps` 唯一解析点在 `src/lib/state.ts`；
- backlog 多处硬编码 `src/lib/state.ts` 路径；
- spec 的 core 目录描述、reader 方案虽然有 supersede 注解，仍需按落地结果逐段更新。

这些 stale 事实不一定含“留 core／走不通／reader seam”三个词，所以 oracle 可显示“全处理”但 live docs 仍指向旧文件／旧 owner。

**修复建议**：S7 改为明确文档清单 + 多维 grep：旧路径 `src/lib/state(?:-defaults)?\.ts`、被迁 symbol 名（`resolveBufferedCaps`、`setModels` 等）、旧架构短语、`state 第一`。每个命中逐条 disposition；对 DESIGN/spec/backlog 做 required-file assertion。正控分别放入一个旧路径和旧 owner 描述，两个 detector 都必须命中。

### [MINOR] HANDOVER.md:221-222 — S1 golden 基本到位，但“引用相等 toBe”对字符串不能证明单一 owner，且遗漏 separator contract

三个 refusal 常量都是 primitive string。`expect(a).toBe(b)` 与 `toEqual` 对字符串都只是值相等；两处独立重复字面量也会通过 `toBe`，所以文档“toEqual 对两份独立字面量也会绿”的对比不能推出 `toBe` 能证明 re-export 是同一 binding。单一 owner 应由 AST/export declaration shape 或删除旧定义的 source guard证明。

此外 S1 现在还迁 `SeparatorCarrier` + `DEFAULT_SEPARATOR_CARRIER`，oracle 仍只写“三个字符串 golden”。必须补：

- `DEFAULT_SEPARATOR_CARRIER === "marker_v1"`；
- `SeparatorCarrier` 与 `SEPARATOR_CARRIERS` key union 的编译期一致性；
- `separatorText()`、`makeSyntheticSeparator()` 仍消费同一新 owner；
- 旧 `block-layout-contract`／`assistant-block-layout` 公共 re-export 路径仍可用；
- source guard 确认旧模块不再独立定义这对词汇。

**修复建议**：保留三字符串逐字 golden；把“引用相等”改成“旧路径与新 owner 值相等 + AST 证明旧路径只有 re-export、无重复声明”。为 separator 加上述 value/type/wire oracle，并做 `marker_v1` mutation。

### [MINOR] HANDOVER.md:169-175 — §3.7 标为“机器枚举”，但给接手者的复跑命令仍是 `rg 'from "'`，与声称的 AST SSOT 不一致

表本身经独立 AST 对账是完整的；问题是复跑配方仍可能漏：单行 side-effect import、`import = require`、dynamic import、`import("x").T`，也可能被字符串／注释里的 `from "` 干扰。文档同时建议 S2/S5 使用 AST `allModuleSpecifiers()`，说明已有正确工具。

**修复建议**：把 §3.7 的权威复跑命令改为调用 `tests/architecture/source-ast.ts::allModuleSpecifiers()` 的小脚本，并输出每个 specifier、type/value 形态与 imported symbols。`rg 'from "'` 可留作人工快速浏览，但不能叫“机器完整枚举”。正控至少覆盖 side-effect、type import、ImportType、dynamic import。

## 新 oracle 逐项复核

| 步骤 | 第二轮判定 | 说明 |
|---|---|---|
| S1 | **部分解决** | refusal golden 有效；组合 SCC 实测仍是 30/43，不会“应当更低”；separator value/type contract 未覆盖。 |
| S2 | **部分解决** | 105 文件范围正确；AST old-import 归零好；“count 不回升咬 re-export”是假绝对断言，应改 cycle/member 集合＋内容 guard。 |
| S3 | **已解决** | 10 direct-import 文件准确；禁止 core→routes 与 live-state mutation oracle合理。建议对两个当前无 production consumer 的 max-token resolver记录“只为测试／未来 P1 保留”，避免被误删。 |
| S4 | **部分解决** | composition-root 双 mutation 与注册语义清单很好；164 调用点的 stat oracle仍不具鉴别力。 |
| S5 | **已解决** | §3.7 驱动替代手写清单；#9 adaptive-rate-limiter 已纳入。最终应使用 AST 出边 diff，不用 `from` grep。 |
| S6 | **已解决** | 严格文件 allowlist + 裸 npm 正控 + package-wide madge 正控，闭合第一轮两条 MAJOR。 |
| S7 | **未解决** | 当前 grep 维度过窄，旧路径／旧 symbol owner 可残留而 oracle绿。 |

## 本轮新遗漏坑点

1. **S1 新 leaf 的命名与归属不能随意挂在 `refusal-policy.ts`。** 我的组合 PoC 为快速测量把 separator 临时塞进 refusal-policy，仅用于验证环数；真实实现应建独立通用 block-layout vocabulary leaf，避免 refusal 域名实不符。
2. **两个 max-token resolver 当前没有 production external consumer。** S3 将它们搬到 `config/model-overrides.ts` 是用户范围内的结构迁移，但接手者可能看到“无 consumer”就删除。文档应明确它们由 tests／未来 P1 contract 保留，不得以 YAGNI 删除。
3. **S7 必须同步 symbol owner，而不只是 state 位置。** `resolveBufferedCaps`、models cache owner、StateSnapshot participant 都会在 docs 中留下旧 cross-reference；只扫 state 架构短语不够。

## 第二轮总评

整改显著提高了交接质量：§3.7 现在确实完整，consumer 范围、token 分层、strict boundary、package-wide SCC 盲区均被正确暴露。**但当前仍不宜直接交给新会话执行**，因为 S2、S4、S7 各有一个会明确假绿的 oracle；S1 新增 separator 工作也尚未有等价 contract oracle。修复上述 3 个 MAJOR，并补两项 MINOR 后，可进入执行会话。


---

## 第三轮：修复确认

**复审提交**：`2919c26c`。

### 第二轮发现的最终判定

| 第二轮发现 | 判定 | 说明 |
|---|---|---|
| MAJOR-1：S4 stat oracle 无鉴别力 | **部分解决** | 改成 AST CallExpression 实参比较，已经能咬住单点删键／改键，方向正确；但“全仓全局 multiset”丢失 `file + call ordinal` 身份，两个调用交换整份实参时 multiset 不变，调用点语义却已改变。若红线真是“调用点零改动”，需比较 `file + lexical call index + normalized argument text` 的 keyed snapshot，而不是只有实参全局 multiset。另：基线实测不是“164 个调用点”，而是 164 个 test 文件提到该符号；AST 实测为 159 个含直接调用的文件、622 个直接 CallExpression。文档应区分文件数与调用数。 |
| MAJOR-2：S2 count 不回升咬不住 re-export | **已解决** | 已改为 ratchet 的 `newCycles/newMembers` 集合差 + state/models-cache 内容断言，并增加 `state.ts` 禁止 re-export 8 符号的直接 AST 判据；正控形状具鉴别力。 |
| MAJOR-3：S7 grep 维度过窄 | **已解决** | required-file 清单 + 旧路径／旧 owner／旧架构短语／排序清单四维检索，且每维有正样本要求，已覆盖上一轮指出的盲区。 |
| MINOR-1：S1 `toBe` 不能证明 owner，separator contract 缺失 | **已解决** | 已改为 AST 证明旧模块只 re-export、无重复声明；separator 的值、类型 union、两个消费者、旧公共路径均纳入 oracle，并要求 mutation。 |
| MINOR-2：§3.7 权威复跑仍用 grep | **部分解决** | HANDOVER 已正确把 `allModuleSpecifiers()` AST 脚本定为权威，并将 `rg 'from "'` 降为浏览。但 KICKOFF:24 仍把 `rg -n 'from "' ...` 写成动手前的“§3.7 出边枚举” gate，接手会话复制 KICKOFF 后仍可能执行不完整检查。应同步改为 AST 命令，或只写“按 HANDOVER §3.7 的 AST 枚举复跑”。 |

### `state.ts ↔ state-defaults.ts` 两节点环预案

- **选项 (b) 成立，并且是本项目判据下的推荐方案。** 建议新文件命名为职责明确的 `state-contract.ts`／`state-types.ts`，由 `state.ts` 与 `state-defaults.ts` 单向依赖，从根上消除互指。
- 文档写“12 个类型”不准确：当前 `state-defaults.ts` 从 `state.ts` 直接 import **11 个名字**。其中 `MaxTokensContinuationConfig` 又依赖 4 个策略／visibility type alias；抽取时必须搬完整传递闭包，而非机械只搬 import list，否则第三文件仍要反向 import state，环会复活。
- 还需保持 `~/lib/state` 的原公共类型表面：`state.ts` 应从新 contract re-export 这些类型，且 package-wide madge 与 public API/typecheck oracle共同验证。
- **选项 (a) 显式豁免技术上诚实，但不应与 (b) 并列称为同等“正当”终态。** 它保留一个已知内部环，与本项目“只减不增、长远架构健康优先”的裁判轴冲突；除非用户明确裁定允许该环，否则应采用 (b)，而不是因“最省”选 (a)。

### 最终 verdict

**当前仍不建议直接交给新会话执行。** 主要未闭合项是 S4 AST oracle 仍丢失调用点身份，存在交换实参后假绿；另有 KICKOFF 的旧 grep gate 未同步。修复方式都很局部：S4 snapshot 加 `file + call ordinal` 键，KICKOFF 改指 AST 枚举；同时把两节点环方案明确推荐 (b) 并补“11 个直接类型 + 传递类型闭包”说明。完成后即可交接执行，无需再重做主体调研。


## 第四轮：收尾确认

S4 的 keyed AST snapshot 与 §3.7/KICKOFF 的 AST gate 均已解决；S5 的 `state-vocabulary.ts` 方案也正确吸收 11 个直接类型及其传递闭包，并保留不会造回边的 type re-export。**唯一未同步项**：`KICKOFF.md:53` 仍写该环“S1–S5 碰不到、S6 有两个正当选项”，与 HANDOVER 已改为“S5 拆环、S6 推荐回 S5”的最终路线冲突。

**最终 verdict：修正 KICKOFF.md:53 后即可交给新会话执行；当前这一个入口级矛盾修正前，仍不建议交接。**
