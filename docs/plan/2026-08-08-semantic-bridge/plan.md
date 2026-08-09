# Anthropic ↔ Responses semantic bridge —— 主实施计划

> **权威 spec**：[docs/rfc/2026-08-08-anthropic-responses-semantic-bridge.md](../../rfc/2026-08-08-anthropic-responses-semantic-bridge.md)（Accepted，五轮对抗评审收口）。
> **决策依据**：[ADR 2026-08-08 protocol-neutral reasoning exchange](../../decisions/2026-08-08-protocol-neutral-reasoning-exchange.md)；收窄的既有决策 [ADR 2026-07-14 lossless-per-pair bridge](../../decisions/2026-07-14-lossless-per-pair-bridge.md)。
> **本文职责**：HOW —— 任务 DAG + 锚点表（精确 `file:line`）+ 每 commit invariant + 验收与 mutation。**WHY 与公共契约一律以 RFC 为准，本文不重新裁决、不复述类型定义正文**。
> **kickoff 提示词**：[prompts/README.md](prompts/README.md)（阶段导航 + 依赖 DAG + 通用红线）。
>
> **计划基线**：master `82c0664e`（RFC/ADR/评审报告合入点）。下方所有 `file:line` 在该基线复验过；实施者**开工第一件事是重新复验自己要改的锚点**——行号会随并发会话漂移，用内容匹配而非行号定位。

## Goal

把现有 Anthropic ↔ Responses direct bridge 的六份方向专用 translator（各自维护 stream/non-stream 双份领域状态机）收敛为：**一个 protocol-neutral semantic mapper + keyed item ledger + 两个纯 wire emitter**，使同一领域事实只裁决一次、stream 与 non-stream 结构性共享语义、能力缺口 fail-closed 且可观测。

## Architecture

RFC §3 的四层职责（mapper / ledger / policy resolver / driver+emitter）落到现有 v4 管线上：mapper 与 ledger 是新增的纯模块；policy resolver 挂在 ingress 与 candidate final-route 之间；delivery authority **扩展既有唯一 writer**（`src/lib/pipeline/delivery/session.ts`），emitter 取代六个 translator 的 wire 部分。**现有 wire 算法核（usage 映射、stop-reason 投影、tool JSON 修复、carrier codec）extract-not-rewrite**，迁移的是它们各自私藏的 lifecycle 状态，不是重写字节算法。

## Tech Stack

TypeScript / Bun；SSE + WebSocket 流式；官方 `openai@^6.45.0`（`ResponseAccumulator` / `client.responses.stream().finalResponse()`）与 `@anthropic-ai/sdk@0.106.0`（`Stream.fromSSEResponse` / `.finalMessage()`）**仅作独立客户端 oracle**——两者都在 `devDependencies`（`package.json:110`、`:120`），这从依赖结构上保证了 RFC §2「不把 SDK 作为生产 emitter」，**不要把它们提升为 dependencies**；`safe-stable-stringify@2.5.0`（`package.json:96`，生产依赖、精确钉版）作 canonical JSON，须先过自建递归 validator（RFC §6.1）；bun test 分档 + eslint。**本计划不新增任何 npm 包。**

---

## Global Constraints（每个 task 隐含包含）

逐条来自 RFC §11.1，违反即返工：

- **G1 每 commit 可运行**：`bun run typecheck` 绿 + 目标测试可跑。中间态显式无害，绝不半坏。
- **G2 绝不双发** `[hard]`：旧 production path 仍是唯一 writer，**或**新 path 在同一 commit 原子取代该方向全部 cells。C1–C8 一律不得改变 production writer；只有 C9/C10 切换。
- **G3 shadow 无副作用** `[hard]`：shadow 只写 request-local 内存比较器。写客户端／日志／History／指标／任何共享状态即该 commit 失败。
- **G4 同模型原样回送** `[hard]`：同模型 Anthropic tool-use assistant content 完整、原序回送原生 thinking／redacted_thinking，不经 envelope 重建（RFC §3.3 第 7 条）。
- **G5 stream/non-stream 同源**：每个已切方向的两条路径语义来自同一 ledger snapshot。
- **G6 切换双向 mutation**：每个 cutover commit 同时有「新路径可达」与「旧路径不可达」两个 mutation 对照。
- **G7 配置非法组合解析期失败**：v2 policy rule 是原子单元，非法即整条 rule 不进运行态；**不得只剥非法叶子让其余字段带默认值继续**（这正是现有 `ModelTranslationSchema` 的 `cleanInvalidPaths()` 行为，见锚点表 A-9）。
- **G8 History 不记录 opaque 正文** `[hard]`：只存 carrier version／source／boundary／域分离 SHA-256／byteLength。

项目级红线（不重复正文，指向权威）：

- **实现优先、非 TDD red-first** —— user-rule `40-dev-workflow` `implementation-before-tests`。先写生产行为，再补直接覆盖该行为的核心测试。**唯一例外是 C0**：它是 golden 预捕获，按 skill `large-refactor` §4 必须在**改动前的旧码**上跑通。
- **4141 保护** `[hard]` —— 绝不 kill 用户主服务器；测试服务器起在非 4141 端口、按 PID 精确清理。见 CLAUDE.md `protect-user-main-server`。
- **提交纪律** —— 显式 pathspec `git commit -F <msgfile> -- <精确路径>`，一语义单元一 commit，conventional commits，无模型署名。共享树 pathspec 免疫 peer index race。
- **不可逆动作 fail-closed** —— 无法确定 opaque 来源、schema dialect 不接受、context-management 混合策略，一律 reject，不猜（RFC §14）。

---

## 当前生产现实：锚点表

**这一节是本计划最重要的部分。** RFC 描述目标态，下表是实施者会真正打开的文件。已在基线 `82c0664e` 复验。

### A. 翻译层（六个 translator —— 被 C8 emitter 取代的对象）

| ID | 锚点 | 现状与迁移取向 |
|---|---|---|
| A-1 | `src/lib/openai/translate/anthropic-to-responses-request.ts:113` | A→R request。`textParts`／`items`／两类 dropped-thinking 计数是**私藏状态**。:217-255 把 assistant text 汇总成一个 item 并 `unshift`，丢失 text/tool 交错顺序 → C4.1 治。:150-155 静默裁剪 `context_management`／stop sequences／`top_k` → C6 治。:243-245 丢 `server_tool_use` → C5 治。:381-388 只映射 `web_search`、其余剥离 |
| A-2 | `src/lib/openai/translate/anthropic-to-responses.ts:81` | A→R non-stream。:94-145 把所有 reasoning `unshift` 前置。:132-136 drop server-tool 两类。`mapStopReasonToResponsesStatus`（:145）／`mapUsage`（:205-263）是**要保留的算法核** |
| A-3 | `src/lib/openai/translate/anthropic-to-responses-stream.ts:139` | A→R stream。`createAnthropicToResponsesStreamTranslator`。:419-504 `flush` 无条件发 `response.completed`、只把 status 填成 incomplete → 违反 RFC §4 `ResponseTerminal` 不得改写，C8.1 治。:258-271 `content_block_start` 不读完整 input，flush 靠 `argumentParts.join("")` → 无 delta 的 function call 变空 input |
| A-4 | `src/lib/openai/translate/responses-to-anthropic-request.ts:113` | R→A request。`foldInputItems`（:148-277）三槽位按类别重组，丢原序 → C4.2 治。:122-128 静默裁剪 `previous_response_id`／context management／truncation |
| A-5 | `src/lib/openai/translate/responses-to-anthropic.ts:157` | R→A non-stream。:163-173 **单个** `reasoningText` + **单个** `reasoningEncrypted` → 多 reasoning item 被压扁；:210-219 只有 text 非空才生成 thinking → encrypted-only reasoning 被丢。`mapResponsesStatusToStopReason`（:221-234）／`mapUsage`（:305-351）／`repairToolInput`（:271-279）是**要保留的算法核** |
| A-6 | `src/lib/openai/translate/responses-to-anthropic-stream.ts:122` | R→A stream。同样只有一个 `reasoningEncrypted`（:129-139）。:274-294 在 `.done` 才捕获 opaque（**这是正确行为，Phase 0 探针已裁决 `.added` 是中间态**，勿回退）。:179-191 `buildSyntheticReasoningSignature` carrier |

