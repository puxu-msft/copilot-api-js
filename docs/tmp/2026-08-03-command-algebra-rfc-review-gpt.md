# Generation Emission Command Algebra RFC 实施可行性评审

## 评审元数据

- 评审范围：`/home/xp/src/copilot-api-js/docs/rfc/2026-08-03-generation-emission-command-algebra/design.md`，对照代码基线 `/home/xp/src/copilot-api-js/.worktrees/anchor-alloc` 的 `2c3397847b3d85eebfe32e794d3ad700cb00e1f4`。
- 已读取／执行的证据：完整通读 RFC 773 行；读取 emission inventory、`tsconfig.json`、`package.json`、delivery session/types、raw SSE/WS adapters、driver live/buffered/retreat、四类 handler terminal、Responses WS、anchor injector/live reconciler，以及6个代表性测试文件；重跑 inventory AST 得到92个fake／40文件、57个sink API文件、65个raw factory调用／14文件；TypeScript 5.9.3最小PoC；`bun run typecheck`；`FORCE_COLOR=0 bun scripts/parallel-test.ts unit it http`；O-6隔离server＋显式`cmp`；最终确认被审树clean、测试端口已释放、4141主服务器PID 509044始终存活。
- 总体 verdict：存在 blocker；RFC不能进入实施计划／编码阶段，需先重排cutover并闭合类型、facade、heartbeat、golden与open questions。
- blocker 数量：6。
- 各级别计数：blocker 6，major 4，minor 1，nit 0。

## 事实性发现

[blocker] RFC:527-530,550-556,574-580,681-688；代码 `/home/xp/src/copilot-api-js/.worktrees/anchor-alloc/src/routes/chat-completions/handler-v4.ts:588-665`、`/home/xp/src/copilot-api-js/.worktrees/anchor-alloc/src/routes/responses/handler-v4.ts:423-507`、`/home/xp/src/copilot-api-js/.worktrees/anchor-alloc/src/routes/gemini/handler-v4.ts:456-512`、`/home/xp/src/copilot-api-js/.worktrees/anchor-alloc/src/routes/messages/handler-v4.ts:700-719`、`/home/xp/src/copilot-api-js/.worktrees/anchor-alloc/src/routes/responses/ws.ts:434-506` — Commit 2 的 `legacyEmissionFacade` 无法用§3已定义的 commands 单向表达现有 terminal 调用，同时保持 wire／settle／finalize 顺序；§9.3(7) 构成循环依赖 — 抽查的五类真实调用都把“发送 terminal frame”与“决定／冻结请求结局”分成两步：CC、Responses HTTP、Gemini 都是 `writeSynthetic`（或 `[DONE]` 的 `write`）→ `recordForwarded` → `ctx.fail/complete` → `finalize`；Anthropic 是 close → synthetic send → snapshot/settle；Responses WS 还要求 send/sample → settle → socket close。§3只有 `emitGeneric`（明确拒绝 terminal effect）和 `terminate`（同一 command 内平衡、发 terminal、停 heartbeat、seal operation），没有“仅发送尚不 seal 的 legacy terminal”命令。若 facade 把 `writeSynthetic`／`write([DONE])`映射到 `terminate`，它会在 `recordForwarded`／`ctx.settle` 前 seal/finalize；若等到旧 `finalize` 才发送，handler会在terminal sampling前冻结History；若回落旧raw writer，则违反共同门第2项。物理上当前序列做不到。必须在RFC定稿前验证闭合切法：优先把Commit 2与Commit 5的terminal/typed-operation-result迁移原子合并；若坚持分开，则明确增加生命周期受限的send-only legacy terminal command，证明它不会成为终态第二入口，并修订“只允许两个临时control”。

[blocker] RFC:193-211,525-530,550-580；代码 `/home/xp/src/copilot-api-js/.worktrees/anchor-alloc/src/lib/pipeline/driver.ts:1178-1191,1213-1266,1346-1403,1471,1628`、`/home/xp/src/copilot-api-js/.worktrees/anchor-alloc/src/lib/anthropic/live-reconcile.ts:138-165` — Commit 2删除raw heartbeat并让owner成为唯一timer，但新port无法表达旧driver的可恢复heartbeat协调 — 现有driver直接调用`freezeHeartbeat`、`suspendHeartbeat`、`resumeHeartbeat`、`close`；`emitKeepalive`只发送ping，`terminate`会永久seal，都不能替代flush期间暂停后重臂。Commit 4才迁indexed lifecycle、Commit 5才迁terminal，因此Commit 2移除旧sink lifecycle capability后，buffered flush无法保持无插帧；保留旧方法则owner并非唯一heartbeat capability。物理上当前序列做不到。应先把heartbeat lifecycle提升为owner coordination API，例如compound flush command或owner-scoped `withHeartbeatSuspended`，并在Commit 2与所有freeze/suspend/resume调用同commit迁移；或者把raw heartbeat移除与Commit 4合并并重写Commit 2终态。该缝还须加入§9.3。

[blocker] RFC:514-521,534-548,590-596；代码 `/home/xp/src/copilot-api-js/.worktrees/anchor-alloc/src/lib/pipeline/delivery/session.ts:99-137,358-481,483-549`、测试 `/home/xp/src/copilot-api-js/.worktrees/anchor-alloc/tests/pipeline/allocation-outside-owner-control.it.test.ts:54-134` — Commit 0和Commit 1的新behavior gates存在时间悖论 — Commit 0要求“不改production”，却要求§5每类route witness／R-1～R-13骨架在正确旧行为上全绿；旧实现没有command id、validated envelope、profile commands、cardinality assertion或typed socket close intent，且现成正控证明真实delivery session可经`clientSink.writeAnchor`产生重复wire index。共同门第6项却要求本commit新增witness正样本为绿。Commit 1只引入`commandPortActivation:"reject"`且不接outer roots/consumers，production mutation仍不触达新core。物理上无法同时得到“旧production不动”“目标架构正样本绿”“目标production mutation红”。应把Commit 0限定为legacy behavior/golden与旧缺陷red characterization；command-id/effect/cardinality production witnesses在Commit 2/4接线后才成为硬门。若要求首commit即绿，则测试harness与最小可驱动command core/composition接线必须合并。

