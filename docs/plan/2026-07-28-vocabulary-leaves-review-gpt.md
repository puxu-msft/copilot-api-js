# 词汇叶子与 barrel 纪律计划评审

## 评审范围、证据与结论

- **评审范围**：`/home/xp/src/copilot-api-js/docs/plan/2026-07-28-vocabulary-leaves-and-barrel-discipline.md`（提交 `693e3b73`），重点核验 §2 数字、§3 结构论断、N1/N2 oracle 与正控、§2 PoC 能力边界、§6 排除项。
- **核验基线**：按计划指定，从 `65c5654c` 创建 detached worktree `/tmp/vocabulary-leaves-review-gpt`；没有写入同伴的 `/home/xp/src/copilot-api-js/.worktrees/state-foundation`。核验完成后先确认 `git status --porcelain` 为空，再移除 detached worktree。
- **已读取的关键证据**：目标计划；`tests/architecture/circular-deps-{snapshot,ratchet}.unit.test.ts`；`tests/architecture/source-ast.ts`；`tests/architecture/package-boundaries.unit.test.ts`；三个诊断类型 owner；`context/types.ts`、`history/types.ts`、`history/state.ts`；error／observability barrels；foundation package exports；前一轮 state→foundation 的 GPT／Claude 评审；monorepo spec 与 deferred backlog。
- **已执行的关键命令**：四阶段 `computeCircularSnapshot()` PoC；snapshot 集合差；`bun run typecheck` 的两个计划原文 import 探针；TypeScript AST 的 import／declaration／consumer 枚举；`bun test tests/architecture/circular-deps-ratchet.unit.test.ts`；vendor SCC 参与度与跨域 import 扫描。
- **总体 verdict**：**修复 MAJOR 后可进入下一阶段**。四组数字本身全部可复现，但当前 N1/N2 按原文无法同时通过 typecheck 与既有 SCC ratchet；结构解释、guard 定义和工作量口径也有实质缺口。
- **BLOCKER 数量**：0。
- **发现计数**：MAJOR 7，MINOR 2，NIT 0。

## 已独立确认成立的关键事实

1. **§2 四组数字全部正确。** 在 detached worktree 中，先跑原树，再按 §2 逐阶段只改五条诊断类型 import、`ApiError` import、`ScopedPublisher` import，并每阶段执行：

```text
bun -e 'import { computeCircularSnapshot } from "./tests/architecture/circular-deps-snapshot.ts"; const s=await computeCircularSnapshot(); console.log(JSON.stringify({count:s.count,members:s.members.length}))'
```

实际输出：

```text
base 43 50
A    19 29
B    18 29
C    18 27
```

这里 C 使用实际可解析的 `../observability/bus` 才能表达计划意图；计划原文的 `./bus` 不存在，详见 MAJOR-1。

2. **两个物理 owner 前提成立，但计划把“物理 owner”误写成了“可按给定 specifier 导入”。** 实际命令：

```text
rg -n '^export (interface|type) (ApiError|ScopedPublisher)' packages/foundation/src/error/classify.ts src/lib/observability/bus.ts
```

输出：

```text
packages/foundation/src/error/classify.ts:30:export interface ApiError {
src/lib/observability/bus.ts:73:export interface ScopedPublisher<NS extends EventNamespace> {
```

3. **“三个诊断类型只触达少数文件”的方向成立。** 全树 `rg -l -w <symbol> --glob '*.ts'` 得到出现文件数 `3 / 3 / 4`；但这包含定义 owner，严格的消费文件数是 `2 / 2 / 3`，详见 MINOR-1。

4. **“vendor 目录当前不是 SCC 成员”这一窄断言成立。** 对原始 `computeCircularSnapshot()` 结果执行 `cycles.filter(c => c.includes('/lib/anthropic/') || c.includes('/lib/openai/') || c.includes('/lib/gemini/'))`，三个 vendor 的结果均为 `0`。但它不能推出“必须先做 N1–N3，vendor 才拆得动”，详见 MAJOR-7。

## 事实性发现

### [MAJOR] `/home/xp/src/copilot-api-js/docs/plan/2026-07-28-vocabulary-leaves-and-barrel-discipline.md:20-21,54-55,82` — N2 给出的两个“直取”specifier 都不能通过 typecheck

