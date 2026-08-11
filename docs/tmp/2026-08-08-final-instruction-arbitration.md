# 2026-08-08 B 级指令终审

裁判轴：长远正确＋完整。范围严格限定为 A–E；只记录 BLOCKER／MAJOR，PASS 表示该项未发现 BLOCKER／MAJOR。

## A．真单写入源是否保留

**PASS（0 blocker，0 major）。** user-rule `41-doc-mgmt` 的英文生效投影第 10–12 行与中文权威源第 12–14 行同时区分“一个权威来源”与“唯一写入源”，并明确保留 type owner＋consumer re-export、明细→派生摘要、活跃进度写入权转移三类单写入机制。项目 `CLAUDE.md:14,40` 保留类型 owner 与真正单写入源；`session-closeout/SKILL.md:57-61,115-117,166` 又把 HANDOVER／KICKOFF 的解释性复述与 progress→HANDOVER 的活跃写入权转移分开。允许语境完整复述没有产生第二个可独立维护的写者。

## B．是否仍有活指令把完整复述一律删成指针

**MAJOR B-1。** 最终核心 rules／skills 已改对，但目标 worktree 内仍有明确活跃、尚未完成的交接把旧绝对口径写成未来动作：`docs/plan/2026-08-03-upstream-transport-provider/HANDOVER.md:2,52-66` 状态仍是“草稿·评审中”，T2 要求“只建一个权威落点，其余文档只放短指针”，验收又要求相关行“不复制状态事实”。这不是已标 superseded 的历史引文，而是待执行待办；执行者照做会把本可带权威引用和基线完整复述的内容一律压成指针，违反 user-rule `41-doc-mgmt` 的新 `[hard]` 口径。应把 T2 改成：DESIGN 为权威写入点；其它相关文档可按读者语境完整复述并引用，易变 `[wip]`／owner／下一步须同基线同步，只有无法可靠同步的高 churn 部分才缩成指针。

**其余扫描结果。** `docs/plan/2026-07-27-inter-block-anchor-allocator/kickoff.md` 虽含“事实一律回权威文档／本 kickoff 不复述”，但文件头 `:1-5` 已明确标为陈旧、`superseded-by KICKOFF.md` 且“仅作历史留存”；旧 session-closeout 评审文件中的绝对句是历史 finding，并非当前规范。当前 `CLAUDE.md`、`session-closeout`、`adopting-agent-findings`、`writing-handover-docs` 均允许带权威引用的语境完整复述。

## C．moving HEAD 信号门是否双向正确

**MAJOR C-1。** 六类升级信号在 user-rule、`adopting-agent-findings/SKILL.md:13`、`session-closeout/SKILL.md:133-139` 及 HANDOVER/KICKOFF 模板中已经闭合，并都限定为只复验受影响范围；无关 HEAD 前进不会触发重复全量复验，错误状态与正确状态两向均成立。但 `/home/xp/.claude/skills/writing-handover-docs/SKILL.md:13-23` 仍要求每次动笔前无条件跑固定 Git 命令，并写死不存在于本项目的 `docs/TRACKING.md`；第 23 行还把每条“待做／已知缺陷／下一步”无例外限定为“用命令验证”。这与同 skill `:63-74` 的“按最强独立证据；用户裁决回一手来源；无法验证则标待验证”自相矛盾，也会把仅有无关 HEAD 前进的正确状态重新变成重复 Git 复验，把当前项目的权威入口错指到不存在路径。应改为：先从项目 CLAUDE／文档路由定位具名状态权威；逐条用当前最强独立证据核验，仓库／运行态 claim 才跑命令，用户裁决回一手来源；HEAD 变化仅在六类具体信号命中时触发受影响范围复验。本项目实例应指向 `docs/DESIGN.md` 的“活的架构现状”及其所引 spec／ADR，而非 `docs/TRACKING.md`。

**B-1 复读处置：已闭合，当前 B 为 PASS（0 blocker，0 major）。** 协调方通知后复读 `/home/xp/src/copilot-api-js/.claude/worktrees/revise-ssot-trust-408-skill/docs/plan/2026-08-03-upstream-transport-provider/HANDOVER.md:3-4,61-67`：头部现已把无关 HEAD 前进排除在失效信号外；T2 明定 DESIGN 为权威写入点，允许其它文档按读者语境完整复述并引用，易变状态同基线同步，仅无法可靠同步的 high-churn 部分缩为精确指针。原 B-1 所引旧绝对指令已经不存在。