[blocker] RFC:550-556,590-596；测试 `/home/xp/src/copilot-api-js/.worktrees/anchor-alloc/tests/pipeline/client-sink.unit.test.ts:64-87,90-135,149-180`，生产 `/home/xp/src/copilot-api-js/.worktrees/anchor-alloc/src/lib/pipeline/client-sink.ts:187-215,245-379,486,618-692` — Commit 2删除raw第二serializer／raw heartbeat，与Commit 7才迁移全部测试面互相矛盾 — 当前raw tests直接断言`makeArraySink`自行FIFO serialize、`makeSseSink`/`makeWsSink`接受裸`ClientFrame`，并有整组raw heartbeat计时行为。Commit 2按目标改raw adapter后这些测试立即编译或行为失败；保留旧实现至Commit 7又违反Commit 2的一个serializer／heartbeat；仅藏进test-only export仍保留第二套实现且不再证明production adapter。测试迁移必须随责任变更前移：Commit 2同步迁raw transport byte/attempt-observation、serializer ownership和heartbeat production witnesses并建立test-only envelope adapter；Commit 3/4/5分别同步迁generic、indexed、terminal/finalize测试；Commit 7只做旧API归零审计和adversarial positive-control保留。92/57/65不是可在Commit 7一次处理的独立surface。

[blocker] RFC:514-521,566-580,598-604；测试 `/home/xp/src/copilot-api-js/.worktrees/anchor-alloc/tests/pipeline/buffered-anchor-golden.it.test.ts`、`/home/xp/src/copilot-api-js/.worktrees/anchor-alloc/tests/anthropic/c0-live-anchored-direct-stream-golden.http.test.ts` — Commit 8延迟更新设计性变化的goldens，与Commit 4～7每步全套件0 fail直接互斥 — RFC承认Commit 4/5会使anchor/terminal顺序goldens变红，却到Commit 8才recapture。正确production在Commit 4/5改变wire后旧golden必红；若仍绿，Commit 8就没有合法变化；临时skip或双接受则违反共同门与“禁止放宽判据”。应在每个改变wire的semantic commit里，在独立oracle已建立的前提下同步更新对应golden及逐帧理由；或把Commit 4/5各拆成“独立oracle＋future fixture预捕获”和“原子实现切换＋期望切换”。Commit 8只能做纯审计／删除旧fixture。

[blocker] RFC:3,638-671,690-692；仓库 `/home/xp/src/copilot-api-js/docs/rfc/2026-08-03-generation-emission-command-algebra/design.md:640-671` — RFC实际仍未定稿：Q1、Q3、Q4分别阻塞Commit 6、Commit 0和Commit 6，且仓库无后续裁决 — `git log`显示RFC提交`268237d4`之后没有闭合这些问题的RFC/decision提交；文件标题区也仍写“草案”。按当前文字，实施必须在Commit 0因Q3停摆，Q1/Q4也没有默认可执行schema。这里是缺少必需输入，不是工程量。进入plan前必须取得并落盘用户裁决：至少冻结Q1、Q3、Q4，并同步§7对应commit与schema；Q2可按默认B不阻塞。文档外已有裁决也必须回写真相源，不能让implementer从对话猜。

[major] RFC:278-299；代码 `/home/xp/src/copilot-api-js/.worktrees/anchor-alloc/tsconfig.json:3-19` — §3.5 concrete-profile隔离可实现，但要求的widened-union narrowing不成立 — `/tmp/command-algebra-types-poc.ts`逐字复现`CommandsFor<P>`、`GenerationDeliveryOwner<P>`与`const P extends FormatDeliveryProfile`，用TypeScript 5.9.3和本仓strict options编译：Responses concrete owner上的`openAnchor`正确compile-red，Anthropic concrete owner compile-green；但`widenedOwner.profile.indexedBlockLifecycle === "anthropic"`后调用`widenedOwner.commandPort.openAnchor()`报TS2339，因为generic object的`profile`与条件类型产生的`commandPort`不是可相关收窄的discriminated-union members。§3.7第4项是正确实现也过不了的false-red gate。改为按profile分配的owner union，例如`P extends unknown ? { profile: P; commandPort: CommandsFor<P> } : never`并PoC，或要求先收窄profile再调用factory并删除“owner构造后再窄”的验收；两种方案都须重跑concrete正负样本与widened双控。

[major] RFC:514-520,598-611,714；脚本 `/home/xp/src/copilot-api-js/.worktrees/anchor-alloc/exp/inter-block-anchor-allocator/byte-equivalence.sh:4-11,69-86,119-161` — O-6可运行，但按RFC字面运行会覆盖权威fixture而不比较，形成false-green — 我用`CAPTURE_OVERRIDE=/tmp/command-algebra-o6-review.sse WORK_DIR=/tmp/command-algebra-o6-review`实跑：非4141端口34573，归属校验通过，3.184秒完成，SHA/764 bytes一致；随后另行`cmp`才得到rc=0。脚本默认`CAPTURE`正是tracked `pre-change-wire.sse`，全文无`cmp`。执行者只运行脚本会用错误输出覆盖基线，再打印新hash。应把门冻结成“临时capture＋显式`cmp`＋断言fixture blob未变”，或把脚本改为默认临时文件并内建compare、另设显式`--recapture`。脚本依赖Linux `/proc`、`ss`、python3、curl、GitHub token和Bun，但本环境逐commit约3.2秒，现实障碍是默认覆盖语义而非耗时。

[major] RFC:146,189,204-211,256,681-684；代码 `/home/xp/src/copilot-api-js/.worktrees/anchor-alloc/src/lib/pipeline/types.ts:935-1012`、`/home/xp/src/copilot-api-js/.worktrees/anchor-alloc/src/lib/pipeline/driver.ts:1033-1052`、`/home/xp/src/copilot-api-js/.worktrees/anchor-alloc/src/routes/chat-completions/handler-v4.ts:293-369` — “profile builders由concrete codec实现”跨过了未读通的common/terminal数据格式缝 — 现有`FormatCodec`只导出`renderResponse(frame, env)`、candidate `flushResponse`和`formatError(err, env)`；driver拿到的已经是任意`ClientFrame`，而RFC又禁止`GenericEmissionCommand`让caller提交最终frame。CC真实路径的`onRenderedFrame`还会恢复tool name、累积状态并可丢帧。owner若只收现成frame就不是“由builder构造”；若收upstream frame/env/candidate renderer，就会吸收response processor的candidate-local mutable state，与窄delivery profile边界冲突。此处做得到但RFC没说清。§9.3须新增逐profile/command调查：调用时点实际拥有的值、builder签名和state owner；若允许already-rendered frame作为`emitGeneric`输入，要明确classifier/provenance边界；若坚持重建frame，必须先重划response processor与owner职责。