**实际命令与输出**：

```text
# 只把 context/types.ts 改成计划原文：
# import type { ApiError } from "@hsupu/ghc-proxy-foundation"
bun run typecheck
```

输出：

```text
src/lib/context/types.ts(8,15): error TS2305: Module '"@hsupu/ghc-proxy-foundation"' has no exported member 'ApiError'.
```

`packages/foundation/src/index.ts` 只有 11 个 `export *`，没有导出 `./error/classify`。我随后实测 `@hsupu/ghc-proxy-foundation/error/classify`，`bun run typecheck` 输出为空、exit 0。

```text
# 只把 history/state.ts 改成计划原文：
# import type { ScopedPublisher } from "./bus"
bun run typecheck
```

输出：

```text
src/lib/history/state.ts(1,38): error TS2307: Cannot find module './bus' or its corresponding type declarations.
```

`history/state.ts` 的同目录没有 `bus.ts`；真实 owner 是兄弟目录 `src/lib/observability/bus.ts`，对应相对 specifier 为 `../observability/bus`。

**失败场景**：执行者逐字完成 N2 后，SCC 数字会因为 madge 只看字符串与路径图而显得改善，但 TypeScript 构建立即失败。计划将“类型已住在某文件”错误地等同于“包根／当前目录已暴露该路径”。

**具体修法**：把 `ApiError` 方案明确改成二选一并固定唯一契约：要么从已实测可用的 `@hsupu/ghc-proxy-foundation/error/classify` 直取，要么先让 foundation 根 `index.ts` 有意导出 error surface，再从包根取；把 `ScopedPublisher` 改成 `../observability/bus`。同步重跑 B/C snapshot、typecheck 和 guard 正控，不能只修文案路径。

### [MAJOR] `/home/xp/src/copilot-api-js/docs/plan/2026-07-28-vocabulary-leaves-and-barrel-discipline.md:70,75-77,84` — N1 的“19/29 + ratchet 绿”当前互相冲突；环数下降掩盖了新 canonical cycle 集合

**实际命令与输出**：我按 `circular-deps-ratchet.unit.test.ts:47-63` 的同一算法，将每个 PoC snapshot 与 `65c5654c` 的 base snapshot 做集合差：

```text
for stage in A B C:
  newCycles = stage.cycles.filter(c => !base.cycles.includes(c))
  newMembers = stage.members.filter(m => !base.members.includes(m))
```

输出：

```text
A: count=19, members=29, newCycles=4, newMembers=[]
B: count=18, members=29, newCycles=4, newMembers=[]
C: count=18, members=27, newCycles=8, newMembers=[]
```

既有 ratchet 原树实测：

```text
bun test tests/architecture/circular-deps-ratchet.unit.test.ts
2 pass
0 fail
Ran 2 tests across 1 file. [4.90s]
```

但 N1 PoC 的 `newCycles=4` 会直接触发该测试 `expect(newCycles).toEqual([])`。原因不是 N1 真造了新依赖边，而是 madge 的 `circular()` 返回一组非完备 cycle 枚举；删边后，它会改选此前未列出的既存 cycle 作为 canonical 输出。因此“cycle 字符串必须是旧集合子集”不是一个对删边单调的 oracle。

更直接的计数反例来自 B→C：

```text
countB=18
countC=18
removedCycles=6
addedCycles=6
sameSet=false
removedMembers=["src/lib/diagnostics/index.ts","src/lib/diagnostics/logger.ts"]
```

同一个 `18` 完全隐藏了 6 出 6 进；所以 §23 的“C 只削 2 成员”、N1 的约 19 和任何“环数不回升”都不能承担集合正确性。

**失败场景**：按计划完成 N1 后，数字完全命中 19/29、typecheck／业务测试也可能绿，但既有架构 ratchet 必红；若执行者为了过门禁重冻 baseline，又会把 4 个“新枚举出来的旧环”误判成新增环接受。反过来，只看 count 则可能放过真新增环被同量删环抵消。