**方向不对称提醒**：两向 carrier **故意不同**（Claude signature vs synthetic-reasoning 前缀），RFC §6.1 要求保持前缀分离并做 prefix↔kind↔source 联合校验；**不得为「统一」合并成通用 string**。

### B. 请求腿三点 seam（RFC §11 C8/C9 承重）

| ID | 锚点 | 说明 |
|---|---|---|
| B-1 | `src/lib/pipeline/hub-translate.ts:148` `anthropicToResponsesBridge`，:171 `REQUEST_BRIDGES`，:261 `RESPONSE_BRIDGES`，:337 `responsesForwardStreamFactory`，:358 `FORWARD_STREAM_FACTORIES`，:467 `responsesReverseStreamFactory`，:496 `REVERSE_STREAM_FACTORIES` | 四个穷尽 `satisfies Record` 桥表**已存在**。C9/C10 换的是表项指向，不是表结构。漏格=编译错，这条护栏继续用 |
| B-2 | `src/lib/codec/openai-responses/openai-responses-cell.ts:75` `bodyIsResponsesShaped`，:114 `translateOut`，:138 `prepareWire` | `translateOut` 的 dispatch 键是「是否 SKIP 翻译」，`prepareWire` 的键是「body 是否已 Responses 形」——**两个不同谓词，别混用** |
| B-3 | `src/lib/codec/openai-responses/openai-responses-leg.ts:111` `prepareResponsesDirectWire`，:135 `prepareViaResponsesWire` | 已是目标协议形状的 body 不得再经 CC 二次翻译 |
| B-4 | `src/lib/codec/cc-family-strategies.ts:42` `isAnthropicDirectResponsesLeg`，:47 `buildCcFamilyLegStrategies` | retry baseline 的第三点。**只改 B-2 而漏 B-3/B-4 会让 retry 腿回退成 CC 形**——RFC §12 要求逐点恢复旧路径的 mutation |

### C. Driver / delivery / candidate（C2 authority 与 C8 shadow 的宿主）

| ID | 锚点 | 说明 |
|---|---|---|
| C-1 | `src/lib/pipeline/delivery/session.ts:366` `writeCommittedBatch` | **唯一客户端 writer**。:378 `commit()` 在任何外部 wire 写之前同步调用，:379 置 `committed = true`；catch 块据此分裂 `committed:false\|true`。这正是 RFC §6 「初始 authority commit point」的现成落点 |
| C-2 | `src/lib/pipeline/delivery/session.ts:411` `writeAllocationFrames` → :423-424 传入 `reservation.commit()`；:492 `publish-recovery-batch` 传入**空回调 `() => {}`** | ⚠️ **两条路径的 commit 语义不同**。authority epoch 若只挂在 `writeAllocationFrames` 上，恢复批次那条路径就不带 epoch。epoch 必须挂在 `writeCommittedBatch` 这一层或更上，且两个调用点都要覆盖 |
| C-3 | `src/lib/pipeline/types.ts:509` `GenerationWireState`，:513 `activeLeg`，:514 `openAnchorIndex` | wire 状态 SSOT。`reservation.commit()` 只改 allocator 计数器，**不改变 owner 归属语义** → authority epoch 需要在此新增字段 |
| C-4 | `src/lib/pipeline/generation/coordinator.ts:182` `runRecovery`（:197 父 settle failed）、:215 `runContinuation`（:221-222 父 settle continued）、:234 `raceReadyCandidates` | segment boundary 的天然产生点。**`runRecovery` 与 `runContinuation` 性质不同**：前者「父失败、子重开」，后者「父已部分交付、子续接」——RFC §3.4 的 fallback 与 continuation 分别对应，**不得用同一个函数处理**。`raceReadyCandidates` 是「哪个段成为权威」的判定点，不是新建点 |
| C-5 | `src/lib/pipeline/generation/candidate-response-session.ts:104` `createState()`，:110 `captureTerminalSnapshot`，:184 `snapshot()`，:189 缓存返回 | candidate-local 状态宿主。`State` 是不透明类型参数，**可以**承载 per-candidate ledger segment。⚠️ **已知阻碍**：:189 在 `terminalSnapshot !== undefined` 时直接返回缓存，不再读最新 `state`；continuation 若要读父 ledger，必须在 `captureTerminalSnapshot` 冻结前取，或新增直接持有 `State` 的旁路（当前无此旁路） |
| C-6 | `src/lib/pipeline/committed-blocks-ledger.ts:15` `CanonicalBlock`，:24 `createCommittedBlocksLedger`，:40 `hasCompleteInteractiveToolUse` | ⚠️ **与新 semantic ledger 是两件事，禁止合并**。它只负责 continuation 的「已交付前缀」（text/tool_use 两型，故意排除 thinking），由 driver 在 commit boundary 喂养。新 ledger 管完整语义 lifecycle。两者由同一 delivery boundary 驱动，但职责不重叠 |
| C-7 | `src/lib/context/request.ts:1494` `selectGenerationWinner`，:901 `commitGenerationObservabilityTerminal` | candidate 选定与 terminal 记录。observation stage 晋级要接在这里 |

### D. 配置（C2/C6 的对象）

| ID | 锚点 | 说明 |
|---|---|---|
| D-1 | `src/lib/config/schema.ts:1242` `MODEL_TRANSLATION_INGRESS_VALUES`，:1252 `MODEL_TRANSLATION_FEATURE_VALUES`（当前只有 `"strip-thinking-signature"`），:1266 `ModelTranslationRuleSchema`，:1283 `ModelTranslationSchema`，:1427 顶层字段 | v1 schema。RFC §6.2 的 `policy` 段在此扩展 |
| D-2 | `src/lib/config/schema.ts:1594-1601` `AssertAssignable` 双向锁 | schema 与 foundation 词表 lockstep。改一边不改另一边 → 编译错。**这是要保留的护栏** |
| D-3 | `packages/foundation/src/state-vocabulary.ts:231-247` `ModelTranslationIngress` / `Feature` / `Rule` / `ModelTranslation` | 词表侧 |
| D-4 | `src/lib/config/model-translation.ts:38` `resolveTranslationFeatures`，:57 `ingressForClientFormat`，:68 `stripThinkingSignatureFor`，:74 `modelIdFor` | v1 resolver。C6.2 由 policy resolver 取代；`features:["strip-thinking-signature"]` 迁移为 `policy.carrier_unknown:"strip"` 并发弃用警告 |
| D-5 | `src/lib/config/schema.ts:1009` 注释所述 `cleanInvalidPaths()` 行为 | ⚠️ **当前行为是「剥掉出错的叶子、其余继续」，正是 G7 禁止的**。C6.2 必须让 v2 rule 走 rule-level 原子失败路径 |

### E. History（C3 的对象）

