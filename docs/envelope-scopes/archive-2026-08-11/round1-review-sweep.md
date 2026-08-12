# 69bea997 机械扫掠评审 —— 静默内容丢失 / 错误改写（第 1 轮：仅 blocker）

评审对象：`69bea997`（是 master 祖先，master 已前进 12 提交至 `5272af0e`）。本轮独占角度：脚本转换器是否静默吞内容 —— 简写属性、条件展开、顺序语义反转、键落错作用域。

**blocker: 0**

四类目标缺陷的机械判据都跑完了，都无命中：

- **键落错作用域**：AST 扫新版全部 114 文件里所有 `request:` / `candidate:` / `attempt:` 对象字面量，外加 `Object.assign(env.request, …)` 与 `env.<scope>.x =` 赋值点，逐键比对 `src/lib/pipeline/envelope.ts` 三个 interface 的成员集 —— **0 处错位**。四个 codec 的 parse 供料对旧 `requestState` 逐字段对齐（anthropic：`truncateBaseline`/`clientRequestHeaders`/`preprocessInfo`/`sourceToolNameMapper`/`clientAnthropicBeta` → `request`，`betaProbe`/`resanitize` → `candidate`），无丢失也无多加。
- **条件展开被吞**：diff 中 `-` 侧的条件展开逐条对账 `+` 侧，全部有对应物；无对应的只剩被整体删除的 `with()` builder（`init.*`）与 `snapshotStableState`（`source.*`），属有意删除。
- **顺序语义反转**：新版含作用域键的字面量中「spread 位于显式键之后」共 9 处，逐处确认 spread 带的键与前面的显式键**不相交**（都是 `...(routeOverride && { routeOverride })` 一类），无覆盖冲突。旧版 28 处 `spread-then-override` 逐处追踪去向：`tests/pipeline/driver.unit.test.ts:200/237/280` 与 `tests/pipeline/candidate-renderer.unit.test.ts:137/170` 都已改写成赋值语句，方向正确。
- **简写属性被吞**：AST 逐文件比对对象字面量键计数（简写与 `key:` 同等计入），唯一下降项全部落在已记录的有意删除（`with` / `requestState` / `responseState` / `createResponseState`）或上面那两处已迁为赋值的。

辅助判据：全仓已无残留的扁平读（`env.body` / `env.targetEndpoint` / `env.requestState` 等）；每个测试文件的 `expect(` 计数与用例名集合都无非预期减少。

不属于本轮角度、已由另两位评审覆盖的两条（`forkEnv` 共享 body、`config-snapshot` 文本守卫可绕过），本报告不重复。

本轮扫出的 major/minor 及完整范围说明留到下一轮，其中一条已用 `/tmp` 探针实测确证：`tests/pipeline/driver.unit.test.ts:734` 的 `migratedEnv` 丢了 `legSupplyReady`。

---

# 第 2 轮：major / minor（`legSupplyReady` 那条已由 `25a24f68` 修复，不重复）

## 事实性发现

**[major] docs/DESIGN.md:92 —— 活的架构现状表仍描述被本次提交删掉的机制** —— 该行写「driver cell-keyed hybrid fork `migratedCell(env)`（`env.requestState` 存在性 + `isCellMigrated` 判别）」与「请求生命周期稳定态住 `env.requestState`」，并把 `src/lib/pipeline/{cell-assembly,driver,request-state}.ts` 列为归属文件；判别器已换成 `driver.ts:392` 的 `env.request.legSupplyReady`，`request-state.ts` 已删除。`git show --name-only 69bea997 | rg '^docs/'` 为空 —— 本次 114 文件扫掠一份文档都没同步。DESIGN.md 是 CLAUDE.md 声明的「当前活/退役路径以此为准」，照它实现会写出引用已删模块的代码。同行还需改「稳定态住 requestState」→ `request` 作用域。

**[minor] docs/DESIGN.md:152 —— 模块表把隔离对象写成 `requestState`** —— 「`CandidateStateFactory` … 为每个 primary/hedge/recovery 隔离 requestState」；实际隔离的是 `CandidateScope`（`candidate-state.ts:56` 起 `const source = env.candidate`），而 `request` 作用域现在是**刻意按引用共享**的（破坏性变更 4），语义正好相反。