**具体修法**：在执行 N1 前先修 ratchet 的数学对象。推荐从 madge dependency graph 计算 SCC member 集与 SCC 内 directed edge 集，并对“新增 cycle member／新增 SCC 内 edge”做集合差；或者使用能完备枚举 simple cycles 的算法后再证明规模可控。为 guard 加三类正控：新增一条 SCC 内回边必须红；删一条边后即使 cycle 枚举重排也必须绿；一删一增使 count 不变时必须红。计划中的数字仅保留为观测结果，不再作为 gate。

### [MAJOR] `/home/xp/src/copilot-api-js/docs/plan/2026-07-28-vocabulary-leaves-and-barrel-discipline.md:74-76` — N1 的 source guard 没有定义，正控目前不可执行

**实际命令与输出**：

```text
rg -n -i 'source guard|duplicate|重复|owner' docs/plan/2026-07-28-vocabulary-leaves-and-barrel-discipline.md
```

与 guard 有关的唯一命中是：

```text
76: ... source guard 必须变红。
```

仓库现有 `source-ast.ts` 提供 `publicExportNames()`、`allModuleSpecifiers()` 等基础 helper，但计划没有指定将新增哪个测试、扫描哪三个 owner、何种 declaration／re-export 形状算合法，也没有把“新增 source guard”列进 N1 的“做什么”或验收判据。正控要求一个尚不存在、且语义未定义的机制变红，执行者无法据此判断是先写 guard、写哪种 guard，还是用人工 grep。

**失败场景**：实现者搬走类型并 re-export，环数／typecheck／全后端全绿，但旧 owner 仍留一份同名 interface；因为没有实际 test，所谓正控没有可运行对象，单一 owner 契约假完成。

**具体修法**：把 N1 明确拆成“先建 AST guard，再搬迁”。guard 对三个 owner 分别断言：禁止本地声明目标 type 名；必须存在指向选定 vocabulary leaf 的精确 `export type { … } from`；leaf 必须是唯一 declaration owner；旧公共路径的编译期 import fixture 必须通过。先在未迁代码上跑出预期 red，再迁移变绿；随后临时恢复一个独立 declaration，确认同一测试因“重复声明”这一明确原因变红，再还原并确认绿。

### [MAJOR] `/home/xp/src/copilot-api-js/docs/plan/2026-07-28-vocabulary-leaves-and-barrel-discipline.md:82-86,100` — N2 的“owner 属于 barrel”谓词未定义，两个样本只排除最粗的一刀切，不能证明 provenance 判定正确

**实际命令与输出**：我用 TypeScript AST 枚举 `src/lib/**/index.ts` 内的直接 type/interface/class/function/variable declarations。与目标有关的结果是：

```text
src/lib/error/index.ts:        direct declarations = []
src/lib/observability/index.ts: direct declarations = []
```

两者全部是 re-export facade。`observability/index.ts` 的 `ScopedPublisher` 来自 `./bus`，事件类型来自 `./events`；`error/index.ts` 的 `ApiError` 来自 foundation alias。因而“barrel 自己拥有的类型”在这两个目标 barrel 中没有现实正样本。单文件 syntax AST 也不能仅凭 consumer 的 `import { X } from barrel` 知道 X 的最终 declaration owner；它需要解析 barrel re-export、alias、`export *`、多跳和 package exports。

计划的两个正样本最多证明“守卫不是禁止该 module specifier 的 blanket ban”：一个错误实现只要硬编码放行样本 ② 的名字、却把所有其他 re-export provenance 判错，两个样本仍全绿。它们也没有覆盖 alias import、namespace import、`export { X } from barrel`、`import("barrel").X`、star re-export 与多跳 re-export。

**失败场景**：guard 把 `ScopedPublisher` 识别为“observability barrel 的 public export，所以归 barrel 所有”，从而放行原违规；或者相反，把所有 re-export 都视为非 owner，导致目标两个 barrel 的全部 type surface 被禁止。计划给出的两个字符串 fixture 都可能继续绿，因为它们没有接入真实多文件 provenance 图。