[major] RFC:71,247-254,311-324,681-683；代码 `/home/xp/src/copilot-api-js/.worktrees/anchor-alloc/src/lib/pipeline/driver.ts:883-888,1012-1019,1097-1105,1521-1586`、`/home/xp/src/copilot-api-js/.worktrees/anchor-alloc/src/lib/pipeline/delivery/session.ts:402-415` — `LegHandle`在后续real-block command时点当前不可得 — production driver的四个`beginLeg`调用均丢弃返回token，后续rendered frame也没有携带leg/block handle；现有production尚未调用`writeBlockFrame`，只有测试接线。RFC却冻结caller在`openRealBlock`／`writeRealBlockFrame`回传opaque handle。存到driver generation/candidate binding是可做的，但须冻结跨hedge/recovery/continuation生命周期与归属。实施计划前应PoC从每个`beginLeg`production点追到real start/delta/stop，证明handle可无歧义传递；否则改用owner内部active-leg解析或当前时点真实可得的candidate/dispatch identity。

[minor] RFC:5,42-46,429,519；代码基线 `/home/xp/src/copilot-api-js/.worktrees/anchor-alloc` — RFC锚定`854421d4`，实施基线已是`2c339784` — 两者目前只有`/home/xp/src/copilot-api-js/.worktrees/anchor-alloc/tests/architecture/anchor-remap-single-authority.unit.test.ts`六行差异；我在新HEAD重跑inventory仍得到92/40、57、65/14，direct transport population也不变，因此尚未造成结论错误，但planner按旧SHA取锚会漏HEAD guard变化。定稿时统一更新基线，并注明inventory在`854421d4`测量、在`2c339784`复核人口不变。

## §7 十个 commit 的可满足性与重排

| Commit | 当前可满足性 | 结论与必要重排 |
|---|---|---|
| 0 | 不可满足 | 旧production不具备目标command-id/profile/cardinality正样本。只冻结legacy goldens、旧行为与old-boundary red characterization；目标架构witness延后到首次接线commit。Q3还必须先裁决。 |
| 1 | 不可满足 | concrete profile类型门可做，但widened gate false-red；disabled core无法提供production-path mutation。先修owner分配union或调整narrowing oracle；本commit只允许unit/type双控。 |
| 2 | 不可满足 | terminal facade、heartbeat lifecycle和raw tests三处都无法跨过。建议与当前Commit 5的terminal/result迁移，以及heartbeat coordination与相应测试迁移合并成一个composition-authority cutover。 |
| 3 | 条件可满足 | common generic/profile迁移本身可做；前提是明确already-rendered frame与builder边界，并且Commit 2已提供无歧义facade或直接把remaining consumers按command family迁掉。 |
| 4 | 条件可满足 | indexed state必须原子迁移合理；前提是LegHandle数据流PoC、heartbeat coordination已落地、相关测试与golden在本commit同步更新。不能把测试/golden拖到7/8。 |
| 5 | 不应独立保留 | 其terminal/typed operation result是Commit 2 facade成立的前提，应前移与raw authority移交合并；Responses WS control仍可在同一semantic commit内分子提交准备，但最终commit边界必须同时绿。 |
| 6 | 条件可满足 | 先裁Q1/Q4并确定settle冻结点；telemetry可在boundary稳定后独立接入，且不得改变wire。disabled facade只适合作归零guard，不可弥补前述缺失command。 |
| 7 | 当前不可满足 | 不能一次迁92/57/65；前面每个API/责任变化commit必须同步迁对应测试。重定义为最终surface删除、barrel私有化、AST归零与adversarial positive-control审计。 |
| 8 | 当前不可满足 | 延迟recapture会让Commit 4～7红。把golden期望更新搬到实际改变wire的Commit 4/合并后的terminal commit；Commit 8仅做独立oracle复核或删除旧fixture。O-6 fixture永不recapture。 |
| 9 | 条件可满足 | docs-only同步可独立；O-6须用临时capture＋cmp，不能默认覆盖fixture。更新基线、裁决、supersede关系和每条当前状态claim后再跑merged-state review。 |

推荐序列不是“做最小版”，而是按真实依赖重排完整方案：A）legacy baseline/oracle分类；B）类型/profile与disabled core unit验证；C）composition/raw authority＋heartbeat coordination＋terminal/typed result＋对应测试原子cutover；D）common profiles；E）Anthropic indexed＋LegHandle数据流＋对应goldens；F）telemetry/History；G）legacy surface最终删除与population审计；H）docs/merged-state收口。若C过大，可在同一最终commit前做不改变可观察行为的准备提交，但不能留下违背共同门的仓库commit。

## 结构怪味扫描

- `/home/xp/src/copilot-api-js/docs/rfc/2026-08-03-generation-emission-command-algebra/design.md:527-530,681-688` — 怪味：计划依赖循环／“先依赖成立，后调查能否成立”。处置：RFC本轮必须修，不能留backlog；它直接阻塞Commit 2。
- `/home/xp/src/copilot-api-js/docs/rfc/2026-08-03-generation-emission-command-algebra/design.md:550-596` — 怪味：测试责任被集中到删除阶段，和production责任迁移不同步。处置：RFC本轮按被测责任把测试迁移分摊到Commit 2～5；Commit 7只做归零审计。
- `/home/xp/src/copilot-api-js/docs/rfc/2026-08-03-generation-emission-command-algebra/design.md:598-604` — 怪味：golden更新与行为改动分离到多个必绿commit之后，产生false-red窗口。处置：RFC本轮重排，golden随行为改变commit同步更新并由独立oracle先裁决。

## 主观建议与替代路径反思

[建议] RFC §3／§7 — 更好的项目内替代不是缩小command algebra，而是把切分轴从“production先改、测试最后清”改为“按capability与observable contract垂直切”：raw authority/heartbeat/terminal一起切，common与indexed再分开 — 预期影响：每个commit都可独立bisect且共同门真实可跑 — 推荐由`gpt-souls:architect-advisor`重写RFC cutover，随后由`gpt-souls:planner`写实施锚点表。

