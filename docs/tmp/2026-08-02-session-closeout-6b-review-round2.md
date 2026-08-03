# session-closeout §6b 与 P3M kickoff 第二轮评审

## 评审结论

- **评审范围**：`/home/xp/src/copilot-api-js/.claude/skills/session-closeout/SKILL.md` 新增 §6b、`/home/xp/src/copilot-api-js/CLAUDE.md:54`，以及 `/home/xp/src/copilot-api-js/docs/plan/2026-07-27-inter-block-anchor-allocator/kickoff.md:129-153` 的 P3M 新增“起步”段与其引用的现有 P3M 指引。
- **已读取／执行的证据**：完整读取上述文本、`plan-3-remap-sites.md`、`plan-2-allocation-critical-section.md`、owner／driver 生产实现、两个架构守卫；核对 Git 拓扑与 transcript 时间线；执行 `bun test tests/architecture/anchor-remap-single-authority.unit.test.ts tests/architecture/package-boundaries.unit.test.ts`，结果 **33 pass / 0 fail**；执行 `git diff --check`，结果通过。
- **总体 verdict**：两份产物均为**修复 Major 后可提交**。
- **Blocker 数量**：0。
- **发现计数**：Major 5，Minor 3。

## 产物 A：session-closeout §6b + CLAUDE.md

### 已修复项复验

1. **触发链**：静态文本层面已修复。`/home/xp/src/copilot-api-js/.claude/skills/session-closeout/SKILL.md:3` 增加“准备派 implementer”“按 plan 执行”“起 worktree 做相位”三个派活前触发形状，`/home/xp/src/copilot-api-js/CLAUDE.md:54` 又提供 always-on 第二入口，且两处都明确“等收尾才读到已经晚了”。这不再是只能在收尾发现的死规则。由于 Claude Code 的 skill registry 在 CLI 进程启动时冻结，本会话不能 smoke-test 修改后的 description 是否自动触发；正文的 V11 正确把实际触发率留作新进程实战核验，不能把“文件里写了”冒充“运行时已证实”。
2. **双事实源收口**：已修复。`SKILL.md:92-95` 明确跨会话时折入 HANDOVER 后立即标 superseded 并停更，相位完成时才折入正式 plan，权威转移方向清楚。
3. **共树限定**：已修复。`SKILL.md:97-98` 与 `/home/xp/src/copilot-api-js/docs/memory/methodology-concurrent-agents-must-not-share-worktree-for-mutation.md:11,18-20` 对齐：禁止的是 mutation writer 与权威测试共树／同树多写者，不再错误禁止严格只读并行审查。
4. **容量阈值与 seam-free 分支**：已修复。`SKILL.md:101-103` 将 5 MiB 限定为 CC `2.1.207` 的已观测机制，保留环境变量绕过条件，并明确 checkpoint→新实例是“可恢复交接，不是原上下文续命”。
5. **自评式接缝裁决**：已按 record-now-adjudicate-later 降级。`SKILL.md:105` 要求当场记录分类和理由、相位收口交独立评审核对，没有让调度方把自己的判断当最终裁决。
6. **实战自验**：V11–V14 已覆盖派活前触发、commit 对账、接手可恢复性、权威转移，符合 `/home/xp/src/copilot-api-js/CLAUDE.md:39` 对指令断言内置自验的要求。

### 事实性发现

[Major] `/home/xp/src/copilot-api-js/.claude/skills/session-closeout/SKILL.md:99` — “探测消息导致 `[Request interrupted by user]`”的本仓观测因果关系被时间线直接证伪 — 被打断 agent 的原始 transcript `/home/xp/.claude/projects/-home-xp-src-copilot-api-js/815e2277-ca6c-4d88-925c-52a9a7704e9f/subagents/agent-a0a43068a75b90ffe.jsonl:1778` 在 **2026-08-02T17:35:28.009Z** 已写入 `[Request interrupted by user]`；主会话真正发送 `ping — 确认你还在` 的记录位于 `/home/xp/.claude/projects/-home-xp-src-copilot-api-js/0205d11f-6e73-4330-8784-9d7af59d8499.jsonl:287`，时间是 **2026-08-02T17:37:25.770Z**，晚了约 118 秒，而且下一条工具结果明确是 `No transcript found`，消息没有恢复成功。所谓“同一秒”只存在于事后自述，不存在于原始事件。故这里并不存在可由该事故支持的“memory 与实测冲突” — 删除该错误因果和“未决冲突”措辞；可以保留“不为判活发送空探测”作为低收益的调度纪律，但其理由应是避免无意义 steering／恢复操作及依赖 mtime＋明确失败信号，而不是这次被证伪的事故。现有 memory 关于误判 stall 时 resume 排队不打断的通用断言，本轮没有足够独立探针证明为永真，但至少没有被 2026-08-02 事故反驳，不应据此改写 memory。

[Major] `/home/xp/src/copilot-api-js/.claude/skills/session-closeout/SKILL.md:88` — 文件名所需的 `agent-id` 在“派活前”尚不可获得，且正文没有给 implementer 可执行的推导方法 — Agent 调用只有返回后 coordinator 才拿到生成的 agent id；初始派活 prompt 在调用前形成，无法包含 `docs/tmp/...-<agent-id>.md` 的最终路径。当前 subagent 环境实测公开的是 `CLAUDE_CODE_SESSION_ID`，不是 agent id；本 agent 的 `env` 中没有 agent-id 变量。若 coordinator 派完后再用 `SendMessage` 告知路径，又与本节刚规定的“不发运行中探测／steering 消息”形成接缝。文本的“机器可推导”没有命令或接口支撑，读者可能在第一次 commit 前根本不知道该写哪个文件 — 改成 coordinator 在派活前生成一个碰撞安全的 **task/run id** 并把完整路径直接写进初始 prompt；或者给出经当前运行时验证、agent 自身能在首个 commit 前获得 agent id 的确定命令。不要依赖派出后再补发消息。

[Major] `/home/xp/src/copilot-api-js/.claude/skills/session-closeout/SKILL.md:89,141` — “机械对账”仍包含一个未定义的自评集合，尚不能由外部观察者重跑 — `<base>..HEAD` 中“属于该 implementer 的实现 commit 集合”没有机器判据：本仓所有 agent commit 常共用同一个 Git author，范围中还可能包含 merge／peer commit，而 frontmatter 没有任务 pathspec 或 commit 清单。`git log <base>..HEAD -- <progress-file>` 只能机械得出修改进度文件的集合，不能机械得出左侧实现集合。V12 也只要求“记下两个数字”，没有生成两个集合的命令，数字仍可由同一方自行分类 — 在 frontmatter 增加任务代码 pathspec／明确排除规则，并给出实际命令，以“触碰声明任务 pathspec 且不是 progress-only／merge 的 commit”为实现集合；或要求每次 checkpoint 在进度文件中追加对应实现 commit SHA，并在收口由独立 reviewer 对账。若不补，去掉“机械”与“外部可验证”的声称。

[Minor] `/home/xp/src/copilot-api-js/.claude/skills/session-closeout/SKILL.md:84` — “所有单 commit 任务一律不建”的理由说过头 — 单 commit 的工作区 diff 只记录“改成了什么”，不会自动记录“为什么这样改、原打算改成什么、哪些路已作废”；恰好这三项是 `SKILL.md:91` 规定 Git 记不下的内容。长时间、高不确定性的单 commit 任务同样可能在提交前被打断并丢失意图，因此“在途意图本来就在那一个 diff 里”是事实错误 — 可以保留明确二分，但应把例外轴改成预计容量／中断恢复需求，而不是断言 diff 已保存意图；至少删除这句错误理由。

### 产物 A verdict

**不可直接提交。** 上轮六项 Major 的主体修复均已落地，但本轮独立时间线推翻了 probe 因果事实，且 agent-id 的派活时序和“实现 commit 集合”的机械生成仍未闭合。

## 产物 B：P3M kickoff 新增段

### 可验证断言逐项结论

1. **`88e47cef`**：master 当前确实包含该 commit，且它是两父 merge commit；`git merge-base --is-ancestor 88e47cef master` 返回 0。P1+P2 的实现提交位于其第一父链，master 后续包含该结果。
2. **M2 前置条件专节**：存在于 `/home/xp/src/copilot-api-js/docs/plan/2026-07-27-inter-block-anchor-allocator/plan-3-remap-sites.md:60-68`，且 :68 给出 start／delta／stop owner 化、legacy 零残留、具名 oracle 四个满足面。
3. **OwnerResult 与 reason**：`/home/xp/src/copilot-api-js/src/lib/pipeline/types.ts:295-296` 确认三个 reason 为 `client-gone | session-terminating | wire-torn`；五个入口在 :309-321 均返回 `OwnerResult`。
4. **missing mapping throw**：`/home/xp/src/copilot-api-js/src/lib/pipeline/delivery/session.ts:420-429` 在 mapping 或 provenance 缺失时直接 throw，不存在 `no-mapping` union 成员。
5. **wireTorn 作用域**：kickoff 当前说法准确。它在 `createDownstreamDeliverySession()` 的函数局部闭包 `/home/xp/src/copilot-api-js/src/lib/pipeline/delivery/session.ts:93-101`，Anthropic handler 每次请求创建一次 wire state 和 delivery sink（`/home/xp/src/copilot-api-js/src/routes/messages/handler-v4.ts:1118-1153`），因此是“每请求一个 delivery session 局部状态”；它同时跨该请求的 primary／recovery／continuation rounds 生存，所以实施报告称“generation-local”是在架构生命周期层面的同一事实，不是互斥结论。当前 kickoff 的代码级说法更精确。
6. **四类生产入口与 noteWinner**：代码有 ordinary primary、hedge winner、recovery、continuation 四条逻辑入口；实际 `LegKind` 仍只有三种，hedge winner 调 `beginLeg("primary", source)`（`driver.ts:871-880`）。`noteWinner` 只赋 `winnerCandidateId/winnerSource`（`session.ts:488-491`），不调用任何 write，字节仍由 `writeWinnerFrames` 经原 sink 输出。
7. **AST allowlist／M4 判据**：`/home/xp/src/copilot-api-js/tests/architecture/anchor-remap-single-authority.unit.test.ts:36-49,109-128` 已用 TypeScript AST 枚举真实 CallExpression，包含 `legacy:*` 条目；`plan-3-remap-sites.md:54` 明确 M4 清零所有 `legacy:*`。相关测试本轮实跑通过。
8. **stream-error 唯一铸造守卫**：存在于 `/home/xp/src/copilot-api-js/tests/architecture/package-boundaries.unit.test.ts:580-625`，并有 helper-positive-control；生产唯一 helper 在 `/home/xp/src/copilot-api-js/src/lib/pipeline/driver.ts:959-975`。相关测试本轮实跑通过。