**C-1 复读处置：已闭合，当前 C 为 PASS（0 blocker，0 major）。** 协调方通知后复读 `/home/xp/.claude/skills/writing-handover-docs/SKILL.md:14-24,62-75`：该 skill 仍在交接动笔边界刷新仓库状态，但项目状态权威改为先从项目 CLAUDE／文档路由定位，本项目明确指向 DESIGN“活的架构现状”；claim 核验已按最强独立证据区分仓库／运行态命令、用户裁决一手来源和“待验证”。结合 user-rule `01-core-principles.md:18-19`、中文权威源 `:20-21`、agent 补充规则 `62-docs-and-handover.md:28-32` 与项目 `session-closeout/SKILL.md:134-140`，无关 HEAD 前进不触发重复全量复验，六类真实升级信号仍触发受影响范围复验；false-red／false-green 两向均闭合。

## D．408 skill、自验、测试与不拆分是否闭合

**PASS（0 blocker，0 major）。** `.claude/skills/debugging-ghc-api-upstream-transport/SKILL.md:1-3,49-66` 以用户会报告的精确错误原文触发，并给出 History → framing → 生产 `http2Fetch` 本地 h2c 逐字节 oracle → proxy／并发环境差异的可执行顺序；每层都写明不能外推的边界。产品契约由 `docs/request-pipeline.md:9-13` 独占，`classify.ts:177-188,325-336` 实现 HTTP 408＋精确 code＋message 前缀三条件 matcher；`network-retry.ts:28-55` 与 `retry-registry.ts:154-170` 实现全 leg 共用、同 payload、1 秒、最多一次。classifier 正控及七类近邻／畸形负控见 `tests/infra/error.unit.test.ts:160-190`，production Responses stack 正控与四类终态负控见 `tests/pipeline/driver.unit.test.ts:416-504`；本轮实跑三个靶向文件为 176 pass、0 fail。既有独立 Round 2 还用“放宽为全部 408”的冻结 mutation 证明负控会红，恢复后 13/13 绿。skill `:88-98` 与同目录 `verification-log.md:1-17` 已建立 V1–V3 field 自验，并诚实把作者／静态评审记为“数据不足”；当前章节共用 History、framing、`http2Fetch`、proxy／并发与 classify 链，不拆分，且列出未来流式上传／请求压缩／HTTP/3、独立验证资产／维护周期或独立加载等可观察拆分触发。

## E．层次是否自洽

**PASS（0 blocker，0 major）。** 层次分工现已闭合：user-rule `41-doc-mgmt` 定义“一个权威来源＋允许语境完整复述＋保留真正单写入源”；user-rule `01-core-principles` 定义 moving HEAD 的六类升级门；agent rule `62-docs-and-handover` 只补充交接边界必须刷新当前状态，且明确不把无关 HEAD 前进解释为反复全量复验。全局 `writing-handover-docs` 负责跨项目的交接方法并从项目路由发现权威；项目 `CLAUDE.md:12-28` 把本项目权威落到 DESIGN／spec／ADR；项目 `session-closeout` 再定义 HANDOVER 权威写入、KICKOFF 启动投影、progress 写入权移交及同基线同步，模板与当前 live provider HANDOVER 均按该口径落地。408 侧由 `docs/request-pipeline.md` 独占产品 retry 契约，transport skill 只完整解释诊断与证据边界并回指该权威；没有第二份可独立裁决的产品契约。未发现上层规则被下层豁免架空、同层相互拆台或模板反向恢复旧口径。

## 总裁决

**可定稿：0 blocker，0 major。** A、D、E 首次裁决即 PASS；B-1、C-1 是终审过程发现的 live 残留，协调方修复后已按绝对路径复读并闭合，故不计入当前未决数。D 的本轮靶向命令为 `bun test tests/infra/error.unit.test.ts tests/pipeline/network-retry-strategy.unit.test.ts tests/pipeline/driver.unit.test.ts`，在目标 checkout 得到 176 pass、0 fail；该数字仅由 test runner 单一口径取得，标记为“未交叉验证”，只支持这三个文件，不外推为全套件。

## 未采纳建议

- 未建议把 408 章节拆成独立 skill：当前诊断原语、代码 seam、测试资产与加载语境仍高度共用；正文已经给出未来可观察的拆分触发，现拆只会制造双份前置知识。
- 未要求删除报告中已闭合的 B-1／C-1 初始 finding：保留“发现→修复→绝对路径复读→闭合”的裁决链，比覆写成从未发生更可审计；总裁决明确当前未决为 0。