[建议] 类型判据 — 当前判据能抓concrete capability泄漏，但widened正样本判别力不足且false-red；用真实`tsc` fixture继续比引入只做type-test包装的第三方库更贴合本仓配置 — 预期影响：避免“测试框架绿、项目tsconfig红” — 推荐保留原生TypeScript 5.9.3双控，修owner返回union形状；没有必要为此另引`tsd`。

[建议] 第三方方案扫描 — 本RFC核心是项目特有stream authority/state machine，没有成熟库可替代owner command algebra；serializer可继续使用现有单链原语，protocol oracle继续用真实SDK/route而非自建完整协议库 — 预期影响：避免重复造一个通用event-sourcing/actor框架，同时不牺牲完整功能 — 推荐只在类型测试或state-machine建模出现独立需求时再评估`tsd`/XState，本轮不把库替换冒充可行性修复。

## 验证结果

- `bun run typecheck`：通过，29.758秒。
- `FORCE_COLOR=0 bun scripts/parallel-test.ts unit it http`：6848 tests，6848 pass，0 fail，41.65秒；该结果仅证明当前基线健康，不证明RFC gates可满足。
- Type PoC：concrete positive/negative通过；widened owner narrowing报TS2339，证实§3.7 false-red。
- O-6：隔离端口34573，3.184秒，capture SHA-256为`1c6163c62f568fd5e1a46605c23716d1017b47232021b371f3cb145b2a4277f9`、764 bytes，显式`cmp`通过；脚本自身不执行compare。
- 安全／只读复核：被审worktree最终`git status --short`为空；34573无listener；4141仍由原bun PID 509044监听，未触碰。

## 最终结论

当前RFC的目标架构方向可以实施，但文档给出的10-commit cutover物理上不可执行：它要求若干能力在被定义／接线／迁移前已经满足，又把测试和golden更新推迟到此前每个commit必须全绿之后。先修复6个blocker并重新做实施可行性复评；修复方应由架构角色重写RFC与commit invariants，而不是让implementer在编码时自行裁决。

# 复评轮（master `a4dcc8d7`）

## 复评元数据

- 评审范围：修订后RFC 767行，对照上一轮`268237d4`及代码基线`/home/xp/src/copilot-api-js/.worktrees/anchor-alloc` @ `2c339784`。
- 证据状态：复评进行中；逐条处置核验后追加。
- 总体 verdict：待完成。
- blocker 数量：待完成。

## 处置核验与新增事实性发现

[blocker] RFC:526,530,548-564,566-590；代码 `/home/xp/src/copilot-api-js/.worktrees/anchor-alloc/src/lib/pipeline/driver.ts:947-952,1033-1052,1246-1266,1305-1320`、`/home/xp/src/copilot-api-js/.worktrees/anchor-alloc/src/lib/anthropic/live-reconcile.ts:138-165` — 删除terminal facade并合并terminal cutover闭合了上一轮terminal顺序缺口，但新Commit 2仍无法承载尚未到Commit 3/4才迁移的common与indexed旧writes — Commit 2要求raw authority已完全移交、new command不回落raw writer；§7.1同时承认“旧API只能单向适配新owner”，`ClientSink.write*`直到Commit 6才删除。可是Commit 3才把ordinary frames改成`emitGeneric`，Commit 4才建立real-block mapping并把block start/delta/stop改成indexed commands。Commit 2结束时，driver/live/buffered/retreat仍把已rendered block frames送旧`write`；`emitGeneric`按§3.3必须拒绝indexed effects，而mapping/LegHandle尚不可用，故不存在可调用的新command。让adapter仅按payload猜indexed intent会重新引入已否决的隐式facade，且在Commit 4前没有authorization可验证；直达raw又违反Commit 2终态。这是“门逐级激活”新制造的无人看守窗口，物理上做不到。修复只能二选一：① 把common与indexed producer/mapping cutover一并前移到authority切换的同一semantic commit（允许前置纯准备commits），然后后续commits只增强类型/telemetry；② 在Commit 2前定义并证明一套临时legacy command adapter可表达ordinary与indexed authority，但这等价于恢复facade，必须明确生命周期和验证，不能继续声称“facade整个删除”。工程量不是判据；关键是authority发布与所有消费者改用可授权command必须原子。

[major] RFC:499,512,526,555,587 — facade删除后的文本仍互相矛盾 — C8仍写“旧consumer单向适配新owner”，§6.4仍写“每个commit的单向facade”，§7.1仍允许旧API adapter，Commit 6才删除`ClientSink.write*`；而Commit 2又明确“不使用legacy facade”。这些不是纯措辞：它们正好掩盖上条blocker的过渡机制。修复时必须统一术语并列出每个Commit边界仍存活的旧API及其唯一target command；若目标是零facade，则authority cutover commit后旧generation write API人口必须为零。

[已闭合] 上轮blocker“terminal facade无法表达” — 新`terminate → recordForwarded → ctx settle → finalize(typedResult)`在RFC:193-213定义了正确顺序，Commit 2把五类handler、`[DONE]`、Responses WS与termination tests同commit切换；对照现有五类handler代码，该形状可保存attempt-before-settle并避免finalize发帧。闭合范围仅限terminal；不覆盖上面的ordinary/indexed过渡。

[已闭合] 上轮blocker“heartbeat lifecycle无法表达” — `runEmissionBatch`在RFC:199,209定义owner serializer内suspend→全量validate→顺序执行→fresh rearm，terminal禁止rearm；RFC:550,679,609把所有freeze/suspend/resume/close逐点映射设为Commit 2前证据槽和硬停门。停点在Commit 2 kickoff必经，已可达。实施时须使用内部non-enqueue command primitives，不能在serializer callback内await再次enqueue的public commands，否则会自锁；该细节应进plan，但RFC性质足够。

[已闭合] 上轮blocker“Commit 0/1时间悖论” — RFC:530-546与R-1/R-3/R-5明确按commit激活：C0只做recorder自检和legacy red characterization，C1只做直接驱动disabled core的type/unit正负样本，production gates延后到接线commit；不再要求旧production为目标command-id绿。

[已闭合] 上轮blocker“测试迁移集中到最后” — RFC:530,554,563,573,582,590把raw/terminal、common、indexed/golden、History/telemetry测试分别绑定责任变更commit，Commit 6只删已归零壳；每处guard删除均要求独立裁决记录。