### 事实性发现

[Major] `/home/xp/src/copilot-api-js/docs/plan/2026-07-27-inter-block-anchor-allocator/kickoff.md:153,167` 与 `/home/xp/src/copilot-api-js/docs/plan/2026-07-27-inter-block-anchor-allocator/plan-3-remap-sites.md:167-194,252-269` — 新段宣称“以下原有 P3M 指引仍然有效”，但权威 plan-3 的 Task 3.3 仍保留一段已被同文件前文推翻的旧实施指令 — plan-3 :167-194 明确 callback **不能返回 DeliveryFrame**，必须返回 `WireWriteSpec`，kickoff :167 也重复了正确契约；但 plan-3 :263 仍命令实施者“callback 返回带 provenance 的 DeliveryFrame”，还使用已过时的 `({ remap })` callback 形状。一个按 kickoff 顺序读到 Task 3.3 的 implementer 会遇到两个相反的可执行接口，而 kickoff :127 又声明 plan-3 是权威 — 在提交 kickoff 前同步修正 plan-3 Task 3.3 的旧步骤，使其使用当前 `({mapping,envelope}) => WireWriteSpec[]` 形状；否则不能写“仍然有效”。

[Major] `/home/xp/src/copilot-api-js/docs/plan/2026-07-27-inter-block-anchor-allocator/kickoff.md:127-144` — 新增段把 kickoff 变成了权威 plan 的增量覆盖层，违反自身“plan-3 是权威”并扩大事实漂移面 — :127 指定 plan-3 为执行权威，:138 又说这些契约“不在原 plan 文本里，别按旧描述做”，随后复制 OwnerResult、wireTorn、hedge、allowlist、stream-error 等代码事实；这些事实实际已分别存在于 plan-2、plan-3、README、handover 和代码中，且上一个发现已经证明 plan-3 内部确有一处未同步。执行者无法判断冲突时应信“权威 plan”还是 kickoff 增量覆盖 — **就地更新现有 P3M kickoff 确实优于另建 `KICKOFF-P3M.md`**，后者会制造第二个可复制入口；但正确落点顺序应是先把持久契约同步到 plan-3／README 的权威位置，再让 kickoff 只保留开工 gate、当前 landed baseline、必须先读的小节指针及少量不可跳过的红线。不要让 kickoff 成为修补 stale plan 的第二事实源。

[Minor] `/home/xp/src/copilot-api-js/docs/plan/2026-07-27-inter-block-anchor-allocator/kickoff.md:131` — `88e47cef` 的“merge commit”措辞容易误读合并方向 — Git 事实是 `88e47cef` 的 first parent 为 feature 侧 `727c1d1b`，second parent 为当时 master `6118c88e`，commit subject 也是 `merge: bring master into the anchor allocator branch`；随后 master 才包含／快进到该结果。它可以作为 P1+P2 的 landed baseline，但不是“把 P1+P2 merge into master”这一方向的 merge commit — 改成“P1+P2 已落在 master，落地基线 `88e47cef`（该 commit 本身是把当时 master 合入 feature 的合并态 commit）”，避免接手者按错误方向解释历史。

[Minor] `/home/xp/src/copilot-api-js/docs/plan/2026-07-27-inter-block-anchor-allocator/kickoff.md:142` — “生产腿有四类不是三类”会把四条入口路径误读成四种 `LegKind` — 类型系统只有 `primary | continuation | recovery` 三种（`types.ts:316`），hedge winner 复用 `primary`，只是第四条生产调用路径（`driver.ts:871-880`）。下方旧指引 :116 的“三类 upstream round”因此并非错误；两段在不同分类轴上 — 改成“四条生产入口路径映射到三种 LegKind；hedge winner 是独立入口，但以 `primary` kind 调 beginLeg”，即可消除表面矛盾并防止实施者擅加 `hedge` union 成员。

### 产物 B verdict

**不可直接提交。** 新增段的大部分代码事实均已核实，wireTorn 的“delivery session 局部闭包、每请求一份”比笼统的 generation-local 更精确；但权威 plan-3 仍含与当前接口相反的 Task 3.3 指令，而且 kickoff 目前承担了增量覆盖权威 plan 的角色，必须先完成 doc-to-doc 对账。


---

# 第三轮复审

## 评审范围与结论

- **范围**：复核第二轮全部 Major／Minor 的整改，并重点核验 `/home/xp/src/copilot-api-js/docs/memory/MEMORY.md:90`、P3M kickoff 收回为指针后的 gate 完整性，以及 `plan-3-remap-sites.md` 中 owner callback 契约的一致性。
- **已执行证据**：读取第三轮完整 diff、README C1–C11、kickoff P3M 全段、plan-3 S3 专节与 Task 3.3；全目录检索旧 `DeliveryFrame` callback 形状与 `resolveRemappedFrame` 用法；复核原始 JSONL 时间线；执行 `git diff --check`，通过。
- **总体 verdict**：产物 A **修复 Major 后可提交**；产物 B **修复 Major 后可提交**。Blocker 0，Major 3，Minor 1。

## 产物 A 复审

### 已闭合

1. **错误 ping 因果已撤销**：`SKILL.md:99` 与 `MEMORY.md:90` 均明确中断早于探测 118 秒、探测未送达，且保留“原 memory 的 resume 排队说法未被本事故反驳”。这已彻底消除“空探测会打断 agent”的错误传播。
2. **agent id 时序已闭合**：`SKILL.md:88` 改用派活前由 coordinator 生成并写入初始 prompt 的 `<slug>`；agent id 只在 spawn 后回填 frontmatter，不再依赖运行中补发消息。
3. **单 commit 边界已按可恢复性改写**：`SKILL.md:84` 正确承认 diff 只保存结果，不保存弃选理由；长时间／高不确定性单 commit 也触发。
4. **进度文件权威转移、容量 checkpoint、接缝 record-now-adjudicate-later、V11–V14** 均保持第二轮已核验的闭合状态。

### 事实性发现

[Major] `/home/xp/src/copilot-api-js/.claude/skills/session-closeout/SKILL.md:89,141` — 新“机械对账”把“每个实现 commit 都修改进度文件”的 subset 关系错误写成两个集合做对称差／差集 — 设实现集合 `I = <base>..HEAD` 中除 progress-only 以外的 commit，进度集合 `P = 修改 progress 文件的 commit`。一个合规的实现 commit 同时改代码和进度文件，因此属于 `I ∩ P`；但首个创建进度文件的 progress-only commit、相位收口时只改进度状态的 commit 可以合法属于 `P \ I`。若按未定向“两个集合做差集”或对称差判断，合法的 progress-only commit 会被报错；真正要查的只有 `I \ P` 是否为空。更关键的是 V12 仍沿用旧措辞“该 implementer 的实现 commit 集合”，没有同步新的纯路径定义 — 明确写成“机械 gate = `I \ P = ∅`；`P \ I` 只记录、不判红”，并把 V12 的集合定义与正文逐字同步；最好给出一段可直接运行的脚本，避免读者把“做差集”实现成 symmetric difference。

[Minor] `/home/xp/src/copilot-api-js/CLAUDE.md:54` 与 `/home/xp/src/copilot-api-js/.claude/skills/session-closeout/SKILL.md:3,84` — always-on 触发器仍只点名“≥2 个语义 commit”，未覆盖正文新增的“单 commit 但历时长／不确定性高”触发 — description 的症状词也仍以“多语义 commit”概括，导致最需要恢复文件的长时单 commit 可能在派活时根本不加载 §6b — 将 CLAUDE.md 与 description 的触发摘要同步为“多语义 commit，或单 commit 但长时／高不确定性”。

### MEMORY.md 钩子裁决

`/home/xp/src/copilot-api-js/docs/memory/MEMORY.md:90` 已不再传播错误的 ping 因果；“mtime 是弱信号＋空探测收益低于风险＋历史因果已证伪”与正文一致。**但“真因是宿主一次失败的 fork resume”证据等级仍不足以写成确定因果**：原始事实只有 agent 在 17:35:28 收到 interrupt，17:35:35 主会话收到“checkpointed for the background fork but could not be resumed”失败通知；通知晚于 interrupt 7.9 秒且未携带 source tag，最多支持强相关机制假设，尚不能独立证明哪一个宿主动作产生了 interrupt。`SKILL.md:99` 也同样断言了“真因”。这正与其紧随其后的“在边界猜成因”纪律相冲突。建议改为“同期观测到失败的 fork resume，具体 interrupt provenance 尚未由 source tag 证实”；已证实的只有“ping 不是原因”。若主会话另有宿主日志／源码能把 interrupt 明确归因于该 fork resume，应把证据位置写入正文后再称“真因”。此项与上面同属 **Major：错误因果已修一半，但新因果仍越过证据**。

### 产物 A verdict

**不可直接提交。** ping 误因果和 agent-id 问题已经闭合；剩余 Major 是对账集合方向未定义，以及把仅有时间相关性的 fork resume 写成确定“真因”。

## 产物 B 复审

### 已闭合

1. **kickoff 已收回为 gate＋指针**：`kickoff.md:129-145` 不再复制 OwnerResult、wireTorn、missing mapping、四腿细节；权威回到 README C9–C11 与 plan-3 M2 专节。
2. **没有过度删掉 P3M 执行 gate**：仍保留从当前 master 建隔离 worktree、三份必读材料、M2→M6 硬门、每腿真实 HTTP oracle、mutation scratch worktree、M4 allowlist 清零、M1–M8／M6 晚于 M2–M4／6 格 mutation／golden 顺序／门不可满足时停下等关键动作。
3. **合并方向与腿分类误导已消除**：kickoff 明写 master 合入 feature 后 fast-forward；四条入口／三种 LegKind 只在 README C11 权威处陈述。
4. **Task 3.3 的旧 DeliveryFrame callback 已修正**：`plan-3-remap-sites.md:263` 现与 :163、:171-194 一致，均使用 `({mapping,envelope}) => WireWriteSpec[]`，owner 铸造信封并按 `spec.kind` 路由。全执行计划目录检索到的旧形状只剩历史 review 报告，属于证据档案，不是活指令。

### 事实性发现