| ID | 锚点 | 说明 |
|---|---|---|
| E-1 | `src/lib/history/types.ts:217` `PipelineInfo`，:222 `wirePartialDelivery`，:225 `translation?.anthropicToResponses` | 旧槽。迁移窗口内只作**旧读兼容投影**，新 mapper 只写 `semanticBridgeV2`（RFC §10.1 末条） |
| E-2 | `src/lib/history/v3/projection.ts:187` `recordToHistoryEntry`，:388 `pipelineInfo` 取自 `terminalMeta` | ⚠️ **当前 `pipelineInfo` 只经 terminal metadata 落地**，是 terminal-only 路径 |
| E-3 | `src/lib/history/in-flight.ts:54` `putInFlight`，:58 `updateInFlight`；`src/lib/history/entries.ts:33` 发布 `history.entry_updated` | in-flight 是**独立的内存 `HistoryEntry` 映射**，不走 V3 record。RFC §10.1 的 `lifecycle:"in-flight"` variant 要求实时可见 → **C3.2 必须同时接这条路径，只改 V3 terminal 投影不够** |
| E-4 | `src/lib/context/model-operation-record.ts` `setExtension(namespace, value)`（terminal committed 后调用会抛，见 `tests/context/model-operation-record.unit.test.ts:332`） | 建议宿主：semantic bridge 活状态挂 `extensions["translation.semanticBridgeV2"]`，in-flight 与 terminal 两条投影**从同一 extension 派生**，避免两份可独立写入的真相 |

### F. 已存在的 oracle 资产（C0 的起点，不要重造）

| ID | 锚点 | 说明 |
|---|---|---|
| F-1 | `tests/openai/responses-to-anthropic-stream.unit.test.ts:97` `sdkAccumulate` | 已在用**真** `@anthropic-ai/sdk` `Stream.fromSSEResponse`，含 N1 event-line 不变量断言（:78）。C0.1 提取为共享 test-only oracle |
| F-2 | `tests/e2e-client/responses-nodelta.probe.it.test.ts:266` `finalOf` | 已在用**真** OpenAI SDK `client.responses.stream().finalResponse()` 走真实 HTTP（in-process `Bun.serve`），且已有负控：缺 `content_part.added` 的 `.done` 让 SDK 抛 `missing content`（:311、:327）。**这正是 RFC C0 要的红样本，已存在** |
| F-3 | `tests/openai/anthropic-responses-reverse-roundtrip.unit.test.ts` | 现有 carrier round-trip 测试 |
| F-4 | 六个 translator 的 `tests/openai/*.unit.test.ts` | 现状锁定基线 |
| F-5 | `tests/e2e-client/anthropic-sdk.it.test.ts`、`continuation-sdk.it.test.ts`、`precontent-recovery.it.test.ts` | 已覆盖 pre/post-commit retry 与 continuation 的真 SDK 场景，C2.3 authority 测试可复用其 harness |

---

## 任务 DAG

```text
C0.1 ─┬─ C0.2 ─ C0.3 ─┐
      └───────────────┤
                      ▼
              C1.1 → C1.2 → C1.3
                             │
                             ▼
              C2.1 → C2.2 → C2.3
                             │
                             ▼
              C3.1 → C3.2 → C3.3
                             │
       ┌──────┬──────┬───────┴──────┐
       ▼      ▼      ▼              ▼
   C4.1/4.2 C5.1/5.2 C6.1/6.2   C7.1/7.2      ← C4–C7 可并行
       └──────┴──────┴──────────────┘
                      ▼
           C8.1 ∥ C8.2 → C8.3
                      ▼
                     C9  (A→R 原子 cutover)
                      ▼
                     C10 (R→A 原子 cutover)
                      ▼
              C11.1 → C11.2
```

**串行硬约束**：C1→C2→C3 严格串行（后者消费前者的类型契约）。C8.3 必须在单一集成态吸收 C4–C7 全部语义。C9→C10 串行，以便每次 cutover 独立证明可达性并可单方向回滚。

**并行边界**：C4–C7 四组彼此独立，可分派不同 implementer；但它们**共改** `src/lib/pipeline/semantic/`（C1 建立）下的 mapper 与 policy 模块 → 需协调合并顺序，建议按 C7（carrier，最独立）→ C5 → C6 → C4（改动面最大）依次合并。C8.1 与 C8.2 格式独立可并行。

---

## 任务详情

每片的固定字段：**Files / Interfaces / Steps / Commit invariant / Verify / Mutation**。
「Verify」列出的命令是**该片的最小充分集**；交付前另跑 `bun run test:backend`。

---

### C0.1 —— 共享 SDK oracle harness

**Goal**：把已分散在两处的真实 SDK oracle 提取为共享 test-only 模块，供 C0.2 起全部后续片复用。**纯测试改动，零生产改动。**

**Files**
- Create `tests/helpers/protocol-oracles/anthropic-sdk-oracle.ts` —— 提取 F-1 的 `sdkAccumulate` + `assertEventLineInvariant` + `toWire`
- Create `tests/helpers/protocol-oracles/responses-sdk-oracle.ts` —— 提取 F-2 的 `finalOf` + in-process proxy harness 接线
- Create `tests/helpers/protocol-oracles/index.ts`
- Modify `tests/openai/responses-to-anthropic-stream.unit.test.ts`（改调共享 oracle，断言逐字不变）
- Modify `tests/e2e-client/responses-nodelta.probe.it.test.ts`（同上）

**Interfaces**
- Produces：`accumulateAnthropic(frames): Promise<Message>`、`assertAnthropicEventLineInvariant(frames): void`、`finalResponseOf(sseFrames): Promise<FinalOutput>`。命名以最佳方案为准。

**Steps**
1. 纯移动提取，不改任何断言语义。
2. 两个现有测试改调共享实现。
3. `bun test tests/openai/responses-to-anthropic-stream.unit.test.ts tests/e2e-client/responses-nodelta.probe.it.test.ts` —— **必须逐条仍绿**，这是「纯移动」的证明。

**Commit invariant**：零生产文件改动（`git diff --stat` 只含 `tests/`）；两个既有测试的用例名集合与通过数不变。

**Verify**：`bun run typecheck` + 上述两个测试文件 + `bunx eslint tests/helpers/protocol-oracles/`

**Mutation**：故意在共享 oracle 里跳过 `event:` 行校验 → F-1 的 N1 用例必须变红。若不红说明提取时丢了断言。

---

### C0.2 —— 缺陷语料与现状锁定

**Goal**：为 RFC §1 列出的九类已确认缺陷各建一条 fixture，**在旧码上跑通并显式标注当前是「已知有损」**，作为 C8 之后逐条转绿的对照。

**Files**
- Create `tests/openai/semantic-bridge/known-defects.unit.test.ts`
- Create `tests/openai/semantic-bridge/fixtures/`（nested summary/content/text parts、multi-reasoning、encrypted-only、`.done.arguments` 无 delta／有 delta／冲突三类、server-tool 四格、Scenario A/B 四腿、同模型 Claude thinking／redacted／text／tool-use 原样回送）

**Interfaces**
- Produces：具名 fixture 导出，供 C1–C8 直接 import；每条附 `expectedAfterMigration` 注释说明目标行为由哪个 commit 兑现。

**Steps**
1. 每条缺陷写一个断言，断言**当前（有损）行为**，并在测试名与注释里写明「KNOWN-LOSS，C<N> 后应改为 X」。
2. 九类逐条覆盖，缺一即本片未完成。
3. 同模型 Claude 原样回送那条是 **G4 的守护**，它从现在到 C11 必须一直绿。

**Commit invariant**：零生产改动；全部新测试在**改动前的旧码**上绿（golden 预捕获，skill `large-refactor` §4）。

**Verify**：`bun test tests/openai/semantic-bridge/` + `bun run test:fast`

**Mutation**：把 A-5 的 `reasoningEncrypted` 改成数组保留多条 → encrypted-only 那条 KNOWN-LOSS 断言必须变红（证明它确实咬住当前有损行为，而不是恒真）。

---

### C0.3 —— mutation registry

**Goal**：把「每个阻断式判据都有 exact mutation，且失败来自目标机制」制度化，避免 C1–C10 每片各自口头声称。