**具体修法**：先把 owner 定义成可机器判定的不变量，例如“最终 declaration file”或“显式登记的 public facade owner”，二者不能混用。若采用最终 declaration file，使用 TypeScript `Program`／checker 解析 alias symbol 到 declaration source file，并用真实多文件 fixture 覆盖 named alias、namespace、star、多跳、package root/subpath；若采用显式 facade ownership，则维护 `barrel -> allowed symbol -> declaration source` 的清单，新增 export 默认红。正控至少要有：真实 `ApiError`／`ScopedPublisher` 违规；barrel 内直接声明的合法 type；多跳或 alias 仍违规；未知新 re-export 默认红；合法样本不误伤。

### [MAJOR] `/home/xp/src/copilot-api-js/docs/plan/2026-07-28-vocabulary-leaves-and-barrel-discipline.md:82-86,100` — N2 被写成“两条 import 的低风险动作”，但按其“全仓无同型穿透”契约，当前两个 barrel 已有数十个既存违规

**实际命令与输出**：我用 AST 枚举所有从目标 barrel 进行的 type-only named imports：

```text
~/lib/error:         26 个 import declaration
  其中 25 个取 ApiError，1 个取 ErrorWireFormat
~/lib/observability: 17 个 import declaration
  涉及 ScopedPublisher、ObservabilityBus、ObservabilityEvent、FeatureKind、AttemptSnapshot、RequestContextSnapshot 等
```

例如 `ApiError` 不只在 `context/types.ts`，还在 `pipeline/types.ts`、`context/request.ts`、两处 anthropic 文件、多个 retry strategy 等；`ScopedPublisher` 不只在 `history/state.ts`，还在 `context/{manager,request}.ts`、`diagnostics/logger.ts`。所有这些 symbol 的 declaration owner 都不在 barrel 文件本身。

**失败场景**：若 guard 真执行 §83 的一般规则和 §84 的“全仓无同型穿透”，N2 不是改两行，而是至少要处置上述 43 个 import declaration；只改计划列出的两处后，guard 会大面积红。若为了保持“低风险”而仅 hardcode 两个文件，则它不再满足“全仓扫同型穿透”和“全覆盖不复发”的倾向理由。

**具体修法**：在用户裁决 §5 的 guard 覆盖面之前，先把两个选项的真实 blast radius 写全：即使只钉 error／observability 两个 barrel，也需列出现有 symbol×consumer inventory 与逐项 disposition；若只禁止 `ApiError`／`ScopedPublisher` 两个 symbol，也要明确这是 symbol-scoped guard，不得声称“全仓无同型穿透”。执行计划按选定契约迁移全部既有违规，并为“当前违规集合归零”建立 committed AST fixture／清单，而不是只写两条已知改动。

### [MAJOR] `/home/xp/src/copilot-api-js/docs/plan/2026-07-28-vocabulary-leaves-and-barrel-discipline.md:27-38,59-66,104-106` — §3 把“可由 type edge 切断”写成“整条长环全是 type-only”，且对剩余 18 环的地图明显不完整

**实际命令与输出**：对 baseline graph 的每条 cycle edge 回查 import/export AST，结果是：

```text
cycles=43
allEdgesType=1
hasValue=42
unknown=0
cyclesThroughTargetTypeEdges=28
```

所以 43 环中只有 1 环的所有边都是 type-only；其余 42 环都同时含 value edge。目标 type edge 确实是有效 cut edge，但“逐条看那些边引用的是什么，全是 import type”不成立。例如计划展示的长链中：

```text
buffered-merge-reducer -> pipeline/frame-origin  是 value import tagFrameSynthetic
error/index -> error/forward                    是 value re-export forwardError/mapHttpErrorToEnvelope
history/store -> entries/state/...              是 value re-export
```

“26 个环穿过同一条长环”也混合了两个口径：精确有 26 个 cycle 含相邻边 `context/types -> error/index`，但只有 22 个同时包含文档展示的完整主干；另 4 个分别走 shutdown/ws、短 `context/request` 环等路径。

C 后我实际打印全部 18 个 cycle。除 §3.3 所说 observability/history 外，还明确存在：

```text
codec/anthropic/anthropic-cell <-> pipeline/cell-assembly
codec/openai-cc/openai-cc-cell <-> pipeline/cell-assembly
codec/openai-responses/openai-responses-cell <-> pipeline/cell-assembly
context/activity-summary <-> context/request
history/v3/projection <-> history/v3/store
pipeline/rewrite-registry <-> pipeline/types
transport/http2-client <-> transport/upstream-fetch
tui/render/detail <-> tui/render/panel
```