[已闭合] 上轮blocker“golden延迟重捕” — RFC:508,572,595-598,665把Q5预测diff设为Commit 4前停门，独立O-1/O-2/SDK先绿后在同semantic commit更新golden，Commit 7只审计；O-6 fixture明确永不重捕。该触发点在Commit 4前置条件和kickoff证据槽重复出现，可达。

[部分闭合／仍阻塞实施] 上轮blocker“Q1/Q3/Q4未裁决” — Q4已在RFC:664按方案B闭合并绑定Commit 5；Q1仍明确阻塞Commit 5，Q3仍明确阻塞Commit 0（RFC:635-658,684）。停点已写清且可达，但整个实现序列仍不能启动，因为Q3位于首commit入场；若本轮目标只是证明“遇到未裁决会诚实停”，机制已闭合，若目标是进入实施，则Q3仍是现存外部blocker，Q1最迟在Commit 5前仍需裁决。

[已闭合] 上轮major“O-6脚本会覆盖fixture” — 在master `a4dcc8d7`实跑修订脚本：非4141端口50091，capture写`/tmp/command-algebra-o6-rereview-master/current-wire.sse`，打印`O-6 PASS`，rc=0，3.417秒；fixture git blob运行前后均为`4da1c3f2f99d48b3314dbc5036a665c33246165c`，worktree无fixture改动。脚本在`RECAPTURE!=1`时内建`cmp`，差异rc=9；RFC每commit禁`RECAPTURE=1`。4141未触碰。

[已闭合] 上轮major“widened union false-red” — RFC:542,703不再预设原shape可行，要求本仓PoC在两条路线间裁决。我的TypeScript 5.9.3复评PoC `/tmp/command-algebra-types-rereview.ts` 证实两条都可行：最简单是**先narrow profile再factory**，原generic factory即可得到Anthropic port；若必须factory后narrow，则仅做distributive owner不够，必须把`indexedBlockLifecycle`复制为owner顶层discriminant（检查`owner.indexedBlockLifecycle`），因为检查嵌套`owner.profile.indexedBlockLifecycle`仍不会相关收窄 sibling `commandPort`。建议选先narrow再factory：无重复discriminant、与已知route composition相符；同时把RFC:303的宽化对照明确成“profile先narrow后factory”，避免实现者误试嵌套收窄。

[已闭合] 上轮major“builders缝／LegHandle不可得没有停点” — builder边界在RFC:560和609绑定Commit 3 kickoff；indexed native data、builder exports、LegHandle在RFC:675、686、568、609绑定Commit 4 kickoff，缺file:line/PoC必须结束本轮。它们位于每个commit的前置条件与总证据槽表，未来执行会话必经，触发点可达。

[minor] RFC:448,502,566-571,622,677,702,716,743；代码 `/home/xp/src/copilot-api-js/.worktrees/anchor-alloc/src/lib/pipeline/types.ts:295-331` — 扩大范围后的leg/mapping人口术语不一致，足以让planner漏矩阵维度 — production有5个`beginLeg`调用点，但语义`LegToken.kind`只有`primary | continuation | recovery`三类；“hedge winner”是primary来源分支，不是第四个leg kind。RFC交替写“三腿”“四腿”“四role”，甚至“primary、hedge、continuation、recovery四腿”，而验证只写“三腿／四role”。这会导致O-1/O-2 mutation究竟按3 kinds、4 source roles还是5 lexical sites展开不明确。建议冻结三层口径：5个production call sites；3个leg kinds；4个source scenarios（sole primary、hedge winner、continuation、recovery），并在Commit 4/R-5/O-1统一矩阵与命名。


## 复评最终结论

- 总体 verdict：存在 blocker；修复major后仍不可进入实施计划。
- blocker数量：2。其一为本轮新发现的authority cutover窗口；其二为Q3仍在Commit 0前未裁决，若裁决A/B落盘后可机械闭合。
- 各级别计数：blocker 2，major 1，minor 1，nit 0。上一轮6 blocker中，5项机制已闭合；open-question项仅Q4闭合，Q1/Q3保留了诚实且可达的停门。上一轮4 major均已闭合；类型两条可行路径已用TypeScript 5.9.3 PoC证实。
- 新Commit 2“过大”本身不是缺陷，且RFC允许纯准备提交；真正障碍是它在raw authority发布时仍把ordinary/indexed producer迁移留到后续Commit 3/4，因此无法满足自己的一次physical emit与new-command-only门。新Commit 4范围虽大，但mapping/offset/LegHandle共享state原子切换有物理理由，且前置停门可达；修正leg人口口径后未发现必须再拆的障碍。
- 推荐修复：把所有generation producer切换到可授权commands与raw authority发布放在同一semantic commit；可以在此前有任意数量不改变observable behavior的准备commits。若坚持C2/C3/C4分开，就必须恢复并规格化临时adapter，不能同时宣称facade已删除。随后裁决Q3，统一三腿/四scenario/五site矩阵，再复评。

## 复评证据摘要

- RFC：完整读取修订后的关键类型、§6～§11与全量load-bearing关键词；对照`268237d4..a4dcc8d7`修订。
- TypeScript PoC：`/tmp/command-algebra-types-rereview.ts`；“先narrow profile再factory”通过；“factory后narrow”只有在owner顶层复制discriminant后通过，嵌套`owner.profile`收窄仍失败。
- O-6：master脚本默认路径实跑PASS，rc=0，3.417秒，fixture blob前后相同；非4141端口50091已释放。
- 只读/安全：代码基线worktree最终clean；4141仍由原PID 509044监听，未触碰；未运行全套件，因为本轮只改RFC/O-6/type PoC，且用户已说明baseline flaky另路修复，上一轮已在同代码HEAD取得6848/6848。

## 结构怪味复扫

- `/home/xp/src/copilot-api-js/docs/rfc/2026-08-03-generation-emission-command-algebra/design.md:526-590` — 怪味类型：authority发布与consumer迁移分属不同commit，形成无合法adapter的中间态。处置：本轮必须修，不能记backlog；直接阻断cutover。
- `/home/xp/src/copilot-api-js/docs/rfc/2026-08-03-generation-emission-command-algebra/design.md:499,512,526,555,587` — 怪味类型：已删除facade但旧术语/旧API生命周期仍双源。处置：本轮统一并显式列每commit旧API population。
- `/home/xp/src/copilot-api-js/docs/rfc/2026-08-03-generation-emission-command-algebra/design.md:448,566-571,622,716` — 怪味类型：同一population按“三腿/四腿/五点”混名。处置：本轮统一为3 kinds/4 scenarios/5 sites，避免测试矩阵漏项。