**Files**
- Create `tests/openai/semantic-bridge/mutation-registry.md` —— 表格：判据 ID / 目标机制 / mutation 的精确 patch 描述 / 期望变红的用例 / 已核对失败原因来自目标机制（是/否）
- Create `docs/plan/2026-08-08-semantic-bridge/progress/README.md` —— 进度文件约定（一 agent 一文件，随每个实现 commit 提交）

**Steps**
1. 为 C0.2 的九类 + RFC §12 验收矩阵的十七行各登记一条。
2. 每条写明**如何构造 mutation**（改哪个函数的哪一行，改成什么），不写「注释掉相关代码」这种不可执行描述。
3. 明确记录：mutation 不变红有**三**解 —— 测试没咬住 / mutation 没生效 / fixture 造不出被测状态。排除前两条后先写探针问「这状态真存在吗」，别改断言。

**Commit invariant**：纯文档 + 测试目录，零生产改动。

**Verify**：人工核对 registry 行数 ≥ RFC §12 矩阵行数；`rg -c '^\|' mutation-registry.md` 与矩阵对账。

---

### C1.1 —— ledger 类型契约与 declare/delta reducer

**Goal**：落 RFC §4 的 `ItemKey`/`PartKey`/`SegmentId`/`SemanticItem`/`PartState`/`PerOutputItemState`/`LedgerUpdate`，实现 declare 与 delta 累积。**不接 wire、不写 sink。**

**Files**
- Create `src/lib/pipeline/semantic/types.ts`
- Create `src/lib/pipeline/semantic/ledger.ts`
- Create `tests/pipeline/semantic/ledger-declare.unit.test.ts`

**Interfaces**
- Produces：`createSemanticLedger(): SemanticLedger`，含 `apply(update: LedgerUpdate): void`。类型逐字对齐 RFC §4，**不得自行增删字段**。

**Steps**
1. 类型文件按 RFC §4 落地（RFC 是唯一权威，冲突时改代码不改 RFC）。
2. reducer 实现 declare-item / declare-part / append-part-text / append-arguments / append-result-output。
3. 落 declare 期不变量：每 key 只 declare 一次；part 只能引用已 declare 的 item；`sourceIndex` 同 item／kind 内唯一；kind↔metadata 互斥（call 只允许 `call`、result 只允许 `result`，错配 fail-closed）。
4. 补单测覆盖每条不变量的违反路径。

**Commit invariant**：纯新增模块 + 单测；无任何生产调用者（`rg 'semantic/ledger' src/ | rg -v 'semantic/'` 为空）；typecheck + `test:backend` 全绿。

**Verify**：`bun run typecheck` + `bun test tests/pipeline/semantic/`

**Mutation**：删掉「重复 declare 拒绝」分支 → 对应单测变红。

---

### C1.2 —— 三层 terminal 与拒绝规则

**Goal**：落 part／item／response 三层 terminal 与 RFC §4 的全部拒绝规则。**这是本 RFC 最密集的不变量群，逐条落、逐条测。**

**Files**
- Modify `src/lib/pipeline/semantic/ledger.ts`
- Create `tests/pipeline/semantic/ledger-terminal.unit.test.ts`

**Steps**
1. `finish-part` / `finish-item` / `finish-response`。
2. 逐条落 RFC §4 的 terminal 规则，**清单不得省略**：
   - terminal 后拒绝更新；
   - `finish-item` **不隐式终结 child part**；item terminal 前所有已 declare part 必须已 terminal；
   - `complete` item：非 discarded part 全部 complete、discarded part 须有具名 degradation、**不得含 partial part**；
   - `partial` item：所有开放 part 先以具名 EOF／abort／fallback／continuation／wire-error provenance 终结为 partial，既有 complete／discarded 保持原终态；
   - `discarded` item：所有开放 part 先以同一或派生 reason 终结为 discarded；
   - kind-specific 权威值门：reasoning／text 目标投影 part 已 terminal 且可派生 final visible；call 须有 `CallMetadata` + `authoritativeArguments`；result 须有 `ResultMetadata` + `authoritativeOutput`；drop 永远只能 discarded；**缺权威值时不得用 delta 拼接值冒充 done**；
   - partial provenance 为 `fallback` 必带 `fallbackId`、`continuation` 必带 `continuationId`，其它 provenance 不得带二者；discarded 必带 reason；
   - response terminal 恰一个；`completed` 前不得有开放 item／part 且所有非 discard item 必须 complete；`incomplete`／`failed`／`cancelled` **不得被改写为 `completed`**；缺 wire terminal 时只能由 EOF／abort／driver-cancel provenance 合成对应非成功终态。
3. 每条拒绝路径一条单测。

**Commit invariant**：仍无生产调用者；上述每条规则**都有对应用例**（用例名带规则编号，便于 C0.3 registry 对账）。

**Verify**：`bun run typecheck` + `bun test tests/pipeline/semantic/`

**Mutation**：让 `finish-item` 隐式把开放 part 标 complete → 「item terminal 前 part 必须已 terminal」用例变红。**核对失败信息确实来自该门，而非旁路断言**。

---

### C1.3 —— immutable snapshot、fork 与 property tests

**Goal**：落 `LedgerSnapshot`／`LedgerTransition`／`fork()`，并用 property test 覆盖 RFC §12 中「多 reasoning 不串槽」「function args authoritative done」两行。

**Files**
- Modify `src/lib/pipeline/semantic/ledger.ts`
- Create `src/lib/pipeline/semantic/snapshot.ts`
- Create `tests/pipeline/semantic/ledger-property.unit.test.ts`

**Interfaces**
- Produces：`snapshot(): LedgerSnapshot`（immutable，结构共享）、`fork(): SemanticLedger`（写时隔离）、有序 `LedgerTransition` 流供 C8.1/C8.2 消费。

**Steps**
1. 结构共享 immutable snapshot；fork 后互不影响。
2. Property：任意交错的多 reasoning item declare/delta/done 序列，各 item 的 visible 与 opaque 永不互串。
3. Property：`.done.arguments` 三类（无 delta／有 delta 一致／delta 与 done 冲突）—— 最终 snapshot 一律取 authoritative value，冲突产生 observation 占位（observation 类型在 C3.1 落地，此处先留结构）。
4. 复杂度守护：O(events + items)，ledger 内存 request/candidate-local。

**Commit invariant**：仍无生产调用者；fork 隔离性有正负控。

**Verify**：`bun run typecheck` + `bun test tests/pipeline/semantic/` 连跑 10 次确认确定性

**Mutation**：让 fork 共享可变 Map → 隔离性用例变红。

---

### C2.1 —— ingress config snapshot

**Goal**：在任何 route／candidate 分叉前捕获一次 `TranslationConfigSnapshot`，identity 冻结到 `RequestEnvelope`。

**Files**
- Create `src/lib/pipeline/semantic/config-snapshot.ts`
- Modify `src/lib/pipeline/envelope.ts`（新增 `readonly translationConfigSnapshot?`，随 `requestState` 一样走 request-lifecycle-STABLE 语义，**不进 `with()` 的 patch 集**）
- Modify inbound codec 的 `parse`（与 `requestState` 同一捕获点）
- Create `tests/pipeline/semantic/config-snapshot.unit.test.ts`

**Steps**
1. snapshot 含 `snapshotId` + 冻结的 `model_translation` 视图。
2. 接线：ingress 捕获一次，后代 candidate 只读。
3. 热重载测试：ingress 后改配置，**在飞请求的 snapshot 不变**，下一次 ingress 才变。

**Commit invariant**：snapshot 仅被捕获与读取，无消费者改变行为；既有 config 热重载测试全绿。

**Verify**：`bun run typecheck` + `bun test tests/pipeline/semantic/ tests/config/`

**Mutation**：让后代 candidate 重读热配置 → 热重载隔离用例变红。

---

### C2.2 —— candidate lineage 与 policy resolver