`error/index -> error/forward` 的 4 环计数则独立复现为：base 29、A 5、B/C 4。

**失败场景**：下一轮按“剩余集中在两处”设计，只处理 events/context 与 history publisher，完成后仍会留下 codec、transport、TUI、pipeline 等多个独立 SCC；同时“全是 import type”的措辞会诱导执行者用搬类型的同一修法处理实际 value edge。

**具体修法**：把标题改为“多数当前 cycle 可由少数 type-only cut edge 切断”，明确区分 cycle 内存在的 value edge与本轮选择切断的 type edge。用机器生成的表列出：target edge、经过该 edge 的 cycle 数、切断后 removed/new canonical cycles、剩余 SCC／cycle 分组。§3.3 和 §6 必须列全 C 后的所有剩余簇及 disposition，不能把未列出的簇隐含归入两处。

### [MAJOR] `/home/xp/src/copilot-api-js/docs/plan/2026-07-28-vocabulary-leaves-and-barrel-discipline.md:10-12,105,110` — “不做 N1–N3，vendor 纵切 day-1 走不通”没有被当前实验或 graph 数据证明

**实际命令与输出**：对 baseline snapshot 统计 vendor 路径参与 cycle：

```text
anthropic cycles=0 members=[]
openai    cycles=0 members=[]
gemini    cycles=0 members=[]
```

这只证明狭义事实：三个 vendor 目录当前不是 madge 枚举的 cycle member，所以它们不是这 43 环的承重节点。另一方面，源码扫描确实得到 vendor 对 core 域的多条出边，例如：

```text
src/lib/gemini/convert-stream.ts -> ~/lib/history/types
src/lib/openai/upstream-ws-attempt.ts -> ~/lib/pipeline/types, ~/lib/models/client
src/lib/anthropic/tool-input-repair-stats.ts -> ~/lib/context/types
src/lib/anthropic/continuation-builder.ts -> ~/lib/pipeline/*
```

但计划没有做 vendor extraction PoC、没有列出 vendor package 的全部出边，也没有证明这些边在 N1–N3 后会消失。事实上 N1 只处理三个诊断 type，N2 只处理 barrel imports；上述多数 vendor 出边不会改变。因此“当前不是承重点”与“当前拆不动”是两个不同命题，现有证据只支持前者。

**失败场景**：团队据此把 backlog 已明确排在 state 后的 vendor 纵切推迟到“§6 第一条做完以后”，但后续处理 observability/history 可能与 vendor 可提取性无关；反之 vendor 中已有可直接剥离的叶子会被一个未经 PoC 的绝对顺序挡住。

**具体修法**：保留已验证的窄结论“vendor 目录当前不参与 SCC，因此本轮减环收益为 0”；删除“必须先做／day-1 走不通”的绝对断言，除非补一个最小 vendor extraction PoC：机器枚举全部 package 出边、按可注入／可下沉／必须留 core 分类，并实测当前树与 N1–N3 后树的差集。若 PoC 显示 N1–N3 不改变 vendor blockers，应把 vendor 纵切作为独立并行／后续单元，而不是伪因果地排在本计划之后。

## 次要事实性发现

### [MINOR] `/home/xp/src/copilot-api-js/docs/plan/2026-07-28-vocabulary-leaves-and-barrel-discipline.md:48` — “各自 3–5 个消费文件”把 owner 计入了 consumer，且上界 5 无基线来源

**实际命令与输出**：

```text
rg -l -w BufferedMergeDiag . --glob '*.ts'     -> 3 files
rg -l -w BlockLayoutRepairStats . --glob '*.ts' -> 3 files
rg -l -w SendMessageNormalizationDiag . --glob '*.ts' -> 4 files
```

逐项文件表明其中各有 1 个 declaration owner，所以严格 consumer 数分别为 `2 / 2 / 3`；若想表达“出现该 symbol 的文件数”，则应写 `3 / 3 / 4`。没有任何一项是 5。

**具体修法**：写清口径并给精确数字，例如“定义外的 direct consumer files 为 2／2／3；含 owner 的 symbol-occurrence files 为 3／3／4”，附可复跑命令。不要用 3–5 的模糊范围掩盖 owner／consumer 区别。