[Major] `/home/xp/src/copilot-api-js/docs/plan/2026-07-27-inter-block-anchor-allocator/plan-3-remap-sites.md:164,238,248,264-266` — 权威 plan-3 仍有第三组与已落地 owner API 不一致的活指令 — :164 仍把 `withAllocatedRealBlock` 返回类型写成 `Promise<WireBlockMapping | undefined>`，而生产类型及 plan-2 权威接口是 `Promise<OwnerResult<WireBlockMapping>>`（`src/lib/pipeline/types.ts:312-315`、`plan-2-allocation-critical-section.md:88-91`）。同时 :238／:248／:264-266 仍指示非-start 帧走不存在的 `resolveRemappedFrame`／“装饰器普通 write 路径”并核 `ReconcileHooks.remap`；README C10 与同文件三腿矩阵 :146-148 已明确非-start 帧必须走 owner `writeBlockFrame(leg, upstreamIndex, frame)`，调用方不碰 mapping。实施者照 Task 步骤会重新绕过 owner registry 或调用不存在于生产的接线 — 把 API 返回改为 `OwnerResult`，并把 S1／S2／S3 的非-start 步骤统一改成显式 leg 的 `writeBlockFrame`；删除活指令中把 `resolveRemappedFrame` 当站点 API、扩 `ReconcileHooks.remap` 的旧说法。mutation 维度也应针对 owner 内 `mapping.remap`／绕过 `writeBlockFrame` 的真实失败形状，而不是要求三站点出现 `resolveRemappedFrame`。

### 产物 B verdict

**不可直接提交。** kickoff 的定位与主要 gate 已正确；但它指向的权威 plan-3 仍含会把实施者带回旧 API 的第三组 stale 指令，必须先完成该 doc-to-code 对账。


---

# 第四轮复审

## 范围、证据与 verdict

- **范围**：复核第三轮 3 Major＋1 Minor 的整改；重点检查因果措辞、`I \ P` 可执行性、plan-3 补正是否足以覆盖旧 Step，以及全文与 `/home/xp/src/copilot-api-js/src/lib/pipeline/types.ts:295-321` 的接口一致性。
- **证据**：读取 §6b、`CLAUDE.md:54`、已提交 `fde6644c` 中的 MEMORY 钩子、kickoff P3M、plan-3 全部 owner API 相关段落与现行 types／session 实现；执行实际 Git 集合分类探针；执行 `git diff --check`，通过。
- **总体 verdict**：产物 A **修复 Major 后可提交**；产物 B **修复 Major 后可提交**。Blocker 0，Major 3，Minor 1。

## 产物 A

### 已闭合

1. **因果边界**：`SKILL.md:99` 与已提交的 `MEMORY.md:90` 现在均只断言已独立证实的“ping 不是原因”；fork resume 被明确标成“时间相关、无 source tag、待验证、不得当结论”。没有残留暗示性真因。正文的“双重反面教材”清楚区分了同期事件与因果证据。
2. **触发范围**：skill description 与 `CLAUDE.md:54` 已同步覆盖多语义 commit，以及单 commit 但历时长／需试错。
3. **集合方向**：正文和 V12 都明确只判 `I \ P`，并说明 `P \ I` 中合法 progress-only commit 不判红；不存在上一轮的对称差歧义。

### `I \ P` 实际命令形态

下面的命令按分支 first-parent 历史逐 commit 取相对第一父提交的路径；`I` 是“非 progress-only commit”，`P` 是修改 progress 文件的 commit，最终只打印 `I \ P`：

```bash
BASE=<frontmatter.base>
PROGRESS=<progress 路径>
while IFS= read -r commit; do
  mapfile -t paths < <(git diff-tree --no-commit-id --name-only -r --first-parent "$commit" | sort -u)
  only_progress=true
  touched_progress=false
  ((${#paths[@]} > 0)) || only_progress=false
  for path in "${paths[@]}"; do
    [[ "$path" == "$PROGRESS" ]] && touched_progress=true || only_progress=false
  done
  if ! $only_progress && ! $touched_progress; then
    git show -s --format='%H %s' "$commit" # I \ P
  fi
done < <(git rev-list --reverse --first-parent "$BASE..HEAD")
```

我以 `BASE=88e47cef`、本报告路径作探针运行，当前后续 5 个 first-parent commit 全被列入 `I \ P`，符合该报告不可能随那些历史 commit 更新的事实。合法 `P \ I` 至少包括：首次单独创建 progress、补 agent/session id、只修 progress 文字、收口标 superseded、归档前只改状态；现规则已明确这些不判红。

### 事实性发现

[Major] `/home/xp/src/copilot-api-js/.claude/skills/session-closeout/SKILL.md:89,141` — 规则仍未给出可执行命令，也未规定沿 first-parent 取 commit 与按第一父提交取 merge diff；直接实现“`<base>..HEAD` 全部 commit”会把合入的 peer 侧祖先也纳入 I，或者因 `diff-tree` 对 merge 的默认语义不同而漏算／重复算，机械判据仍不唯一 — 将上面的命令或等价脚本写入 skill，明确 `git rev-list --first-parent` 与 `git diff-tree --first-parent`。若任务分支允许 coordinator／peer 直接追加无关 first-parent commit，则还必须在 frontmatter 声明任务 branch 独占；否则这些无关 commit 也会合法地落入 `I \ P`。

[Minor] `/home/xp/src/copilot-api-js/.claude/skills/session-closeout/SKILL.md:89` — “最后一次性 amend／补写仍可能在集合上显示合规”把两个不同动作并列得过宽 — 单纯最后补一个 progress-only commit 不会消除此前实现 commit 的 `I \ P`；只有逐个改写历史 commit、或所有实现本来就尚未分别 commit，才可能伪装合规。改成“逐个 amend／rebase 改写历史仍可伪装；最后单独补写不能”即可保持诚实边界。

### 产物 A verdict

**不可直接提交。** 因果、触发范围和集合方向已闭合；还需把声称“机械”的集合判据落实为唯一可执行的 first-parent 命令，并收窄一次性补写边界。

## 产物 B

### 已闭合

1. `withAllocatedRealBlock` 的摘要返回类型已改成 `Promise<OwnerResult<WireBlockMapping>>`，三个 failure reason 与接线错误 throw 边界和生产类型一致。
2. kickoff 仍保留完整 gate 与权威指针；本轮没有发生范围收缩。

### 事实性发现

[Major] `/home/xp/src/copilot-api-js/docs/plan/2026-07-27-inter-block-anchor-allocator/plan-3-remap-sites.md:167,240,250,266-268,277` — 用一条“下方旧措辞按本补正理解”兜住相反的 checkbox 指令不够，且会让执行者与 checker 看到不同 contract — :240／:250 仍明确命令非-start 帧走 `resolveRemappedFrame`；:266-268 仍命令 S3 普通 write、扩 `ReconcileHooks.remap`；:277 的 mutation 仍假定三个调用站点都存在 `resolveRemappedFrame`。这些都与同文件 :146-148、README C10 及生产 `writeBlockFrame(leg, upstreamIndex, frame)` 相反。模型执行 checklist 时通常就地遵循最近的 Step，而不会自动用 70～110 行前的一条补正重写它；保留已知错误文本也违反本 plan 自己的单一权威 — 必须逐处改 checkbox 与 mutation 文本：S1／S2／S3 非-start 帧统一经 `writeBlockFrame`；S3 不再扩 `ReconcileHooks.remap`；remap mutation 应打在 owner 的 `mapping.remap` 或让站点绕过 owner，真实对应当前架构。

[Major] `/home/xp/src/copilot-api-js/docs/plan/2026-07-27-inter-block-anchor-allocator/plan-3-remap-sites.md:108` — 第四处旧 owner contract：状态转移表仍写 `closeOpenAnchor` 返回 `"write-error"` — 现行接口只会成功返回 `OwnerResult<"closed" | "none">`；client abort 返回 `{ok:false, reason:"client-gone", committed:true}`，非-client write error 抛 `DeliveryOwnerError` 并置 `wireTorn`，没有 `"write-error"` success value（`src/lib/pipeline/types.ts:317-320`、`delivery/session.ts:394-418`）。该表自称“任何偏离即 bug”，因此会直接驱动错误 oracle — 按现行三类结果重写该行，至少区分 client-gone failure result 与非-client throw／wireTorn；同时核对 legacy 四字段在这两条失败路径上的期望值，而不是只替换标签。

### 全文扫描结论

除上述两组活冲突外，接口摘要的 `WireWriteSpec`／`WireEnvelopeFactory`、`beginLeg`、`closeOpenAnchor` 调用形状、三腿矩阵的 `writeBlockFrame` 方向均与生产类型一致。历史 `plan-review-gpt.md` 中旧 DeliveryFrame 提议属于评审证据档案，不是活执行指令，无需回写。

### 产物 B verdict

**不可直接提交。** “补正覆盖旧 Step”不能替代逐处修改，且状态转移表仍存在第四处确定错误的 `write-error` contract。


---

# 第五轮复审

## 范围、证据与 verdict

- **范围**：实跑 §6b 新脚本并构造空格路径、前缀碰撞、空 commit 对照；复核 merge／squash／cherry-pick 边界；按现行 `WireBlockAllocationPort` 与 delivery session 实现再次全文审计 plan-3。
- **证据**：新脚本在本仓 `HEAD~6..HEAD`＋`docs/memory/MEMORY.md` 上输出预期 4 个 SHA，并正确排除 progress-only 的 `fde6644c`；在临时 Git 仓库中构造路径空格、路径包含关系和 empty commit；`git diff --check` 通过。
- **总体 verdict**：产物 A **修复 Major 后可提交**；产物 B **修复 Major 后可提交**。Blocker 0，Major 4，Minor 1。

## 产物 A

### 脚本实跑结论

1. **本仓正样本成立**：设置 `BASE=HEAD~6`、`PROGRESS=docs/memory/MEMORY.md` 后，脚本输出 `bf0269ee`、`156b5529`、`665e654b`、`0636be73` 四个缺进度 commit，且 `fde6644c` 只改 progress，正确不报。
2. **文件名含空格本身可工作**：`files` 保留逐行路径，引用了 `$PROGRESS`，同一 commit 同改 `code` 与 `progress file.md` 时正确得到 I＋P。
3. **merge 边界描述基本准确但论域应扩大**：first-parent 遍历把普通 merge 只看成一个 aggregate commit；被合入侧只要净变更含 progress 路径，merge 就同时获 I＋P，内部每个语义 commit 是否随写完全不可见。普通 fast-forward／rebase／逐个 cherry-pick 保留每个线性 commit，仍有鉴别力；**squash merge、`cherry-pick -n` 后一次提交、手工 squash**同样把多次工作压成一个 aggregate ordinary commit，一次 progress 更新即可通过。它们不是“merge commit 免费 P”，却是同一类“历史粒度坍缩”空子。