**Goal**：落 `CandidateTranslationLineage` 与 `PairTranslationPolicy` 解析（RFC §6）。

**Files**
- Create `src/lib/pipeline/semantic/policy-resolver.ts`
- Create `src/lib/pipeline/semantic/lineage.ts`
- Modify `src/lib/pipeline/generation/coordinator.ts`（C-4 三点，只**新增** lineage 记录，不改变现有 settle 语义）
- Create `tests/pipeline/semantic/lineage.unit.test.ts`

**Steps**
1. 每 candidate 在 final route 确定后，从**同一** ingress snapshot 按完整 source／target `ModelIdentity` 解析一次 policy。
2. candidate 改 route → 新 candidate／dispatch／segment／policy，**祖先 policy 不变**。
3. 在 C-4 的三个点建立 segment：`runRecovery`（fallback 性质）与 `runContinuation`（continuation 性质）**分别处理，不共用函数**；`raceReadyCandidates` 只做权威判定，不新建 segment。
4. 未命中 rule 时用 RFC §6.2 的全局安全默认（unknown carrier `reject`、structured output `strict`、context management `reject`）。

**Commit invariant**：lineage 只被记录不被消费；现有 retry／hedge／continuation 行为字节不变（既有 `tests/e2e-client/continuation-sdk.it.test.ts`、`precontent-recovery.it.test.ts` 全绿即证）。

**Verify**：`bun run typecheck` + `bun test tests/pipeline/ tests/e2e-client/continuation-sdk.it.test.ts tests/e2e-client/precontent-recovery.it.test.ts`

**Mutation**：让 continuation 复用 recovery 的 segment 构造 → 「continuation 继承父 ledger、recovery 不继承」用例变红。

---

### C2.3 —— delivery authority 与原子 transfer

**Goal**：落 `DeliveryAuthorityState` 与 RFC §6 的唯一 writer 不变量。**本片是整个 RFC 最容易做错的一片。**

**Files**
- Modify `src/lib/pipeline/delivery/session.ts`（C-1 `writeCommittedBatch` 一层加 epoch；**C-2 两个调用点都要覆盖**）
- Modify `src/lib/pipeline/types.ts`（C-3 `GenerationWireState` 新增 authority 字段）
- Modify `src/lib/pipeline/semantic/lineage.ts`
- Create `tests/pipeline/semantic/delivery-authority.it.test.ts`

**Steps**
1. authority epoch 挂在 `writeCommittedBatch`（C-1）而非 `writeAllocationFrames`——否则 `publish-recovery-batch`（C-2，空 commit 回调）那条路径不带 epoch。
2. 初始 commit：首次不可逆客户端 emission 建立 `active(epoch=0)`。
3. 两类无内容帧终态也必须建立唯一 authority：**preflight fail-closed**（driver 接受 typed rejection 时建 `active(0)`、冻结 `failed/preflight-reject`、由该 authority 发错误 wire 并等 sink 结果后转 terminal）与 **contentless success**（同样先建 active、发完并确认 terminal wire 后转 terminal）。
4. post-commit transfer：祖先先把开放 part／item 按真实 provenance 终结为 partial → 按目标协议顺序发送并确认全部 closing wire effects → 在**同一临界动作**内把祖先改 `transferred(epoch=N,toCandidateId)`、后代改 `active(epoch=N+1)`。准备／ACK／校验任一失败都不发布 transfer，authority 仍归祖先。
5. pre-commit fallback `partialOutputKept:true` 的**两支且只有两支**：①旧 segment 有可发 wire effect → 旧 candidate 先建 epoch 0、flush+ACK、再 transfer 给 epoch 1；②旧 segment 无任何可发 wire effect → 旧 candidate discard，fallback candidate 首写时直接建 epoch 0，**不产生 transferred ancestor 也不产生 `wirePartialDelivery`**。具名 normalized observation 归属新 candidate。
6. hedge losers 一律 `discarded`，不写客户端／WARN／History actual／业务指标。
7. `authorityPhase` 由 driver 据锁内事实派生，**不接受 wire 自报**；陈旧或矛盾值须据锁内事实重构，重构不了则 fail-closed。

**Commit invariant**：production writer 行为字节不变（authority 只是新增记录层，G2）；**任一时刻至多一个 active authority** 有确定性中点探针证明。

**Verify**：`bun run typecheck` + `bun test tests/pipeline/semantic/delivery-authority.it.test.ts` 连跑 25 次 + `bun run test:backend`

**Mutation**（四条，逐条核对失败来自目标机制）
- 让 transfer 在 closing ACK 前发布 → 中点探针断言「恰一个 active」变红；
- 让 preflight reject 不建 authority → 该终态的 lineage 用例变红；
- 让 pre-commit 空 segment 也产生 transferred ancestor → 分支②用例变红；
- 让 flush 失败仍 transfer → 分支①失败支用例变红。

---

### C3.1 —— typed observation 与 stage 晋级

**Goal**：落 `TranslationObservation` 与 proposed → authority-committed → sink-emitted 三态。

**Files**
- Create `src/lib/pipeline/semantic/observation.ts`
- Modify `src/lib/context/request.ts`（C-7 接晋级点）
- Create `tests/pipeline/semantic/observation-stage.unit.test.ts`

**Steps**
1. `observationId` 请求内唯一；每 ID 任一时刻**只有一个当前 stage**；晋级是原子状态替换，**不是追加第二份副本**。
2. mapper 只产 `proposed`，不自称 authority 或 sink 效果。
3. driver 接受 update 时读 candidate 当前 authority：未获权／已 discarded 保持 proposed；`active(N)` 的写为 `authority-committed` 并带 `authorityEpoch:N`。
4. 初始 commit 把该 candidate 此前所有 proposed **原子晋级**为 committed(epoch 0)；后续 transfer 只让新 candidate 的新 observation 用新 epoch，**不重复晋级祖先记录**。
5. `effect:"semantic"` 到 committed 即终态；`effect:"wire"` 须 sink ACK 同一 observationId 才晋级 sink-emitted，wire 失败保留 committed 但不产生 emitted。
6. 请求级 WARN 聚合：同 reason／quadrant／stage 聚合，日志至多一条；错误用稳定 code，**不得让 retry／客户端逻辑解析英文 message**。

**Commit invariant**：observation 只记录不改变任何 wire 行为。

**Verify**：`bun run typecheck` + `bun test tests/pipeline/semantic/`

**Mutation**：让晋级变成追加副本 → 「每 ID 单一当前 stage」用例变红。

---

### C3.2 —— History V3 类型与双路径投影

**Goal**：落 `SemanticBridgeHistoryV2`（RFC §10.1），**同时接 in-flight 与 terminal 两条投影**。

**Files**
- Modify `src/lib/history/types.ts`（E-1 新增 `translation.semanticBridgeV2`，旧 `anthropicToResponses` 保留为旧读兼容）
- Modify `src/lib/context/types.ts`
- Modify `src/lib/history/v3/projection.ts`（E-2）
- Modify in-flight 路径（E-3）
- Create `tests/history/v3/semantic-bridge-projection.it.test.ts`

**Steps**
1. 类型逐字对齐 RFC §10.1，含 `lifecycle` 判别联合、非空 tuple `authorityLineage`、`SegmentDeliverySummary`、`CandidateDiagnosticsProjection`。
2. **单一真相源**：活状态挂 `ModelOperationRecorder.setExtension("translation.semanticBridgeV2", …)`（E-4），in-flight 与 terminal 两条投影**都从该 extension 派生**，不各存一份。
3. in-flight：每次 authority／observation 推进后更新 in-flight entry 并发 `entry_updated`（E-3）。`lifecycle:"in-flight"` 时 `authorityLineage` 为空表示尚未建立 authority。
4. terminal：`lifecycle:"terminal"` 时 tuple 类型保证 terminal leaf 存在。
5. opaque hash 固定 `SHA-256("semantic-bridge-opaque-v2\0" || kind || "\0" || rawOpaqueUtf8Bytes)` lowercase hex；**不存正文**（G8）。
6. `candidateDiagnostics` 不可省略：`captured` 要求 `total === candidates.length`；`pruned` 要求 `total > retained` 且 `retained === candidates.length`。
7. 旧记录无 `semanticBridgeV2` 按 unknown capability 处理，**不回填虚构默认**。