## 主观建议复核

[建议] 内部替代方案 — 最佳路径仍是完整command algebra，但采用“prepare freely, publish atomically”：类型、builders、owner primitives、test adapters可分多个无行为准备commit；最后一次发布raw authority时同时切所有producer — 预期影响：保留完整长期架构且每个可见semantic commit真实可bisect — 推荐由架构作者重排，不让implementer现场发明adapter。

[建议] 判据判别力 — revised recorder放在composition handle层、FakeClock先做unpark活性对照、门按接线commit激活，均显著增强双向判别力；现存缺口不是oracle强度，而是Commit 2～4之间没有合法production状态 — 推荐先修切分，再保留这些门不降级。

[建议] 第三方方案 — 本轮仍未发现成熟库能替代项目特有的generation authority/transport lifecycle；TypeScript原生compile fixture足以裁决类型形状，暂无引入`tsd`或状态机框架的必要。


# 第三轮复评（master `ddd01882`）

## 复评元数据

- 评审范围：第三轮RFC 762行，对照`a4dcc8d7`与代码基线`/home/xp/src/copilot-api-js/.worktrees/anchor-alloc` @ `2c339784`。
- 证据状态：进行中。
- 总体 verdict：待完成。
- blocker数量：待完成。

## 处置核验与新增发现

[major] RFC:533-544,571-586；代码 `/home/xp/src/copilot-api-js/.worktrees/anchor-alloc/src/lib/pipeline/delivery/session.ts:506-544`、`/home/xp/src/copilot-api-js/.worktrees/anchor-alloc/src/lib/pipeline/driver.ts:883-905` — §7.2/Commit 4的“旧generation API population为零”清单仍漏了非write但属于旧owner公共surface的production consumers，导致§7.7与§7.9不一致 — 真实production除列出的`ClientSink.write*`、allocation commands、heartbeat controls、terminal/finalize外，还调用`DownstreamDeliverySession.noteWinner`（driver:888）；`noteUpstreamRoundStarted/Ended`虽然当前无consumer，定义仍在旧surface；`writeScaffold`在Commit 6才声明删除。Commit 4清单没有说明winner/round diagnostic如何进入新owner，§7.2却宣称全部旧generation API调用population为零，Commit 6才删definitions。`noteWinner`不是physical producer，但它为winnerCandidateId/provenance observation供事实；若漏迁，新owner snapshot/telemetry会退化或driver仍需旧session handle，违反“runner/driver只拿command port”。修复建议：把旧population拆成两张机械集合：A）所有会产生/协调wire effect的调用，Commit 4必须零；B）所有旧`DownstreamDeliverySession`公共consumer（含`noteWinner`和任何round diagnostics），同commit迁到新owner observation/command API或明确保留的窄observer。§7.7清单增加winner/provenance/round迁移，§7.2和Commit 6删除清单对齐，并用AST/type-checker冻结两集合。

[minor] RFC:705,753 — Q3已裁决A，但R-13仍写“Q3待裁”，残余出口仍写“Q3 test纳入并通过；缺test时...” — 这是修订新引入的状态漂移；不会阻止执行，因为Commit 0正文和§9.2已明确，但会让验收表误报NOT-YET-IN-SCOPE。修复为“已裁A；Commit 0硬门”，删除条件语气。

[已闭合] 上轮blocker“authority发布窗口” — RFC:523-586现明确Commit 1～3不构造production owner、不shadow state/sample/timer，Commit 4同一semantic commit切ordinary、keepalive、envelope/anchor/real、heartbeat、terminal、WS control并使旧wire-effect调用归零；准备commits均有可机械检查的无副作用边界。除上面漏列的observation consumer外，raw authority与producer发布窗口已闭合。

[已闭合] 上轮major“facade残留措辞” — RFC:513,527,544,615仅保留否定性表述，明确不存在跨commit facade、payload guessing或new→legacy回落；§7.2按commit列旧API population，未再以facade掩盖过渡。

[已闭合] 上轮minor“leg人口混名” — RFC:503,566,578,585,624,670,697,711统一冻结5 lexical sites／3 leg kinds／4 source scenarios，并明确hedge winner属于primary；Commit 4与R-5/O-1一致。

[已闭合] 上轮第二blocker“Q3未裁” — RFC:658,679将Q3裁为A并移除停点，Commit 0:548-550纳入warmup route硬门。仅剩R-13/残余表的minor stale文字。Q1仍open但有Commit 5前可达停门，不阻塞Commit 0～4；RFC可在先完成边界cutover后于Commit 5诚实停下，是否要求整份RFC开工前裁Q1由主会话决定，当前没有自相矛盾。

[已闭合] 类型shape — RFC:282-304已正式选择先narrow profile再factory，保留factory后嵌套narrow compile-red characterization；与上一轮TypeScript 5.9.3 PoC一致。

[已闭合] 对抗评审三项 — RFC:210,566,574,580,674精确纳入10个terminal-close decisions（8 handler+2 driver）并要求逐点证据；R-7:699增加“terminate跳过active anchor balance”mutation与无-anchor/client-gone/session-terminating false-red；Q5:509,573,660,674包含heartbeat重臂逐tick变化和发布前预测diff停门。


## 第三轮最终结论

- 总体 verdict：修复major后可进入下一阶段。
- blocker数量：0。
- 各级别计数：blocker 0，major 1，minor 1，nit 0。
- **无未决blocker；仍有1个major，故尚不能直接收口。** Major是Commit 4旧owner public consumer population不完整：`noteWinner`等observation/provenance consumer未进入原子发布清单。它不要求缩范围或拆小方案，修复是把该population与迁移target补全并用AST冻结。修复后无需重做架构方向，只需针对§7.2/§7.7/§7.9做一轮聚焦复评。

## 新序列可执行性判断