### 事实性发现

[Major] `/home/xp/src/copilot-api-js/.claude/skills/session-closeout/SKILL.md:91-101` — 声称“可照抄的完整脚本”仍有三个可复现的 shell 假绿／假红 — ① 脚本没有从 frontmatter 赋值 `BASE`；我原样 `unset BASE` 运行时 `"$BASE"..HEAD` 退化为 `..HEAD`，循环 0 次、静默绿。② `grep -qF "$PROGRESS"` 是子串匹配，不是路径行精确匹配；临时仓库只改 `progress file.md.extra` 时脚本得到 P 且得不到 I，该实现 commit 被完全漏掉。③ empty commit 的 `files` 为空，但 `echo "$files"` 仍产生空行，`grep -qvF` 成功，将 empty commit 错判为 I 并报缺进度。修复建议：脚本显式从占位填 `BASE=<sha>`；用 `grep -Fxq -- "$PROGRESS"` 判 P；先以 `[[ -n "$files" ]]` 排除 empty commit，再用精确行集合判“是否存在非 progress 路径”。对路径中换行若不打算支持，应诚实标明；若要完全闭合，改用 `-z`＋NUL 解析。

[Major] `/home/xp/src/copilot-api-js/.claude/skills/session-closeout/SKILL.md:101,153` — “剩余可钻的空子只有改写历史”与同段随后列出的 merge 空子自相矛盾，且漏掉 squash 聚合 — 普通 merge aggregate、squash merge、`cherry-pick -n`／手工 squash 都会让“每语义 commit”退化成“每落地 commit”，其中普通 merge 未必改写已有第二父历史，不能全归入 amend／rebase。应把边界统一表述为：判据只覆盖 **first-parent 上可见的普通非 merge commit 粒度**；任何历史改写或聚合落地都会降低／消除鉴别力。V12 也应记录是否存在 merge／squash 聚合，而不只运行脚本。

### 产物 A verdict

**不可直接提交。** 核心集合方向成立，但当前脚本仍可在 BASE 未赋值、前缀路径和 empty commit 三种普通条件下静默给错答案。

## 产物 B

### 已闭合

1. `closeOpenAnchor` 的 client-gone result 与非-client `DeliveryOwnerError`／`wireTorn` 分支已写入转移表。
2. `withAllocatedRealBlock` 返回类型、M2／M3 非-start `writeBlockFrame`、S3 owner remap 方向和 mutation 对照均已开始按现行接口改写。

### 事实性发现

[Major] `/home/xp/src/copilot-api-js/docs/plan/2026-07-27-inter-block-anchor-allocator/plan-3-remap-sites.md:266-268` — 第五轮改动仍留下同一 Step 内相邻的直接矛盾 — :266 说 remap 不再由 `reconcileLiveFrame` 做，:267 紧接着仍说非-start 帧“走装饰器普通 write，remap 按 mapping 查”，:268 又否定 :267、要求走 owner `writeBlockFrame`。这不是可由补正解释的历史说明，而是两个同时生效的 checkbox 子步骤；实施者可能照 :267 保留绕 owner 的旧路径 — 删除 :267，而不是在下一行覆盖它。

[Major] `/home/xp/src/copilot-api-js/docs/plan/2026-07-27-inter-block-anchor-allocator/plan-3-remap-sites.md:106-108,128-136` — 仍有第五处旧 `OwnerResult` 契约：成功结果和迁移站点被写成裸字符串／裸 await，只有失败行改成了 union — 现行 `closeOpenAnchor` 返回 `Promise<OwnerResult<"closed" | "none">>`；表中 :106-107 仍写“返回 `"closed"`／`"none"`”，:136 也说第二调用者“得 `"none"`”，站点表 :128-132 只要求调用 API，没有要求 narrow `{ok:false}`。TypeScript 会阻止把整个 result 当字符串比较，却不会阻止调用方直接忽略 result；后者会把 `client-gone`／`session-terminating`／`wire-torn` 安静丢掉，违背 P2 统一失败契约。修复建议：表改为“返回 `{ok:true,value:"closed"}`／`{ok:true,value:"none"}`”；M1 逐站点步骤明确每次 owner call 都必须 narrow，`ok:false` 按 P2 的 reason 映射／停止，非-client throw 继续传播，不得 fire-and-forget。

[Minor] `/home/xp/src/copilot-api-js/docs/plan/2026-07-27-inter-block-anchor-allocator/plan-3-remap-sites.md:167,214` — 两处已经失效的过渡说明仍留在活计划 — :167 仍说“下方 Step 3 的旧措辞按本补正理解”，但 Step 已逐处改写；:214 仍预留“若 `ReconcileHooks` 需要携 allocator 访问则改 pipeline/types”，与当前 owner port／`writeBlockFrame` 方向相反。它们不会单独造成编译通过的错误实现，但会鼓励再次引入双路径；应删除或改成明确“不向 ReconcileHooks 暴露 allocator／mapping”。

### 六处补正的自洽性

M2／M3 Step 3 与三腿矩阵现已一致；S3 的 start callback 使用 `mapping.remap`，非-start 使用 `writeBlockFrame`；维度 A 改成绕过 owner 的硬编码 +1，方向可用于 mutation。但 :277 统一写“装饰器自算”不适用于 S1／S2（它们是 driver 站点），建议改成中性“调用方自算／直接 sink.write”，以免执行者只对 S3 做该 mutation。该措辞问题并入上面的 Minor，不另计。

### 产物 B verdict

**不可直接提交。** 相邻矛盾行和 `closeOpenAnchor` 成功／失败处理仍会直接误导 M1 实施；修复后再复审。


---

# 第六轮复审

## 范围、证据与 verdict

- **范围**：复跑修订后的进度对账脚本，含正常六类、空格路径、前缀碰撞、empty commit、BASE 未设／无效／非祖先；核对四类历史粒度空子；逐 hunk 检查 plan-3 本轮七处整改并再次对照生产 `OwnerResult`／delivery session。
- **证据**：本仓脚本仍正确输出 4 个缺进度 SHA；临时仓库正向形状复现；`git diff --check` 通过；全文检索不再存在活的 `resolveRemappedFrame`／裸 `"write-error"`／`WireBlockMapping | undefined` 执行指令。
- **总体 verdict**：产物 A **修复 Major 后可提交**；产物 B **修复 Major 后可提交**。Blocker 0，Major 3，Minor 2。

## 产物 A

### 已闭合

1. BASE 未设／语法无效现在均大声报错并 `exit 2`；精确路径匹配、empty commit 跳过及空格路径均在普通文件名范围内成立。
2. 四类空子方向成立：amend／rebase 属历史改写；普通 merge、squash／手工 squash、`cherry-pick -n` 属不同形式的历史粒度聚合。普通逐 commit cherry-pick、fast-forward、非 squash rebase 仍保留可审计粒度。

### 事实性发现

[Major] `/home/xp/src/copilot-api-js/.claude/skills/session-closeout/SKILL.md:96-102` — 新脚本即使正确输出违规 SHA，命令自身仍可能以 exit 1 结束；我在本仓原样运行得到 4 行正确输出，但最终 `script_exit=1` — 原因是 `git log | while` 的退出状态继承最后一轮 body 最后一个 `[ ... ] && [ ... ] && echo` 条件；若最后 commit 合规／progress-only，该条件为 false，while／pipeline 就返回 1。于是同一个检查“输出正确但命令报失败”，嵌入 `set -e` 流程还会中断后续收口，和正文“输出为空即合规”的 oracle 形成第二信号冲突 — 在 while body 末尾加 `:` 保证每轮成功，或重写为显式 `if ...; then echo ...; fi` 并在 pipeline 后固定成功；另外应让“发现违规”是否返回非零成为明确契约，而不是由最后一个 commit 偶然决定。

[Major] `/home/xp/src/copilot-api-js/.claude/skills/session-closeout/SKILL.md:94-96` — BASE 守卫只证明“这个对象是 commit”，未证明它是 HEAD 的祖先 — 有效但无关的 commit／错误分支 SHA 会通过 `rev-parse`，随后 `BASE..HEAD` 审计错误集合；我用 orphan 分支 commit 作 BASE 时守卫通过，未发出“基线不属于当前任务历史”的诊断。它通常造成大量假红，但在短历史／聚合历史下也可能给出误导性空结果 — 增加 `git merge-base --is-ancestor "$BASE" HEAD || { echo "BASE 不是 HEAD 祖先——对账未执行"; exit 2; }`。

[Minor] `/home/xp/src/copilot-api-js/.claude/skills/session-closeout/SKILL.md:107` — merge 空子的表述把“被合入分支碰过进度文件”写成充分条件，实际 first-parent merge diff 只看**净变更** — 分支若修改后又还原 progress，merge 不获 P；merge conflict resolution 反过来也可能给它 P。改成“合入结果相对第一父的净 diff 含进度文件”才精确。四类不宜声称数学穷尽；更稳的上位概括是“历史改写或多个工作单元聚合成一个 first-parent commit”，四类作为已知实例。

[Minor] `/home/xp/src/copilot-api-js/.claude/skills/session-closeout/SKILL.md:92-100` — 路径含换行仍会破坏按行解析，且 `<slug>` 尚未正式限制字符集 — 本项目生成路径完全可通过将 slug 规定为 kebab-ASCII 排除该输入，不必引入 NUL 脚本；请明确 `<slug>` 只允许 `[a-z0-9]+(?:-[a-z0-9]+)*`。root commit 不构成问题：有效 BASE 必须是 HEAD 祖先，`BASE..HEAD` 不会包含 BASE 自己的 root commit。

### 产物 A verdict

**不可直接提交。** 六类内容分类已闭合，但脚本退出码仍取决于最后一个 commit，且 BASE 缺祖先关系守卫。

## 产物 B

### 已闭合

1. 上轮相邻矛盾行已真正删除；S1／S2／S3 非-start 均指向 `writeBlockFrame`，S3 不再向 `ReconcileHooks` 暴露 allocator／mapping。
2. `closeOpenAnchor` 的成功结果已改成 `{ok:true,value:"closed"|"none"}`，站点被提醒必须 narrow；mutation 文案已改成调用方自算并区分 driver／decorator。
3. 本轮 diff 各 hunk均落在预期位置，未看到“改错行”造成的相邻文本损伤。