### [MINOR] `/home/xp/src/copilot-api-js/docs/plan/2026-07-28-vocabulary-leaves-and-barrel-discipline.md:19,25,74` — N1 的动作栏说“消费端零改动”，但取得 19/29 必须改 `history/types.ts` 与 `context/types.ts` 的 5 条 import

**实际命令与输出**：原树目标 imports：

```text
context/types.ts: BufferedMergeDiag + SendMessageNormalizationDiag，共 2 条
history/types.ts: BufferedMergeDiag + BlockLayoutRepairStats + SendMessageNormalizationDiag，共 3 条
```

我只新增 leaf 和 owner re-export、不改这 5 条 consumer imports 时，旧 type edge仍存在；§2 自己也明确 A 是“5 条 import 改指叶子”才得到 19/29。因此“owner re-export（消费端零改动）”若被执行者按字面采用，会保住旧边。

**具体修法**：把 N1 动作明确拆成两组 consumer：`history/types.ts`／`context/types.ts` 这 5 条承重 import 必须改指新 leaf；其余依赖旧 owner 公共路径的消费者零改动，由 owner re-export 保持兼容。验收增加 AST 断言：这两个 type module 不得再 import 三个实现 owner。

## §2“这些 PoC 没有证明什么”的完整性判定

现有段落对“未 typecheck、未跑测试、未处理 re-export／重复定义”的披露是诚实的，但仍不完整。它至少还没有证明、且应显式补入以下三项：

1. **没有证明计划给出的最终 import specifier 可解析。** 实测两个原文 specifier都 typecheck 失败，见 MAJOR-1。
2. **没有证明 SCC 只减不增或既有 ratchet 可绿。** 数字虽然下降，但 A/B/C 相对 base 分别出现 4/4/8 个 new canonical cycle string，见 MAJOR-2。
3. **没有证明“剩余环只集中两处”或 vendor 必须排在本计划之后。** C 的完整 cycle 表和 vendor dependency surface 都未被 PoC 覆盖，见 MAJOR-6／7。

此外，“环数是唯一被证明的东西”不精确：PoC 同时直接测得 member 数；更重要的是，环数不是足以承担正确性的 oracle。建议改成“PoC 仅证明在这组临时 source edits 下，madge 当前枚举得到表中的 count/member count；不证明集合单调性、可编译性、公共导出、行为等价或后续可提取性”。

## N1／N2 oracle 总表

| Oracle／正控 | 判定 | 原因 |
|---|---|---|
| N1 `19/29` | 数字可复现，但不能作 gate | 命中数字时 ratchet 仍出现 4 个 new canonical cycle；count 不具集合鉴别力。 |
| N1 旧公共路径可用 | 必要但不充分 | 可证明兼容 import，不能证明 leaf 是唯一 owner。 |
| N1 source guard 正控 | **不可执行** | guard 没有定义或列入产物。 |
| N1 全后端绿 | 必要但不充分 | 不保证无重复 declaration，也不保证 SCC 集合单调。 |
| N2 全仓无同型穿透 | 契约未闭合 | “owner”未定义，当前两个 barrel 已有 43 个 type-only import declaration 需要 disposition。 |
| N2 “错误 import 应咬”样本 | 弱 | 只能证明检测器能拒绝一个字符串形状。 |
| N2 “合法 owner import 不应咬”样本 | 当前无真实 fixture | 两个目标 barrel 都没有直接 owner declaration，且单文件 AST 无法解析最终 provenance。 |
| N2 环不回升 | **假绿** | B→C count 同为 18，但 cycle 集合 6 出 6 进。 |
| 既有 ratchet 集合差 | 当前会假红 | madge 非完备 cycle 枚举在删边后重选 cycle，N1 会产生 4 个“新字符串”。应改测 SCC member／SCC 内 edge。 |

## 主观建议

未新增主观建议。上述问题均可由当前代码、snapshot 或 typecheck 直接证实；§5 的两项用户分叉未代替用户裁决。就计划给出的倾向理由本身，按域拆 vocabulary 的“保留域内聚”理由成立，但不影响本报告对 N1 guard 和五条承重 consumer import 的要求。