- Commit 0可执行：只加legacy characterization/recorder/warmup硬门，不要求目标command行为。
- Commit 1可执行且无可观察变化：types/profile/compile fixtures不被production import调用；已用PoC裁决narrow路径。
- Commit 2可执行且无可观察变化：新owner primitives仅由unit adapter驱动；RFC明确禁止production construction、shadow state、timer、sampling/raw emit。plan需防public command在serializer内部重入enqueue。
- Commit 3可执行且无可观察变化：pure builders、LegHandle carrier、publish harness均不得注册live roots或影响routing；“diff出现live call-site切换即越界”可机械审计。
- Commit 4作为单一大semantic commit可执行：工程量大不是否决理由；9类wire/producer切换覆盖inventory中的ordinary、named synthetic、anchor/envelope、real mapping、heartbeat、terminal、WS control、tests/goldens。唯一缺口是旧session observation consumer未列入population，补齐后可原子发布。纯准备commit允许将实现复杂度前移而不制造半坏仓库状态。
- Commit 5～8均条件可执行：Q1在Commit 5前停；其余只做telemetry、definitions/exports删除、golden审计、docs收口，不重开wire。

## 证据摘要

- 完整读取第三轮RFC关键接口与§6～§11；对照`a4dcc8d7..ddd01882`的185行变更。
- 对代码基线重新扫描所有`ClientSink`/allocation/heartbeat/finalize调用与`DownstreamDeliverySession`方法consumer，发现`driver.ts:888 noteWinner`不在population表。
- 核对10个terminal-close decisions、5/3/4 leg人口、Q3/Q5、R-7 mutation、types narrowing与每commit旧API表。
- 未重跑O-6/全套：本轮只改RFC，上轮已在同脚本/代码基线实跑O-6 PASS且fixture blob不变；代码worktree仍clean，未触碰4141。
- 并发状态说明：复评取证时master为`ddd01882`；写最终段时共享主树已前进到`8a982cbf`，本报告结论仍严格针对指定commit`ddd01882`。

## 结构怪味复扫

- `/home/xp/src/copilot-api-js/docs/rfc/2026-08-03-generation-emission-command-algebra/design.md:533-544,571-597`（`ddd01882`行号）— 怪味类型：同一旧owner surface按“wire producer”和“definitions待删”两种人口列举，observation consumer落在缝外。处置：本轮修，建立wire-effect calls与owner-public consumers两张AST冻结表。
- `/home/xp/src/copilot-api-js/docs/rfc/2026-08-03-generation-emission-command-algebra/design.md:705,753`（`ddd01882`行号）— 怪味类型：已裁决状态在验收/残余表滞后。处置：本轮机械同步。

## 主观建议复核

[建议] 内部替代 — 当前“prepare freely, publish atomically”已是本项目内最佳完整切法；不建议因Commit 4大而恢复facade或拆authority窗口 — 预期影响：保持每个仓库commit可bisect且没有双writer — 推荐继续该序列，只补全owner observation/provenance consumer。

[建议] 判据判别力 — §7.2 population table是好方向，但“旧generation API”语义分类仍可能漏非write consumer；改成由明确symbol集合驱动的checker枚举，并冻结调用点集合，而非自然语言枚举 — 预期影响：同时防漏迁与合法test raw adapter false-red。

[建议] 第三方方案 — 核心仍无成熟第三方库可替代；原生TypeScript checker/AST足以做population与capability门，不需引入新依赖。


# 聚焦复评（master `5796eba5`）

## 复评元数据

- 范围：仅复核§7.2／§7.7／§7.9的A/B population、`selectWinner`过渡与三处一致性；证据commit `5796eba5`。
- 证据状态：进行中。
- 总体 verdict：待完成。
- blocker数量：待完成。

## 事实性发现与处置核验

[major] RFC:536-550,577-604；代码 `/home/xp/src/copilot-api-js/.worktrees/anchor-alloc/src/lib/pipeline/delivery/session.ts:45-100`、`/home/xp/src/copilot-api-js/.worktrees/anchor-alloc/src/lib/pipeline/client-sink.ts:497,699`、`/home/xp/src/copilot-api-js/.worktrees/anchor-alloc/src/lib/pipeline/driver.ts:883,944,1012,1097`、`/home/xp/src/copilot-api-js/.worktrees/anchor-alloc/src/routes/messages/handler-v4.ts:1112,1422,1772`、`/home/xp/src/copilot-api-js/.worktrees/anchor-alloc/src/lib/anthropic/keepalive-anchor.ts:280`、`/home/xp/src/copilot-api-js/.worktrees/anchor-alloc/src/lib/anthropic/live-reconcile.ts:139` — A/B 两集仍漏了第三个机械轴：旧session的**construction／resolution capability** — 模块公开面不只`DownstreamDeliverySession`对象的9个members，还包括`CreateDownstreamDeliverySessionOptions`（含raw `sink`、heartbeat、wireState和legacy mirror）、`createDownstreamDeliverySession`、`getDownstreamDeliverySession`、`getDeliverySessionForAllocationPort`及两张WeakMap lookup。production当前有2个constructor calls和至少10个lookup calls；这些lookup正是driver/decorator/injector恢复旧session／allocationPort的能力。§7.9仅含糊说删除“不再需要的session lookup”，但§7.2未冻结它们的人口，Commit 4九项清单也未逐点迁constructor/lookup，因此即使A/B都归零，旧session仍可被创建、解析并把handle重新泄给producer，违背§7.7“driver无旧session handle”。这是上一轮所问“第三轴”确实存在。修复建议：新增C集“construction/resolution surface”，按symbol冻结2个production constructors＋全部production lookup calls＋exported options/raw-sink capability；Commit 4把10 roots/2 internal chaining迁到新factory，并让production lookup人口归零（test-only observer另列合法人口）；Commit 6删除旧constructor/options/WeakMaps/lookups或转为不返回旧session handle的窄内部机制。§7.2/§7.7/§7.9和R-10同时加入C集。

[已闭合] 上轮major中的B集本身 — `DownstreamDeliverySession` interface 9项与代码`session.ts:57-67`逐项一致；`noteWinner`唯一production consumer确为`driver.ts:888`，三个零consumer methods经全仓production扫描成立。Commit 4新增`selectWinner(source)`窄observation command，明确不返回session/port/raw/emission能力且不发wire；§7.7第8项与§7.9删除列表对B集一致。