### 事实性发现

[Major] `/home/xp/src/copilot-api-js/docs/plan/2026-07-27-inter-block-anchor-allocator/plan-3-remap-sites.md:106-109,118` — “精确状态转移表”仍与当前 owner 失败契约不完整且有一处确定状态错误 — :108 的 client-gone failure 省略承重的 `committed:true`；更严重的是表声称该路径后 `openAnchorIndex = undefined`，但生产 `closeOpenAnchor` 在 client-abort catch 中没有清除此字段（`delivery/session.ts:401-417`），而 `allocateAndWriteAnchor` 的 client-gone post-commit 测试也明确锁住 `openAnchorIndex` 仍为已分配 index（`tests/pipeline/allocation-commit-point.it.test.ts:125-134`）。如果 M1 的目标是主动改变为 undefined，必须在 M1 步骤具名实现并给 red-first oracle；当前只改文档标签会让“逐格 oracle”按一个尚无实现步骤的状态写。表还没有覆盖 ownerUnavailable 的 `{ok:false,reason:"session-terminating"|"wire-torn",committed:false}` 不变路径，却宣称逐行覆盖“每个 owner 操作”。修复建议：先裁决 M1 是否要清 openAnchorIndex；按裁决拆成 client-gone committed result、非-client throw、preflight unavailable 三行，并写清每行 committed 与四字段真实／目标状态。

### 第六处扫描补充

除上述转移表外，`withAllocatedRealBlock`、`writeBlockFrame`、`WireWriteSpec`、`ReconcileHooks` 与 mutation 方向已与现行接口一致。`plan-2-allocation-critical-section.md` 自身仍留有早期 `write-error/client-abort` 叙述，但本轮产物 B 的权威入口已通过 README C9/C10 指向落地后契约；若该 plan-2 仍被视为活执行文档，建议另行做 doc-sync，不把它混入本轮发现计数。

### 产物 B verdict

**不可直接提交。** 第六处旧契约位于自称“精确”的状态转移表：必须先对齐 committed 字段、openAnchorIndex 的真实／目标状态及 preflight failure 分支。


---

# 第七轮复审

## 范围、证据与 verdict

- **范围**：复跑带三道 BASE 守卫和 `if` 循环的新脚本；逐格对照 plan-3 转移表与 `session.ts:394-416`；全文扫描 plan-3 活契约，并逐 hunk 核查本轮按行号改动。
- **证据**：新脚本在本仓 `set -euo pipefail` 下输出同样 4 个缺进度 SHA且最终 exit 0；前缀、空 commit、无关 BASE 守卫已复验；`git diff --check` 通过。
- **总体 verdict**：产物 A **可提交**；产物 B **修复 Major 后可提交**。Blocker 0，Major 2，Minor 1。

## 产物 A

### 结论

1. 新脚本的普通目标输入现已闭合：BASE 缺失／无效／非祖先均 exit 2；合规／违规循环稳定 exit 0；精确整行匹配挡住前缀碰撞；empty commit 跳过；kebab-ASCII slug 排除空格／换行路径。
2. first-parent 限定与四类历史改写／聚合边界表述准确。它们不需要声称数学穷尽，因为正文已经用“所有已知绕过”限定，并给出上位族。
3. 在当前项目约定下未发现新的 shell blocker。唯一环境前提是 Bash（使用 `[`、pipeline），而本项目 skill 本就以 Bash 命令为执行环境。

### 产物 A verdict

**可直接提交。** 未发现新的 Blocker／Major／Minor。

## 产物 B

### 已闭合

1. 新拆的三行与 `session.ts:394-416` 在 owner 自身状态上逐格一致：client-gone 返回 `committed:true` 且不清 `openAnchorIndex`；非-client 写失败置 `wireTorn` 后抛 `DeliveryOwnerError`；preflight session-terminating／wire-torn 返回 `committed:false`，不进入写路径。`finalizeAfterClientGone()` 只改 delivery session 的 `state`／`finishReason`／heartbeat／finalize，不触碰 `anchorBlockOpen`、`anchorClosed`、`injected`，三列写“不变”正确。
2. 本轮三行落点正确，未误伤相邻状态行；`:164` OwnerResult 摘要与 `:136` narrow 要求方向一致。

### 事实性发现

[Major] `/home/xp/src/copilot-api-js/docs/plan/2026-07-27-inter-block-anchor-allocator/plan-3-remap-sites.md:103-111,119-120` — 第七处旧契约在同一“精确状态转移表”的 `allocateAndWriteAnchor`／`withAllocatedRealBlock` 行 — :103-105 仍把 allocate 的结果写成抽象“成功／失败 pre-commit／失败 post-commit”，未写 `OwnerResult` 与 throw 分界；其中生产事实是 build callback throw 属 pre-commit throw，不是 `{ok:false}`，client-gone wire failure 才返回 failure result，非-client wire failure抛 `DeliveryOwnerError`。更严重的是 :105 声称 anchor post-commit 失败后 `openAnchorIndex=undefined`、`anchorBlockOpen=true`、`anchorClosed=true`、`injected=true`，但当前生产 `writeAllocationFrames` 在 commit 回调先置 `openAnchorIndex`，client-gone 后不会清它；测试明确断言 post-commit client-gone 后 `openAnchorIndex===0`（`tests/pipeline/allocation-commit-point.it.test.ts:125-134`）。legacy 三字段目前也不由 owner 更新，M1 若要实现这些目标状态，必须写成具名迁移步骤及 red-first oracle，不能让“当前契约”与“未来 M1 目标”混在无标签表里。:111 把 `withAllocatedRealBlock / beginLeg（任何结果）` 合并为“不变”也漏了 beginLeg 成功会改 activeLeg／mappings，虽四个展示列确实不变，但“每个 owner 操作状态”的表名会误导 oracle 范围 — 将表明确标为“仅四个 legacy／anchor 字段的 M1 目标表”，并按 OwnerResult／throw 拆 allocate 三类，正确写 `openAnchorIndex` 当前或具名目标状态。

[Major] `/home/xp/src/copilot-api-js/docs/plan/2026-07-27-inter-block-anchor-allocator/plan-3-remap-sites.md:128-138` — “迁移站点必须 narrow OwnerResult”仍没有给出失败结果的具体控制流，且 `closeOpenAnchor` 的三种 reason 不止文中点名的 client-gone／wire-torn — preflight 还可能是 `session-terminating`，当前一句“把 failure 当已关过会吞掉”只说明不能做什么，没有规定 handler／driver 站点应 return 哪种 outcome、停止后续写还是继续终局。M1 要一次改 10 个终局站点，这个分叉若不冻结，实施者会各自发明处理，或仅 `if (!result.ok) return` 丢失 richest context。plan-2 已有 `ownerFailureOutcome(reason, env)` 的统一映射；plan-3 应明确 close 调用点复用同一穷尽映射／传播策略，并给至少一个 `{ok:false}` 站点 oracle，不能只要求 narrow。

[Minor] `/home/xp/src/copilot-api-js/docs/plan/2026-07-27-inter-block-anchor-allocator/plan-3-remap-sites.md:169,192-198,267-269` — S3 文本仍有职责边界歧义：:267 的 start callback 直接 `mapping.remap(start)`，而 :268 说“remap 与查表都在 owner 的 `writeBlockFrame` 内”；实际 owner 的 `withAllocatedRealBlock` callback由调用方拿 mapping 并构造 remapped start，只有非-start 才由 `writeBlockFrame` 查表＋remap。上方 :192 也说 owner“内部补 metadata”而非 owner 负责所有 remap — 把 :268 收窄为“**非-start** remap 与查表在 writeBlockFrame 内；start remap 在 owner transaction callback 中使用 reservation mapping”，避免实施者误以为 start 也须改走 `writeBlockFrame`，从而重复分配或拆 transaction。

### 第七处全文扫描补充

除以上 allocate 状态表、close failure 控制流与 S3 句子外，M2／M3 Step、mutation 矩阵、`WireWriteSpec`、`ReconcileHooks`、`writeBlockFrame` 及 `closeOpenAnchor` 三行本轮整改均与现行类型相符。没有发现按行号编辑误伤别处。

### 产物 B verdict

**不可直接提交。** 还需把 allocate failure 的当前／目标状态与 close failure 的统一控制流冻结，另收窄 S3 remap 职责措辞。


---

# 第八轮复审（仅产物 B）

## 范围、证据与 verdict

- **范围**：逐行对照新增 allocate 四行、close failure 处置表与 `session.ts:289-417`，检查 client-gone 后的字节／finalize／请求 settle，全文再扫 plan-3。
- **证据**：读取 owner 实现、现有 allocation／termination 测试、direct／translate pump 的终局分支及 `ownerFailureOutcome` 穷尽映射；检查本轮 diff；`git diff --check` 通过。
- **总体 verdict**：产物 B **修复 Major 后可提交**。Blocker 0，Major 3，Minor 1。

## 已闭合

1. build callback throw 与 post-commit `openAnchorIndex` 已纠正；mirror 三字段的“不变／保留”与 `makeSyntheticAnchorInjector` 的 restore 规则方向一致。
2. S3 remap 责任已经准确拆成 start callback 使用 reservation mapping、非-start 使用 `writeBlockFrame`。

## 事实性发现

[Major] `/home/xp/src/copilot-api-js/docs/plan/2026-07-27-inter-block-anchor-allocator/plan-3-remap-sites.md:115,123` — preflight reason 枚举漏掉确定可达的 `client-gone`，并因此漏掉 close 的第五种语义形状 — `ownerUnavailable()` 在 `state !== "open"` 时返回 `finishReason ?? "session-terminating"`；若 session 已因客户端断开关闭，reason 是 `client-gone`、`committed:false`。现有测试已锁住 close preflight 返回 `{ok:false,reason:"client-gone",committed:false}`（`tests/pipeline/allocation-begin-leg-after-termination.it.test.ts:75-91`）。新增处置表的 client-gone 行却断言“此时 committed:true、stop 可能部分上线”，只覆盖 write-attempt abort，不覆盖 preflight client-gone。allocate preflight 行也只列 session-terminating／wire-torn — 两张表均应把 client-gone 按 committed 拆成 false／true；控制动作都可以停止后续字节，但理由、wire 事实与 oracle 必须不同。