**Commit invariant**：新槽只写不读（除测试）；旧 `anthropicToResponses` 读者行为不变；G8 有守护测试。

**Verify**：`bun run typecheck` + `bun test tests/history/` + `bun run test:backend`

**Mutation**（两条）
- 让 History 写入 opaque 正文 → G8 守护变红；
- 只更新 terminal 投影不更新 in-flight → in-flight 可见性用例变红（**这条专防「只改 V3 projection 就以为接完了」**）。

---

### C3.3 —— REST／WebSocket readback 与文档同步

**Goal**：公开契约在 cutover **之前**就位（RFC §10.1 明确禁止把它拖到 C11）。

**Files**
- Modify History REST route（`GET /history/api/entries/:id` 返回该投影）
- Modify History WebSocket 完整 entry 事件
- Modify list／summary 端点（只暴露 `semanticBridgeVersion`、actual disposition 计数、是否有 degradation，**不复制大数组**）
- Modify `docs/history.md`、`docs/API.md`
- Create `tests/history/semantic-bridge-readback.http.test.ts`

**Steps**
1. REST readback 端到端：写入 → `GET /history/api/entries/:id` → 逐字段核对。
2. WS 完整 entry 沿同一 `HistoryEntry` shape。
3. 列表端点只出计数，不出大数组（有断言守护）。
4. 文档同步：`docs/API.md` 补该投影字段；`docs/history.md` 补 lifecycle 与 lineage 语义。

**Commit invariant**：REST／WS 既有契约无破坏（既有 History 测试全绿）；文档与实现同 commit 落地。

**Verify**：`bun run typecheck` + `bun test tests/history/` + `rg -n 'semanticBridgeV2' docs/API.md docs/history.md`（非空）

**Mutation**：让 list 端点也返回 `actual` 全数组 → 「列表不复制大数组」用例变红。

---

### C4.1 —— ordered-turn model 与 A→R 保序

**Goal**：落 RFC §5 的 `TurnToken`／`NormalizationOutcome`，修 A-1 的 `unshift` 重排。

**Files**
- Create `src/lib/pipeline/semantic/ordered-turn.ts`
- Create `tests/pipeline/semantic/ordered-turn-forward.unit.test.ts`

**Steps**
1. 默认保持 source ordinal。
2. 只有目标协议**明确硬约束**允许重排，每次重排必须有具名规则 + observation + 正确样本 + mutation。
3. **不得从「thinking first」推导 text/tool 可任意重排**（RFC §5 明文）。
4. 用 transducer property 测双向顺序。

**Commit invariant**：新模块无生产调用者；A-1 现有行为不动（C9 才切）。

**Verify**：`bun run typecheck` + `bun test tests/pipeline/semantic/`

**Mutation**：去掉具名重排规则校验、允许无理由重排 → 保序 property 变红。

---

### C4.2 —— R→A 保序

**Goal**：同上，覆盖 A-4 的 `foldInputItems` 三槽位重组。

**Files**
- Modify `src/lib/pipeline/semantic/ordered-turn.ts`
- Create `tests/pipeline/semantic/ordered-turn-reverse.unit.test.ts`

**Steps**：同 C4.1，方向对称。注意 R→A 的 system／developer 降级为 user 是既有行为，需在 mapper 里保留为具名 normalization + observation，不再静默。

**Commit invariant / Verify / Mutation**：同 C4.1 结构。

---

### C5.1 —— server-tool history 两格

**Goal**：RFC §7 表格前两行 —— history assistant use、history user result。

**Files**
- Create `src/lib/pipeline/semantic/server-tool.ts`
- Create `tests/pipeline/semantic/server-tool-history.unit.test.ts`

**Steps**
1. history use：可表达时保留为 native／function；否则降级为**带 correlation ID 的 text**。
2. history result：保留 result／error 与 correlation ID；不可表达时 text。
3. **红线**：永不合成 Anthropic `web_search_tool_result`（无法伪造上游签名内容）。加一条守护测试断言输出中永不出现该 block 类型。

**Commit invariant**：无生产调用者；红线守护测试存在。

**Verify**：`bun run typecheck` + `bun test tests/pipeline/semantic/`

**Mutation**：让降级路径合成 `web_search_tool_result` → 红线守护变红。

---

### C5.2 —— server-tool live 两格

**Goal**：live streaming 与 live non-stream **同一 semantic disposition、独立 wire lifecycle**。

**Files**
- Modify `src/lib/pipeline/semantic/server-tool.ts`
- Create `tests/pipeline/semantic/server-tool-live.unit.test.ts`

**Steps**
1. 两格从同一 mapper 判定得出 disposition。
2. parity 测试断言两格 disposition 相同、wire 形态不同。

**Commit invariant / Verify**：同 C5.1。

**Mutation**：让 live-stream 与 live-nonstream 各判一次 disposition 且给出不同结果 → parity 用例变红。

---

### C6.1 —— structured output policy

**Goal**：RFC §8 —— canonical schema hash + 可配置降级。

**Files**
- Create `src/lib/pipeline/semantic/json-value-validator.ts`（共享递归 validator）
- Create `src/lib/pipeline/semantic/structured-output.ts`
- Create `tests/pipeline/semantic/structured-output.unit.test.ts`

**Steps**
1. **先** validator 拒 bigint／function／symbol／undefined／cycle／非有限数字，**再**调 `safe-stable-stringify@2.5.0`。**不得依赖库自行拒绝**——实测它把 Infinity/NaN 变 `null`、省略 `undefined`、bigint 数值化、cycle 写成 `"[Circular]"`。每一项逐条正控。
2. hash：canonical UTF-8 bytes 的 SHA-256 前 32 位 lowercase hex；name 固定 `json_schema_<32hex>`（总长 44）。**hash 只提供稳定命名／诊断关联，不替代 schema 内容校验**。
3. strict mode 两向按 RFC §8.1；验证基于**完整 schema 而非 hash**，失败返回 translation error，**不删除 keyword**。
4. allow-unconstrained：`strict:false`／省略 strict／`json_object` 默认 fail-closed；显式配置才可删约束继续，每请求至多一条 WARN，History 记录原格式类型／丢失字段／原因，**不声称 structured output 仍生效**。

**Commit invariant**：无生产调用者；validator 六类非法输入逐条有正控。

**Verify**：`bun run typecheck` + `bun test tests/pipeline/semantic/`

**Mutation**：去掉 validator、直接调库 → 六条非法输入用例中至少 Infinity／cycle／bigint 三条变红。

---

### C6.2 —— context-management policy 与配置 schema v2

**Goal**：RFC §9 + §6.2 —— per-pair 配置化降级，且非法 rule **原子失败**。

**Files**
- Create `src/lib/pipeline/semantic/context-management.ts`
- Modify `src/lib/config/schema.ts`（D-1；新增 `policy` 段，**走 rule-level 原子失败而非 D-5 的剥叶子**）
- Modify `packages/foundation/src/state-vocabulary.ts`（D-3，与 D-2 lockstep）
- Modify `src/lib/config/model-translation.ts`（D-4，旧 `features` 迁移为 `policy.carrier_unknown`）
- Regenerate `config.schema.json`（`scripts/generate-config-json-schema.ts`）+ `config.example.yaml`
- Create `tests/config/model-translation-v2.unit.test.ts`