[已闭合] `selectWinner`准备期 — 类型在Commit 1增加、state primitive在Commit 2实现、producer helper可在Commit 3准备，但production driver到Commit 4前仍调用旧`noteWinner`并完整走旧session；新owner不在production构造、不shadow observation。Commit 4才原子切为`selectWinner`，因此Commit 1～3没有无人承载winner事实的窗口。

[已闭合] 上轮minor — R-13已改成“Q3已裁A；Commit 0硬门”，残余出口表不再写待裁，仅准确说明test必须纳入并通过。


## 聚焦复评最终结论

- 总体 verdict：修复major后可进入下一阶段。
- blocker数量：0。
- 各级别计数：blocker 0，major 1，minor 0，nit 0。
- **无未决blocker；仍有1个未决major，故尚不能宣称“无未决 blocker/major”。** A集wire/coordination与B集session object members各自完备，但两集并集不完备：漏掉C集construction/resolution capabilities。修复仅需扩展population与三处对账，不重开架构方向。

## 三处一致性裁决

- §7.2↔§7.7↔§7.9对A集：一致，Commit 4调用归零、Commit 6删definitions/exports。
- §7.2↔§7.7↔§7.9对B集：一致，Commit 4迁`noteWinner`并停止向driver暴露零consumer methods，Commit 6删除旧surface。
- 三处对完整旧authority surface：不一致/不完备；§7.9隐约提lookup，§7.2和§7.7没有C集人口与原子迁移清单，无法机械阻止旧factory/lookup继续存活。

## 证据摘要

- 逐项对照`DownstreamDeliverySession` 9 members与production consumers。
- 独立枚举delivery/session.ts全部exports与production calls：2个`createDownstreamDeliverySession` calls；`getDownstreamDeliverySession`、`getDeliverySessionForAllocationPort`在driver/handler/injector/decorator存在至少10个lookup calls；options暴露raw sink/heartbeat/wireState。
- 只读审查，未运行服务器或测试，未触碰4141。

## 结构怪味复扫

- `/home/xp/src/copilot-api-js/.worktrees/anchor-alloc/src/lib/pipeline/delivery/session.ts:45-100` — 怪味类型：public object surface与construction/resolution surface被当成同一人口轴，后者漏审。处置：本轮修，新增C集并以symbol identity冻结。

## 主观建议

[建议] 判据形状 — 不再继续补自然语言“还有哪些API”清单；从模块全部exports出发，把每个symbol disposition为A wire-effect、B object-member、C construct/resolve、test-only或保留internal — 预期影响：这次的第三轴不会再以第四种写法复发 — 推荐checker直接冻结symbol→category表和production consumer hit set。


# 最终确认（master `a1a0cdf8`）

## 复评元数据

- 范围：聚焦C集、完整能力面机械判据，以及§7.2／§7.7／§7.9／§2.4一致性。
- 状态：进行中。

## 最终确认结论

- 总体 verdict：可进入下一阶段。
- blocker数量：0。
- 各级别计数：blocker 0，major 0，minor 0，nit 0。
- **无未决 blocker/major。**

## 核验结果

[已闭合] C集人口 — 独立扫描确认旧authority取得路径包括：`createDownstreamDeliverySession`两个production construction点；`getDownstreamDeliverySession`从sink反查；`getDeliverySessionForAllocationPort`从allocationPort反查；两张WeakMap；以及`makeDeliverySseSink`／`makeDeliveryWsSink`等factory exports。RFC:538-558不再把列举的C成员当完备性来源，而是先枚举delivery目录与client-sink全部exports及production symbol references，再分类；`getDeliverySessionForAllocationPort`虽未在C集首句逐名重复，但被“任何等价WeakMap lookup／factory export”和driver helper`:940-944`冻结命中覆盖。Commit 4要求resolution人口为零、construction精确等于private composition allowlist；test-only export若进入production import/reference会落入unclassified failure。未发现第四种现存取得session/port路径。

[已闭合] 完整能力面判据可执行 — TypeScript checker可从module exports取得符号并沿alias解析re-export，AST可区分calls/property/element accesses/construction，type-only import也会进入候选hit set后具名处置为type-only而非运行时authority；`rg '^export '`仅被RFC标作候选人口，不是最终判官。新增export或production reference默认进入unclassified红集，反向direct-transport AST补足未经过delivery export的physical writes。非字面动态属性／reflection无法由静态checker完备枚举，但项目threat model不防恶意同进程代码，且§2.4的runtime adversarial resolution witness与physical recorder覆盖合法production供给；这不是正确性缺口。plan应让AST显式枚举string-literal element access，并把真正computed/reflection命中人工disposition。

[已闭合] 四处一致 — §2.4同时禁止raw下传与从sink/wrapper/observer反查authority；§7.2冻结A/B/C及unclassified fail-loud；§7.7第9项在authority发布commit迁完lookup/construction并加入恢复lookup的mutation；§7.9删除旧exports/WeakMaps/allowlist外constructors并对三集分别审计。Commit 1～3仍完整走旧construction/lookup，Commit 4才原子切换，无过渡空窗。

[已闭合] A集去重与authority分域 — `[DONE]`明确为10个`ClientSink.write`的说明性子集；WS混合physical helper在Commit 4拆分，post-owner部分归零，合法pre-owner admission/AUQ/warmup进入独立allowlist保持非零；不会用“全direct transport归零”制造false-red。

## 证据摘要

- 对照target commit `a1a0cdf8`读取§2.4、§7.2、§7.7、§7.9及变更diff。
- 在代码基线`2c339784`独立枚举delivery/client-sink全部exports、constructor/lookup/WeakMap路径和production references；核对driver、messages handler、live reconcile、keepalive anchor及client-sink chaining。
- 只读复评，未运行server或修改被审树，未触碰4141。

## 结构怪味复扫

- 扫描范围：`delivery/**`与`client-sink.ts`的全部export surface、production imports/calls/property accesses/construction/resolution、下游transport反向词法点；判据为“任何symbol/reference必须进入A/B/C或具名合法例外”。未发现未分类结构怪味。

## 主观建议

[建议] Commit 0 evidence实现 — 将“module export symbol → alias/re-export chain → production hit set → A/B/C/合法例外 disposition”固化成机器可读snapshot，而非只生成数字 — 预期影响：新增export自动红，后续复评无需再次靠自然语言找新轴 — 推荐使用仓库现有TypeScript compiler API，不引入第三方依赖。