[Major] `/home/xp/src/copilot-api-js/docs/plan/2026-07-27-inter-block-anchor-allocator/plan-3-remap-sites.md:117` — “pre-commit 写失败返回 `{ok:false,...,committed:false}`”不是当前实现中的一般可达形状 — `writeAllocationFrames` 在调用第一笔外部 write **之前**先 `reservation.commit()` 并置 `committed=true`（`session.ts:307-316`），因此任何外部 write reject 都是 post-commit。commit 前可见的失败是：empty specs 直接 throw、`frameForSpec`／接线错误经 `DeliveryOwnerError(false)` throw、或 callback throw；不是该行描述的 failure result。唯一常规 `{ok:false,committed:false}` 是 ownerUnavailable preflight（含 client-gone／session-terminating／wire-torn）。删除这个虚构行，并补 empty-spec／frame-build throw 边界；否则“逐格 oracle”会要求构造一个生产机制不产生的结果。

[Major] `/home/xp/src/copilot-api-js/docs/plan/2026-07-27-inter-block-anchor-allocator/plan-3-remap-sites.md:98-107` — 新 close 处置表把 `session-terminating` 与 `wire-torn` 合并为“预期终态、静默跳过并继续”，直接违反已落地的穷尽映射 — `driver.ts:931-941` 规定：`wire-torn` **始终**映射 `stream-error`；`session-terminating` 只有 `env.ctx.settled` 时是 `delivery-finished`，ctx 尚 pending 时必须响亮 `stream-error`。表中静默继续原 error／close 流程会绕开 abort-provenance 的单一 mint 点，并可能把 pending context 误记成功。应让各站点复用同一 `ownerFailureOutcome` 语义或等价穷尽 helper，而不是另造一张不同映射；尤其不得称 wire-torn 为预期终态。

[Minor] `/home/xp/src/copilot-api-js/docs/plan/2026-07-27-inter-block-anchor-allocator/plan-3-remap-sites.md:103,107` — client-gone 时“不再补终局字节”正确，但验收只断言“不继续写字节”不够 — owner 的 `finalizeAfterClientGone()` 只关闭／finalize delivery，不会调用 `ctx.abort`、记录 forwarded snapshot 或完成请求 settle。现有 pump 的 settled-abort 分支还必须 `recordForwarded`／`ctx.abort`；若迁移站点只 return，可能丢 History settle，若沿原 error 分支又会把 client-gone 记成 failed。每类站点的 failure oracle还应断言：字节零追加、forwarded snapshot 保留、ctx 最终为 aborted 且只 settle 一次。这里“不要补终局帧”本身不应撤回，应补齐非字节后果。

## 第八处全文扫描结论

本轮新增表是主要新风险源。除此之外，S3、M2/M3、mutation、`WireWriteSpec` 与 `writeBlockFrame` 方向没有发现新的旧契约。allocate post-commit 行的 legacy mirror 三列写 true 符合 injector 在 owner 调用前同步置位且 committed failure 不 restore 的现状；preflight／build-throw 三列不变也正确。

## 产物 B verdict

**不可直接提交。** 必须补齐 client-gone committed=false、删除不可达的 pre-commit write-result 行，并把 close failure 处置重新对齐已落地的 `ownerFailureOutcome`；同时扩展 client-gone oracle覆盖 History／settle。


---

# 第九轮复审（仅产物 B）

## 范围、证据与 verdict

- **范围**：复核重写后的五行 close 处置、allocate 表、client-gone 的 ctx／History 后果，并全文扫描 plan-3。
- **证据**：对照 `session.ts:280-417`、`driver.ts:925-942`、现有 owner failure 测试及 direct／translate pump 的 settled-abort／error 分支；检查本轮 diff；`git diff --check` 通过。
- **总体 verdict**：产物 B **修复 Major 后可提交**。Blocker 0，Major 3，Minor 2。

## 已闭合

1. `finishReason` 的值域只有 `client-gone | session-terminating | undefined`；`wire-torn` 来自独立布尔状态，处置表的 reason union 无第四个字符串成员。
2. 外部 write failure 统一 post-commit、commit 前错误走 throw 的边界已经修正。

## 事实性发现

[Major] `/home/xp/src/copilot-api-js/docs/plan/2026-07-27-inter-block-anchor-allocator/plan-3-remap-sites.md:102-108` — 五行表把 `committed` 从判别依据中丢掉，无法安全合并两个 client-gone 来源，也没有形成实际可调用的统一控制流 — `OwnerResult` 的完整判别是 reason＋committed；preflight client-gone 是 `committed:false`，write catch 是 `committed:true`，动作都“不再写字节＋ctx.abort”没问题，但诊断／History 必须保留 committed 以区分“零字节 close 尝试”与“stop 可能部分上线”。表头只写 `closeOpenAnchor 返回`，client-gone 行却省略 committed 字段，实施者最容易写成 `if (reason === "client-gone") return` 并丢掉 partial-delivery 事实。更重要的是“交给 pump 既有 outcome 映射”在这些 close 站点并无可调用接口：`ownerFailureOutcome` 是 `driver.ts` 私有函数，handler 的 8 个站点拿不到它，且 close 返回也不是 `ResponseOutcome`。要求“照抄形状”却没给函数签名／返回协议，仍会迫使 10 个站点各自实现。修复建议：冻结一个共享的 close-result adapter（输入完整 `OwnerResult`＋env/ctx，输出穷尽 control signal／ResponseOutcome），handler 与 driver 共用；至少把 committed 纳入 adapter 输出和 History diagnostic。

[Major] `/home/xp/src/copilot-api-js/docs/plan/2026-07-27-inter-block-anchor-allocator/plan-3-remap-sites.md:103-105` — `session-terminating`／`wire-torn` 的动作仍然会要求已经终止的 delivery “继续写”或重复产出终局 — 表说交给 outcome 映射是对的，但紧接着的站点语义没有规定映射结果如何短路原有分支。`ownerFailureOutcome("session-terminating")` 可能是 `delivery-finished`，此时必须 return、不能继续当前 error-frame 分支；`wire-torn` 生成 stream-error 后也不能让当前 branch 再补自己的 error 帧，否则双终局。应把每个 adapter 结果映射到明确动作：delivery-finished→仅完成必要 snapshot 后 return；settled-abort→snapshot＋ctx.abort＋return；stream-error→由单一既有 error handler 产出一次 terminus／fail，原 branch 不再继续。

[Major] `/home/xp/src/copilot-api-js/docs/plan/2026-07-27-inter-block-anchor-allocator/plan-3-remap-sites.md:115-118` — allocate 精确表仍漏掉 client-gone preflight，并把所有 post-commit 写失败合成一个 legacy 状态 — :115 仍只列 session-terminating／wire-torn，漏 `client-gone, committed:false`。:118 的三列 true 只适用于 `makeSyntheticAnchorInjector` 已同步置 mirror 且 committed failure 不 restore；但 `allocateAndWriteAnchor` 是通用 owner API，测试／未来调用者可直接调用而不经过该 injector，此时 owner 当前实现根本不写这三个 legacy 字段。表标题称“每个 owner 操作”，却把调用方 wrapper 的副作用归给 owner。必须明确表的论域是“经 synthetic injector 的 M1 迁移路径”，并另列裸 owner 调用三字段不变；否则转移表 oracle 会把 wrapper 行为误锁成 owner contract。

[Minor] `/home/xp/src/copilot-api-js/docs/plan/2026-07-27-inter-block-anchor-allocator/plan-3-remap-sites.md:108` — 验收的四件事不能对三类 failure 一刀切 — `wire-torn` 按冻结映射应记录 failed／stream-error，不应断言“请求记为 aborted”；只有 client-gone 两源应 aborted。改成 per-reason oracle：client-gone 两源＝aborted；session-terminating＝pending 时 failed、已 settled 时不二次 settle；wire-torn＝failed；所有分支共同断言 snapshot 与 settle exactly-once。

[Minor] `/home/xp/src/copilot-api-js/docs/plan/2026-07-27-inter-block-anchor-allocator/plan-3-remap-sites.md:108` — forwarded snapshot 可断言，但应走真实 HTTP／ctx History oracle而非 owner unit — 现有 handler 在 settled-abort 前调用 `recordForwarded()`／`ctx.abort()`；测试可用 `createFullTestApp`＋`setDeliverySessionObserverForTests` 触发 close failure，再从 History entry／ctx snapshot 断言 `inboundResponse.sseEvents` 保留已尝试帧、state=aborted、settle 一次。owner 单测只能看到 sink writes/finalize，证明不了 ctx snapshot。该方法与 kickoff 已冻结的真实 HTTP oracle一致。

## 第九处扫描结论

本轮风险仍集中于新增处置表缺少可执行 adapter，而不是旧 S3 契约。其余 `WireWriteSpec`、三腿 remap、mutation 与 close 状态三行没有新增冲突。

## 产物 B verdict

**不可直接提交。** 需把 close failure 表落成共享、穷尽、携 committed 的 adapter 与明确短路动作；同步修 allocate 表论域和 per-reason 验收。


---

# 第十轮复审（仅产物 B）

## 范围、证据与 verdict

- **范围**：评审“共享 adapter”改判、reason×committed 契约、partial-delivery 载体与整份 plan-3。
- **证据**：对照 `ResponseOutcome`、`RequestEnvelope`／`RequestContext`、driver 单一 stream-error mint 守卫、handler pump 返回类型和 context 可用诊断面；检查 diff；`git diff --check` **失败**（adapter 签名行 trailing whitespace）。
- **总体 verdict**：产物 B **存在 Blocker**。Blocker 2，Major 3，Minor 1。

## 改判方向

“先抽共享 adapter，再迁 10 个站点”的方向正确：它消除了 handler 无法调用 driver 私有映射的问题，也使新增 reason 能由类型系统逼出。**但当前冻结的 adapter 签名／调用方式不可实现，尚未真正消除站点分岔。**

## 事实性发现

[Blocker] `/home/xp/src/copilot-api-js/docs/plan/2026-07-27-inter-block-anchor-allocator/plan-3-remap-sites.md:100-118` — adapter 输入只有 `failure + ctx`，却要求产生现行 `stream-error` 语义，缺少不可替代的 `env.clientFormat`，且站点传入的 `ctx` 类型未冻结 — `streamErrorOutcome(error, env)` 不只看 `ctx`，还用 `env.clientFormat` 记录 abort-provenance gap；`RequestContext` 没有等价 clientFormat 字段。若 adapter 只收 ctx，只能绕过唯一 mint helper、丢 gap 维度，或让 handler/driver 各自再包装，重新分岔。应钉成接收完整 `RequestEnvelope`（或明确 `{ctx, clientFormat}` 最小参数）的共享函数；模块路径也应钉死到无环的 owner-failure 模块，例如 `src/lib/pipeline/owner-failure.ts`，并让 driver 导入它。当前位置“随实现定”会影响依赖方向与单一 mint 守卫，不是自由度。