**Steps**
1. `reject`（默认）／`warn-drop`／`threshold-only` 三态；`threshold-only` 必须**整体原子命中** RFC §9 表格的唯一支持子集，混合或未知策略 reject，**不部分映射**。
2. 缺省 threshold **不猜**（Responses 未公开默认值；Anthropic 的 150000 默认不得借用）。
3. 配置 v2：未知字段／非法 mode／互斥冲突／新旧同时声明 → typed diagnostic + **整条 rule 不进运行态**。服务器继续用其余有效 rule（warn-continue 保留在文件层），但**失效 rule 不得静默回落成看似命中的默认 policy**；只匹配失效 rule 的请求返回稳定 typed config error。
4. 旧 `features:["strip-thinking-signature"]` 作输入兼容别名迁移，发一次弃用警告；同 rule 同时声明新旧 = rule-level 冲突，整条失效。
5. `top_k`／stop sequences／cache control 的 capability table 一并落。

**Commit invariant**：D-2 的双向 `AssertAssignable` 仍编译通过（改一边不改另一边必须报错）；`config.schema.json` 与 `.describe()` 同 commit 重生成（注意：该文件由 `.describe()` 生成，改 TSDoc 是 no-op）。

**Verify**：`bun run typecheck` + `bun test tests/config/` + `bun run scripts/generate-config-json-schema.ts` 后 `git diff --exit-code config.schema.json`（应无差异）

**Mutation**（两条）
- 让非法 v2 rule 走 D-5 的剥叶子路径 → 「整条 rule 失效」用例变红；
- 让只匹配失效 rule 的请求回落全局默认 → 「返回 typed config error」用例变红。

---

### C7.1 —— carrier v2 编解码

**Goal**：RFC §6.1 wire grammar 与 strict decoder。

**Files**
- Create `src/lib/pipeline/semantic/carrier-v2.ts`
- Create `tests/pipeline/semantic/carrier-v2.unit.test.ts`

**Steps**
1. 两前缀分离：`copilot-api:claude-signature:v2:` 与 `copilot-api:synthetic-reasoning:v2:`。
2. 编码：复用 C6.1 的 validator → `safe-stable-stringify` → 无 padding base64url。
3. 解码：先校验字符集与长度 → schema 验证 → canonical stringify + base64url re-encode → **必须与原 payload 字节相等**。
4. **联合校验** prefix ↔ `kind` ↔ `source.protocol`：`claude-signature` 只允许 Claude 前缀 + Anthropic 来源；`responses-encrypted` 只允许 synthetic-reasoning 前缀 + Responses 来源。任一不一致 fail-closed，**不按 opaque 内容猜 kind**。
5. `boundary.partial` 只是父 item terminal 的序列化投影，**无独立 setter**；decoder 据它恢复统一 item terminal，不建 reasoning 专属第二状态源。
6. v1 decoder 永久保留到独立迁移决策。

**Commit invariant**：无生产调用者；round-trip 字节相等有 property test。

**Verify**：`bun run typecheck` + `bun test tests/pipeline/semantic/ tests/openai/anthropic-responses-reverse-roundtrip.unit.test.ts`

**Mutation**：去掉 prefix↔kind 联合校验 → 交叉前缀用例变红。

---

### C7.2 —— provenance 与 carrierAction

**Goal**：RFC §6 的逐块 `carrierAction`。

**Files**
- Modify `src/lib/pipeline/semantic/carrier-v2.ts`
- Modify `src/lib/pipeline/semantic/policy-resolver.ts`
- Create `tests/pipeline/semantic/carrier-action.unit.test.ts`

**Steps**
1. v2 carrier 有完整 source identity：**protocol／provider／resolved model 三者全匹配才 preserve**；任一维不同都 strip opaque、**保留 visible**。
2. v1／external／unknown → `carrierFallback`；未知 provenance 且无明确 fallback → 稳定诊断错误，**不猜**。
3. **不维护 session-last-model**（RFC §15 已否决）。
4. `source.model` 是 final resolved model ID，不是客户端 alias。
5. 同模型原生 Claude assistant content **不包装成 v2 再回送**（G4）。
6. Scenario A/B 混合来源 History 覆盖。

**Commit invariant**：G4 守护测试（C0.2 那条）仍绿。

**Verify**：`bun run typecheck` + `bun test tests/pipeline/semantic/ tests/openai/`

**Mutation**：让 provider 不同也 preserve → 三维匹配用例变红；让 provenance 不匹配时连 visible 一起丢 → 「只剥 opaque」用例变红。

---

### C8.1 —— Responses wire emitter

**Goal**：一个 emitter，**同时**消费 stream transition 与 non-stream finalized snapshot。

**Files**
- Create `src/lib/pipeline/semantic/emit/responses-emitter.ts`
- Create `tests/pipeline/semantic/emit/responses-emitter.unit.test.ts`

**Steps**
1. response／item／content／summary lifecycle 与 terminal event。
2. **emitter 不得修改 ledger、policy 或 observation**（RFC §3.1）。
3. 修 A-3 缺陷：`incomplete`／`failed`／`cancelled` 发对应 event，**不再无条件发 `completed`**。
4. 修「无 arguments delta 的 function call 变空 input」：从 authoritative arguments 取值。
5. 用 C0.1 的真 OpenAI SDK oracle 验证完整 lifecycle；**含 F-2 已有的负控**（缺 `content_part.added` 的 `.done` 让 SDK 抛）。

**Commit invariant**：emitter 无 production dispatch（G2）；stream 与 non-stream 两条消费路径**共享同一 snapshot 来源**（G5）。

**Verify**：`bun run typecheck` + `bun test tests/pipeline/semantic/emit/`

**Mutation**：让 non-stream 路径自己重判 terminal → G5 parity 用例变红。

---

### C8.2 —— Anthropic wire emitter

**Goal**：对称的 Anthropic emitter。

**Files**
- Create `src/lib/pipeline/semantic/emit/anthropic-emitter.ts`
- Create `tests/pipeline/semantic/emit/anthropic-emitter.unit.test.ts`

**Steps**
1. message／content-block／signature／stop lifecycle。
2. 每帧必带 `event:` 行且为 SDK 可识别名（沿用 C0.1 的 N1 不变量）。
3. 修 A-5/A-6 缺陷：多 reasoning item 各自独立，encrypted-only 不丢。
4. 用真 Anthropic SDK oracle 验证。

**Commit invariant / Verify**：同 C8.1 结构。

**Mutation**：合并多个 reasoning 到单槽 → 「多 reasoning 不串槽」property 变红。

---

### C8.3 —— 全 cell shadow parity

**Goal**：在单一集成态吸收 C4–C7 全部语义，按方向穷举 production cells 并跑零副作用 shadow。

**Files**
- Create `src/lib/pipeline/semantic/shadow.ts`（**request-local 比较器，仅测试与显式调试配置下启用**）
- Create `tests/pipeline/semantic/shadow-parity.it.test.ts`
- Modify `docs/plan/2026-08-08-semantic-bridge/progress/`（记录 cell 枚举结果）

**Steps**
1. 按 RFC §11 C8 逐条枚举 cells：request semantic mapper；codec `translateOut`／cell 选择（B-2）；leg `prepareWire`（B-3）；initial dispatch 与每种 retry strategy 的 baseline／fork 形状（B-4）；HTTP／WS、stream／non-stream emitter；terminal／usage／error／cancel／EOF／flush；observation authority stage 与 History projection。
2. **前向三点分别做**：首次 dispatch 正控、retry 正控、以及「恢复任一旧点即红」的 mutation（三点各一条，共三条）。
3. **反向按其实际接线列 cells，不把前向的非对称三点虚构成对称路径**（RFC §11 明文）。
4. Scenario B request consumer 漏接**不能只靠 response parity 代替**——单列一条。
5. 每个 cell 的结束条件四件套：正确正样本、目标 mutation 红样本、官方 SDK 或结构 oracle、shadow parity 结果。