**[minor] tests/architecture/circular-deps-baseline.json:28,79 —— SCC ratchet 基线未重冻结** —— 基线仍把已删除的 `src/lib/pipeline/request-state.ts` 列为环成员（:79）并保留一条穿过它的环路径（:28）。ratchet 只查「新增成员/新增环」（`circular-deps-ratchet.unit.test.ts:50-51`），所以不会红，但这两条陈旧条目**永久白名单**了该模块与该环路径。CLAUDE.md 要求降环后跑 `bun run scripts/update-circular-deps-baseline.ts` 重冻结，本次未跑。

**[minor] src/ 内 18 处注释仍指向 `env.requestState`** —— 逐处已核实：`src/lib/codec/openai-cc/openai-cc-cell.ts:70` 是**运行时错误消息**（`env.requestState.responsesFallbackScratch missing`），读的却是 `env.candidate.responsesFallbackScratch`（:68），排障时会把人引向不存在的字段；其余 17 处为文档注释（`anthropic-cell.ts:63`、`cc-family-strategies.ts:9`、`openai-cc-cell.ts:9,66,125`、`gemini/codec.ts:150,232`、`openai-cc/codec.ts:175`、`anthropic/codec.ts:22`、`anthropic-leg.ts:11`、`openai-responses-leg.ts:95`、`pipeline/types.ts:1033,1066`、`driver.ts:736`、四个 `handler-v4.ts`）。anthropic-cell 的同类消息已改（`throwMissing`），此处漏改。

**[minor] tests/pipeline/cell-assembly.unit.test.ts:163,217 —— 两个假体缺 `candidate` 作用域** —— 同文件其余四个假体（:148/:189/:207/:259）都带 `candidate`，这两个没有。当前这两条走的 cc-family 分支只读 `env.request.truncateBaseline`，所以绿；但生产侧有多处**非可选**读法（`openai-cc-cell.ts:68`、`anthropic-cell.ts:65/73/122`、`openai-responses/codec.ts:244` 的 `candidateEnv?.candidate.x`），任一 cell 日后取用即 TypeError 而非断言失败。补 `candidate: {}` 即与真实 envelope 同形。

## 范围说明（扫了什么 / 没扫什么）

- **文件集**：`git show --name-only 69bea997` 全部 114 个文件（97 个 `.ts` 参与 AST 分析；无其他类型）。另对全仓（排除 `node_modules`、`ui/`、`ui-v4/`）做了残留扁平读与 `requestState` 引用的文本扫描。
- **AST 判据**（TypeScript 5.9.3 编译器 API，非正则）：①逐文件对象字面量键计数 old vs new，简写属性与 `key:` 同等计入；②新版所有 `request`/`candidate`/`attempt` 字面量的键 × `envelope.ts` 三 interface 成员集的归属比对；③spread 相对显式键的位置 + spread 带入键与显式键是否相交（顺序反转）；④条件展开 `...(c && {k})` / `...(c ? {} : {k})` 递归展平后计入键集。
- **文本判据**（明确标注，未用 AST）：diff 逐 hunk 的 `-`/`+` 键集差、`expect(` 计数、`test/it` 用例名集合、残留 `env.body|targetEndpoint|requestState` 读、注释扫描。
- **运行时判据**：`/tmp` 独立探针（不改仓库）驱动真实 `createPipelineDriver`，以「mock codec 的 `translateOut`/`prepareWire` 是否被调用」为 oracle 区分 migrated vs legacy 分支；另跑过 `bun test tests/pipeline/driver.unit.test.ts`。
- **未覆盖（是「没扫」，不是「无发现」）**：①**类型正确但语义错**的改写——键都在正确作用域、值取错来源（如把 `env.request.model` 写成 `env.attempt.body.model`），AST 只查键不查值来源；②`as unknown as RequestEnvelope` 假体**缺失**字段（我只查「旧有而新无」的丢失，不查「本就该有却从未有」）；③非 envelope 形状的对象（ctx stub、wire、payload）内部的键丢失；④断言**语义强度**变化（数量不变但断言变弱），只数了 `expect(` 计数；⑤运行时行为等价性——除上述单条探针外未做逐 cell 的字节对照；⑥`ui/`、`ui-v4/`、docs 内除 DESIGN.md 外的文档。