[Blocker] `/home/xp/src/copilot-api-js/docs/plan/2026-07-27-inter-block-anchor-allocator/plan-3-remap-sites.md:118` — 站点示例要求 `return d.outcome`，但 8 个 handler pump 的返回类型是 `Promise<void>`，不能返回 `ResponseOutcome`；即使 TypeScript 允许裸 `return`，outcome 也没有消费者替 pump 做 `ctx.abort/fail/snapshot` — 这与下一句“ctx 侧仍由 pump 自己做”直接冲突。driver 内部可 return outcome，handler pump 必须消费 outcome 并执行对应 settle handler。需要冻结两层接口之一：① adapter 只做纯分类，handler/driver 各自调用一个共享 `applyOwnerOutcome` 完成 snapshot＋settle并返回 `void`；或 ② 抽一个共享 terminal dispatcher，输入 env／sink／snapshot callback，直接完成 ctx 后果。不能用同一 `return outcome` 伪装两种返回类型。

[Major] `/home/xp/src/copilot-api-js/docs/plan/2026-07-27-inter-block-anchor-allocator/plan-3-remap-sites.md:111-116` — committed 维度只细分 client-gone，未定义 adapter 对非法组合的行为，所谓“reason×committed 四行”并非穷尽积空间 — 当前生产约束是 session-terminating／wire-torn 只应 committed=false；若未来或 bug 传入 true，adapter 是照 reason 映射、响亮 throw，还是记录 invariant violation 未定。类型 `OwnerResult` 本身允许三种 reason×boolean 六组合，`Record<OwnerFailureReason,...>` 只能保证 reason 穷尽，不能保证 committed 组合。若 committed 承重，应用嵌套穷尽表或在 adapter 中 assert：非 client-gone 且 committed=true → raise invariant error，并给 positive control。

[Major] `/home/xp/src/copilot-api-js/docs/plan/2026-07-27-inter-block-anchor-allocator/plan-3-remap-sites.md:114` — “保留 partial-delivery 事实”没有载体，不属于安全的实现自由度 — `ResponseOutcome.settled-abort` 无字段，`RequestContext.recordFeature` 的 `FeatureKind` 也没有 owner-partial-delivery 项，公开 context API 没有通用 `recordAttemptDiagnostic`。如果不冻结载体，实施者可能只写日志（History 丢失）、私增 outcome 字段但 pump 不消费、或各站点自造 metadata。按 richest-data-flow，应新增明确的 request-scoped diagnostic API／History 字段，至少记录 `{operation:"close-anchor", committed:true, reason:"client-gone"}`，在 `ctx.abort` 前写入并有持久化 oracle；不要塞入仅 driver 内部短命的 outcome 字段。若现有 `pipelineInfo` 被选为载体，必须定义合并键与投影位置。

[Major] `/home/xp/src/copilot-api-js/docs/plan/2026-07-27-inter-block-anchor-allocator/plan-3-remap-sites.md:122` — adapter oracle 的终态要求仍假设 adapter 自己完成请求终态，与签名所示的纯翻译函数不一致 — “client-gone→aborted／wire-torn→failed／settle exactly once／forwarded snapshot”只能由 pump dispatcher／真实 HTTP 路径证明，不是 adapter unit 的职责。应拆测试：adapter unit 断言 reason×committed→decision 且新增 reason 编译失败；每类 pump 至少一个真实 HTTP 集成断言 decision 被消费后 History state/snapshot/settle 正确。否则 unit 绿仍可能是 adapter 未接线。

[Minor] `/home/xp/src/copilot-api-js/docs/plan/2026-07-27-inter-block-anchor-allocator/plan-3-remap-sites.md:104` — 行尾有 trailing whitespace，`git diff --check` 已报错 — 删除空格；指令文本提交前应保持 diff-check 绿。

## 第十处扫描结论

allocate wrapper 论域、S3、M2/M3、mutation 与 close owner 状态表没有新增事实冲突；当前阻断集中在新 adapter 的类型／模块边界和终局消费协议。该改判应继续，但必须从“示意签名”升级为可编译、可接线的冻结接口。

## 产物 B verdict

**存在 Blocker，不可提交。** 请先冻结共享模块路径、完整 env 输入、handler/driver 两类消费者的终局 dispatcher，以及 partial-delivery 的持久载体，再复审。


---

# 第十一轮复审（仅产物 B）

## 范围、证据与 verdict

- **范围**：评审撤销签名后冻结的八条性质、M1 调查停点、六组合要求及整份 plan-3。
- **证据**：对照 `OwnerFailureReason`／`OwnerResult`、`ResponseOutcome`、`RequestEnvelope`、driver 单一 mint 守卫、handler pump 返回类型与 owner producer；检查 diff；`git diff --check` 通过。
- **总体 verdict**：产物 B **修复 Major 后可提交**。Blocker 0，Major 3，Minor 1。

## 改判裁决

“先冻结性质，M1 第一个 task 读全调用点后定签名与模块位置并停下回报”的改判**没有走得太远**。它把尚未掌握的跨缝接口降为显式 investigation gate，而不是伪装成可执行设计；八条性质足以约束调查结果，不会允许 10 个站点各自翻译。模块路径可以在该 gate 内决定，前提是签名／位置／依赖方向**回填 plan 并完成独立评审后**才继续迁站点。

八条性质可以同时满足：共享层负责 failure→decision 的唯一穷尽翻译并持有足够 env；不同返回类型的 pump 只负责消费同一 decision、完成各自 ctx settle 并短路。这里“短路方式按站点定”不是翻译逻辑分叉，只是返回类型适配。

## 事实性发现

[Major] `/home/xp/src/copilot-api-js/docs/plan/2026-07-27-inter-block-anchor-allocator/plan-3-remap-sites.md:105,116` — 穷尽性正控的 reason 数写错：当前 `OwnerFailureReason` 只有 3 个成员，新增的是**第四个** reason，不是“第五个” — 两处都要求“加第五个 reason 必须红”，会让执行者误以为已有四个 reason，或构造与真实 union 不同的正控。改为“加第四个 reason”；若想表达表有四行，必须明确那是 client-gone 按 committed 拆行，不是第四个 reason。

[Major] `/home/xp/src/copilot-api-js/docs/plan/2026-07-27-inter-block-anchor-allocator/plan-3-remap-sites.md:111,115-117` — 六组合调查要求可执行，但验收仍只按 3 个 reason，未闭合 committed 维度 — 生产类型确实允许 3×2 六组合，实施者可以逐一从 `ownerUnavailable`／write catch 证明可达或给机制性不可达理由；这不是做不到的要求。问题是 unit 条款仍写“每个 reason 的分类正确”，只测 3 格就能绿，无法证明第 8 条完成。应改为：六组合 disposition 表必须回填；每个可达组合有分类 oracle；不可达组合有机制证明＋positive control（破坏 producer 约束后检查能咬住），并让翻译层对非法组合 loud fail 而非只按 reason 降级。

[Major] `/home/xp/src/copilot-api-js/docs/plan/2026-07-27-inter-block-anchor-allocator/plan-3-remap-sites.md:113` — 调查停点缺少“回填后独立评审放行”门，违反本项目指令文本必须评审的硬规则 — M1 第一个 task 会新增共享接口签名、模块位置、partial History 字段和六组合 disposition，这些都是下一阶段模型将照做的指令／架构文本；当前只写“停下回报，签名定稿后补进本节”，没有规定补完后复审，实施者或主会话可能直接继续迁 10 个站点。应明确：更新 plan／kickoff → 独立 reviewer 对签名、依赖方向、六组合和持久字段放行 → 提交文档 → 才执行 M1 后续迁移。

[Minor] `/home/xp/src/copilot-api-js/docs/plan/2026-07-27-inter-block-anchor-allocator/plan-3-remap-sites.md:132` — close preflight 状态表仍漏 `client-gone, committed:false` — `ownerUnavailable()` 在 finishReason 为 client-gone 时同样可达；上方性质已经承认该组合，但精确状态表仍只列 session-terminating／wire-torn。把 client-gone 补入该行，避免“六组合要确认”与现有表互相否定。

## 第十一处扫描结论

除上述 reason 数、六组合验收、复审门和 close preflight 漏项外，八条性质没有内在冲突；partial-delivery 持久载体被明确列为 M1 调查必须冻结的产物，现阶段无需提前替实施者选字段。其余 allocate／S3／mutation 契约保持一致。

## 产物 B verdict

**不可直接提交。** 修复上述 3 Major＋1 Minor 后，这种“调查先行、回填并复审后再实施”的形状可以放行。


---

# 第十二轮复审（仅产物 B）

## 范围、证据与 verdict

- **范围**：复核 reason 数、六组合 disposition、独立评审硬门、close preflight 表，并全文扫描 plan-3。
- **证据**：对照 `types.ts:295-296`、producer 的 `ownerUnavailable`／write catch、项目评审规则与 plan 内既有 gate；检查 diff；`git diff --check` 通过。
- **总体 verdict**：产物 B **修复 Major 后可提交**。Blocker 0，Major 2，Minor 2。

## 已闭合

1. reason 数全文已统一为三个现有成员、增加第四个必须编译失败；未发现残留“四个现有／第五个 reason”。
2. 调查结果回填后独立评审放行的硬门与既有流程不冲突：它是 M1 内部新增指令文本的局部 gate，补强而不替代相位收口 reviewer。
3. close preflight 表已补齐 `client-gone, committed:false`。

## 事实性发现

[Major] `/home/xp/src/copilot-api-js/docs/plan/2026-07-27-inter-block-anchor-allocator/plan-3-remap-sites.md:111,116-117` — 六组合 disposition 要求已经可执行，但验收段仍回退成“每个 reason／每类 reason”三格口径，与上一段直接冲突 — :111 明确要求每个可达组合一条 oracle、不可达组合机制证明＋positive control；:116 却仍写“每个 reason 的分类正确”，:117 仍写“每类 reason 一条真实入口 oracle”。执行者可以按后两行只测 3 个 reason 后宣称通过。必须逐字同步为：翻译 unit 覆盖六组合 disposition（可达逐组合；不可达机制 mutation）；HTTP 档至少覆盖每个**可达且客户端后果不同的组合**，特别是 client-gone committed=false／true 两支的持久诊断差异。