**Commit invariant** `[hard]`：**production dispatch 仍全部指向旧 translator**；shadow 有任何客户端／日志／History／指标／共享状态副作用即本片失败（G3）。加一条守护测试断言 shadow 运行前后 History 条目数与日志行数不变。

**Verify**：`bun run typecheck` + `bun run test:backend` + shadow parity 测试连跑 10 次

**Mutation**：让 shadow 写一条 History → G3 守护变红。

---

### C9 —— Anthropic→Responses 原子方向 cutover

**Goal**：**一个语义 commit** 内切换该方向全部 cells 并删除该方向旧 production dispatch。

**Files**
- Modify `src/lib/pipeline/hub-translate.ts`（B-1：`REQUEST_BRIDGES` 与 `FORWARD_STREAM_FACTORIES` 的该方向表项）
- Modify `src/lib/codec/openai-responses/openai-responses-cell.ts`（B-2）
- Modify `src/lib/codec/openai-responses/openai-responses-leg.ts`（B-3）
- Modify `src/lib/codec/cc-family-strategies.ts`（B-4）
- Delete 该方向旧 translator 的 production 调用（A-1／A-2／A-3 的生产入口）
- Modify `tests/openai/semantic-bridge/known-defects.unit.test.ts`（该方向的 KNOWN-LOSS 断言转为目标行为断言）

**Steps**
1. request semantic mapper、`translateOut`、`prepareWire`、initial/retry baseline、HTTP／WS、stream／non-stream response、terminal／usage、observation authority、History actual projection —— **同一 commit 全切**。
2. **不得先切 stream 再切 non-stream；不得遗漏 retry 路径；不得保留运行时 flag 双轨**。
3. test-only fixture replay adapter 可暂留到 C11。

**Commit invariant** `[hard]`：G6 —— 同 commit 内有「新路径可达」与「旧路径不可达」两个 mutation；G2 无双发；该方向 C0.2 的 KNOWN-LOSS 条目全部转绿；反方向行为字节不变。

**Verify**：`bun run typecheck` + `bun run test:backend` + `bun run test:it` + 该方向 e2e（`tests/e2e-client/`）

**Mutation**（G6 两条）
- 把 B-2 恢复成旧 translateOut → 新路径可达性用例变红；
- 保留旧 dispatch 分支并让它可达 → 旧路径不可达用例变红。

---

### C10 —— Responses→Anthropic 原子方向 cutover

**Goal**：同 C9 方法，按该方向**实际非对称接线**。

**Files**
- Modify `src/lib/pipeline/hub-translate.ts`（B-1：`RESPONSE_BRIDGES` 与 `REVERSE_STREAM_FACTORIES`）
- Delete A-4／A-5／A-6 的 production 调用
- Modify 该方向 KNOWN-LOSS 断言

**Steps**
1. 按该方向实际 cells 枚举切换（反向请求腿在 hub 内，无前向的三点问题）。
2. **同模型原生 Claude assistant content 的旁路不经 semantic envelope 重建**，其 reachability 正负控必须与 cutover 同 commit 通过（G4）。

**Commit invariant** `[hard]`：同 C9；且 G4 旁路正负控同 commit 绿。

**Verify**：同 C9 + `bun run test:ci` 前置档位

**Mutation**：让同模型内容走 envelope 重建 → G4 旁路用例变红。

---

### C11.1 —— 退休旧路径

**Goal**：删除 shadow 比较器、test-only replay adapter、旧 translator 死逻辑。

**Files**
- Delete `src/lib/pipeline/semantic/shadow.ts` 及其测试
- Delete 六个旧 translator 中已无消费者的部分（**逐个用独立 oracle 确认无消费者，不凭 reviewer 断言**）
- Modify `src/lib/history/types.ts`（旧 `anthropicToResponses` 槽的移除**需另有 reachability 证明**，无证明则本片不动它）

**Commit invariant**：删除项逐个有「无消费者」的独立证据（`rg` + typecheck + 全量测试三重）；`bun run test:ci` 全绿。

**Verify**：`bun run typecheck` + `bun run test:backend` + `bun run test:it`

---

### C11.2 —— 文档同步与合并态评审

**Goal**：DESIGN／backlog／RFC 状态同步 + merged-state review。

**Files**
- Modify `docs/DESIGN.md`（「活的架构现状」表 —— 权威状态源）
- Modify `docs/todo/deferred-backlog.md`
- Modify 本 plan（四档状态注解）
- Modify RFC 状态行

**Steps**
1. **History 正式契约已在 C3.3 同步，C11 只核对最终实现并移除迁移期兼容说明，不首次定义它。**
2. 派 merged-state review agent（异模型，显式写裁判轴：长远正确 + 完整，非 ROI/YAGNI）。
3. 逐条核对 RFC §12 验收矩阵十七行。

**Commit invariant**：文档与代码同步；merged-state review 零未决 blocker／major。

**Verify**：`bun run test:ci` + 跨文档 `rg` 验证（无指向已删符号的引用）

---

## Self-review：RFC 节 → 任务覆盖

| RFC 节 | 覆盖任务 |
|---|---|
| §3.1 四层职责边界 | C1（ledger）／C2.2（policy resolver）／C2.3（driver authority）／C8.1-8.2（emitter） |
| §3.2 stream 与 non-stream 同源 | C1.3（snapshot/transition）+ C8.1/8.2（双消费路径）+ G5 |
| §3.3 Reasoning Exchange Envelope | C1.1（类型）／C7.1-7.2（carrier 与 provenance）／G4 |
| §3.4 boundary 状态转移 | C2.2（segment 产生点）／C2.3（authorityPhase 与两支 pre-commit retain） |
| §4 核心类型契约与 ledger invariants | C1.1／C1.2／C1.3 |
| §5 ordered-turn request model | C4.1／C4.2 |
| §6 config snapshot／lineage／policy／authority | C2.1／C2.2／C2.3 |
| §6.1 carrier v2 wire grammar | C7.1 |
| §6.2 配置 schema v2 与迁移 | C6.2 |
| §7 server-tool 四格 | C5.1／C5.2 |
| §8 structured output | C6.1 |
| §9 context management | C6.2 |
| §10 observation／错误／History | C3.1／C3.2 |
| §10.1 History V3 与 API 公开投影 | C3.2／C3.3 |
| §11.1 全局不变量 | Global Constraints G1–G8，逐 task 隐含 |
| §11.2 Commit DAG | 本文任务 DAG |
| §12 验收矩阵 | C0.3 registry 逐行登记，C11.2 逐行核对 |
| §13 性能与资源 | C1.3（复杂度与内存）／C8.3（shadow 限测试与显式调试） |
| §14 失败处理 | C1.2（typed 拒绝）／C6.1-6.2（fail-closed）／C7.1（fail-closed decoder） |
| §16 实施前门 | 本 plan 即其产物；用户 2026-08-08 已授权协调实施，plan 定稿后不再询问是否开始 C0 |

## 未采纳与暂缓

- **不合并 `CommittedBlocksLedger` 与新 semantic ledger**（C-6）—— 两者职责不重叠，合并会让 continuation 的「已交付前缀」语义被完整 lifecycle 污染。理由见 RFC §15「各方向独立 keyed translator」的同族论证。
- **旧 `pipelineInfo.translation.anthropicToResponses` 槽不在本计划移除** —— RFC §10.1 要求「所有读者迁移完毕并另有 reachability 证明」后才移除，本计划只把它降为旧读兼容投影，移除另立决策。
- **Gemini direct bridge、真实 Chat Completions 腿改写** —— RFC §2 明确非目标。
- **context-management 私有 carrier** —— RFC §15 本轮不采用，未来须先有双向真实 GHC PoC 和独立 ADR。