[Major] `/home/xp/src/copilot-api-js/docs/plan/2026-07-27-inter-block-anchor-allocator/plan-3-remap-sites.md:111` — “不可达组合配 positive control：临时破坏机制后测试必须转红”仍可能验证相反的命题，需限定 mutation 目标 — 对 producer 约束做破坏后，如果测试只是因为新组合变成可达而红，它证明的是现有测试拒绝该组合，不一定证明 disposition／翻译层能 loud fail；若翻译层按 reason 静默接受非法 committed 值，producer mutation 也可能在别处先红。要求本身做得到，但必须把 oracle 写成两腿：① producer invariant test 证明正常代码不产该组合，破坏产生点后它红；② translator unit 直接构造该非法组合，断言 loud invariant error。二者缺一都不能支撑“不可达且不会被静默降级”。

[Minor] `/home/xp/src/copilot-api-js/docs/plan/2026-07-27-inter-block-anchor-allocator/plan-3-remap-sites.md:113` — 评审硬门没有要求文档先提交／同步 kickoff 后再实施 — 项目 `docs-merge-before-execute` 要求定稿 plan 先合 master，再单独执行。当前写“回填本节→独立评审放行→继续迁站点”，实施者可能在同一未提交 worktree 中复审后直接开工。改为“回填 plan／必要 kickoff → 独立评审 → 精确 pathspec 提交并合回 master → 用户／编排方批准继续 → 新执行 worktree 迁站点”。这不是重复，而是项目级既有门在 M1 局部分叉处的落地。

[Minor] `/home/xp/src/copilot-api-js/docs/plan/2026-07-27-inter-block-anchor-allocator/plan-3-remap-sites.md:98-113` — 标题仍说“必须先建共享翻译层”，而第一个 task 实际只调查、定签名、回填、停下，尚不实现翻译层 — 容易让实施者在调查 gate 前先写代码。改成“必须先完成共享翻译层的调查／定稿闭环，再建翻译层和迁站点”，与后文顺序一致。

## 第十二处扫描结论

三 reason 枚举、八条性质、close preflight 与 partial 持久载体要求已自洽。剩余问题集中在六组合验收退回三 reason 口径，以及局部评审门未完整落到项目 docs-first 流程。其余 allocate／S3／mutation 契约无新增冲突。

## 产物 B verdict

**不可直接提交。** 修复 2 Major＋2 Minor 后可再复审，届时重点只需核六组合 oracle 和 M1 docs-first gate。


---

# 第十三轮复审（仅产物 B）

## 范围、证据与 verdict

- **范围**：核对六组合口径、两腿不可达正控、docs-first 硬门，并全文复核 M1 mirror-state／owner 边界。
- **证据**：对照 `GenerationWireState`、`AnchorState`、delivery session 构造入参、synthetic injector mirror 实现和现有类型守卫；检查 diff；`git diff --check` 通过。
- **总体 verdict**：产物 B **修复 Major 后可提交**。Blocker 0，Major 2，Minor 1。

## 已闭合

1. 六组合口径在性质、unit、HTTP 与不可达 disposition 四处已经同步；没有残留以 3 个 reason 代替 6 个组合的验收文本。
2. docs-first 硬门与项目流程一致。它把 M1 调查产生的新指令文本显式送入“评审→精确提交→合主线”闭环，不是重复冲突。

## 事实性发现

[Major] `/home/xp/src/copilot-api-js/docs/plan/2026-07-27-inter-block-anchor-allocator/plan-3-remap-sites.md:76,96,121-142` — 第十三处是 M1 legacy mirror 的供给缝仍未设计：plan 要求 delivery owner 成为 `anchorBlockOpen`／`anchorClosed` 唯一写者并逐格维护表，但当前 owner 只收到 `GenerationWireState`，其中只有 allocator／mappings／legSources／activeLeg／openAnchorIndex（`src/lib/pipeline/types.ts:485-492`）；三个 legacy 字段位于独立、handler-owned 的 `AnchorState`（`:519-543`），`CreateDownstreamDeliverySessionOptions`／session 没有它的引用。现有 synthetic injector 是调用 owner 前后自己写 mirror（`keepalive-anchor.ts:319-353`），正与“owner 唯一写者”目标相反。M1 当前调查 gate只要求读 failure 站点与 pump 返回类型，不会必然发现这条状态供给缝 — 将 mirror ownership 纳入 M1 第一调查 task并冻结一种单一权威方案：字段移入 `GenerationWireState`、显式 mirror port／callback，或其它经评审方案；回填 identity／唯一写者 oracle后才迁站点。否则实施者只能临场把 `AnchorState` 偷进 owner或保留双写者。

[Major] `/home/xp/src/copilot-api-js/docs/plan/2026-07-27-inter-block-anchor-allocator/plan-3-remap-sites.md:127,139` — post-commit 失败固定写 `anchorClosed=true` 与该字段的正式语义冲突，且 committed 位不足以推出它 — `AnchorState.anchorClosed` 的类型契约是“已发出 `content_block_stop`”（`types.ts:540-541`）；`allocateAndWriteAnchor` 的 post-commit 只表示首个外部 write 已**尝试**，失败可能发生在 message_start、anchor start 或 delta 任一点，根本不包含 stop，更不能证明 anchor 已关闭。表却将 `anchorClosed=true`，随后又说“post-commit 不回退 anchorBlockOpen”，制造“open=true、closed=true、openAnchorIndex仍指向未关 anchor”的名实冲突。若真实目的只是阻止 legacy 路径再尝试 close，应使用 `wireTorn`／独立 poison 或明确迁移期 `closeSuppressed`，不能伪造“stop 已发出”。M1 调查应逐失败位置 disposition mirror 状态；无法精确知道 wire 是否接收时应诚实记录 attempted／torn，而非把 `anchorClosed` 当 poison bit。

[Minor] `/home/xp/src/copilot-api-js/docs/plan/2026-07-27-inter-block-anchor-allocator/plan-3-remap-sites.md:111` — 不可达组合的 translator 腿需明确允许“类型系统已排除”作为更强机制，避免倒逼翻译层接受宽松六组合输入 — 若 M1 把 failure 类型收紧为只包含可达组合，非法对象不能正常构造；此时可执行的正控应是类型级 `@ts-expect-error`／producer mutation 编译失败。只有翻译层仍在运行时接收宽 `OwnerResult` 时，才用 test-only unsafe cast／raw fixture 直接喂非法组合并断言 loud fail。当前无条件要求“直接构造喂入”虽可用强制 cast 绕过，但可能诱导实施者为了测试保留更宽、更弱的公共类型。按最终边界类型选择其一，并在 disposition 中记录，不要同时强制。

## 第十三处扫描结论

六组合与评审硬门已闭合；剩余核心缺口转到另一个尚未纳入调查 gate 的集成缝：owner 如何取得并诚实维护 handler-owned legacy mirror。其余 S3／M2／M3／mutation 未发现新冲突。

## 产物 B verdict

**不可直接提交。** 修复 2 Major＋1 Minor 后再复审；重点是把 mirror ownership 纳入调查闭环并撤销 `anchorClosed` 的 poison 误用。


---

# 收口轮复审（仅判本轮三处改动）

- **范围**：只审 post-commit `anchorClosed=false`、新增 M1 供给缝、非法组合类型级负测；不重审继承自旧 plan 的设计。
- **证据**：`AnchorState.anchorClosed` 类型语义、delivery session 入参、synthetic injector 与 11 个 close 站点；`git diff --check` 通过。
- **verdict**：**修复本轮新增的 1 个 Major 后可提交**。Blocker 0，Major 1，Minor 1。

[Major] `/home/xp/src/copilot-api-js/docs/plan/2026-07-27-inter-block-anchor-allocator/plan-3-remap-sites.md:98` — 新增供给缝给出的第二个“可选方案”不可覆盖本节要求的 close 双写 — `synthetic injector wrapper` 只包围 `allocateAndWriteAnchor` 的 open 路径（`keepalive-anchor.ts:319-353`）；11 个 close 站点直接调用 `closeOpenAnchor`，不经过该 wrapper，因此把 mirror 写“留在 synthetic injector wrapper 层”无法在 close 成功时更新 `anchorClosed`，与表和 exactly-once oracle 的目标冲突。把选项改成“handler-owned mirror port／wrapper，必须同时中介 open 与全部 close 调用”，或删掉这个未闭合选项；M1 仍须在调查后停下、回填、评审、合主线。

[Minor] `/home/xp/src/copilot-api-js/docs/plan/2026-07-27-inter-block-anchor-allocator/plan-3-remap-sites.md:113` — 类型级腿二替代已正确避免放宽公共类型，但腿一仍无条件要求“producer 真的产出组合、测试转红” — 若最终类型在 producer 边界也排除了该组合，破坏 producer 会先编译失败而无法运行测试。允许腿一同样采用类型级 mutation／compile-red；只有运行时仍接受宽输入时才要求实际产出并运行时转红。

本轮把 allocation post-commit 的 `anchorClosed` 改成 `false` 正确：该字段表示 `stop@0` 是否已发出，而 allocation committed 只证明首笔 write 已尝试。新增供给缝的停点、回填、独立评审与合主线时机也足够明确；除上述不完整选项外，没有与前十三轮改动形成新的矛盾。

**产物 B 当前不可直接提交。**


---

# 确认轮（仅两处）

- **mirror port**：修正后的方案 (b) 本身可行。现有 `AnchorState` 由 handler 创建并持有；open 入口由 handler 构造 injector，handler 的终局 close 已集中经过共享 `closeAnchorIfOpen`，driver 内两处 close 也已通过 `RunBufferedOpts.anchorState` 取得同一状态。因此 M1 可以由 handler 构造一个 request-scoped mirror port，传给 open injector、handler close primitive 与 driver opts，使其成为 open／全部 close 的唯一中介。正文已明确“全部 close＋唯一中介”，不会再被误读成仅包 open。具体签名与传递路径留给 M1 调查、回填、评审和合主线，符合既定硬门。
- **类型级正控**：producer 与 translator 两腿都允许在类型已排除非法组合时采用 `@ts-expect-error` compile-red，且禁止为测试放宽公共类型，修正正确。
- **格式证据**：`git diff --check` 通过。
- **verdict**：限定本确认轮范围，未发现新问题；产物 B **可以提交**。
