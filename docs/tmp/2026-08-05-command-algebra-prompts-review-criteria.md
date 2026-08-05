# 第三层 instruction-text prompts 评审——判据证伪与 prompt↔plan 契约漂移

评审锚点：隔离 worktree `/home/xp/src/copilot-api-js/.worktree/agent-acbb3131db83420e7`，HEAD `3b9e066d1356c13ac7be7f7713cf5aad9433dad0`。

## 事实性发现

[blocker] `/home/xp/src/copilot-api-js/.worktree/agent-acbb3131db83420e7/docs/rfc/2026-08-03-generation-emission-command-algebra/prompts/post-merge-preflight.md:6-8,18-22,40,47` 与 `/home/xp/src/copilot-api-js/.worktree/agent-acbb3131db83420e7/docs/rfc/2026-08-03-generation-emission-command-algebra/prompts/commit-0.md:18-19,42` — T0.0d 与 T0.1 形成不可达因果环 — post-merge T0.0d 要先消费 A 上“树外 15-run evidence”才允许进入 Commit 0；但 `T0.1` 正是“对 A 跑树外 15-run batch”的唯一 task，且 Commit 0 prompt 明令 T0.0d 未过不得开始 T0.1。上游 plan 同样自相矛盾：`cutover-plan.md:470-487` 要先跑 T0.1 的 15 次再运行 T0.0d，却又写 validator 绿后才允许执行树开始 T0.1；`traceability.md:131` 也把 15 次归给 T0.1。命令证据：task checker 与 trace checker 均 rc=0，分别报 83/83 与 14R/9O，说明两门只验集合／追溯，未验因果可达性。具体错误动作：执行 agent 只能在三种错误中择一——绕过 T0.0d 先执行 T0.1、拿一批无 task 归属的 15-run artifacts 冒充 T0.1 前置、或无限停在 Commit 0 入场门；主流程无法按文本合法启动。修复建议：重裁并只保留一个无环归属。推荐把“生成 A 的 15-run evidence”从 T0.1 明确迁到 post-merge phase（新 task id 或把 T0.1 整体归该 phase），顺序固定 `A → 15 runs/manifest → P → T0.0d validate → C0 characterization`；若 T0.1 还承担 C0 内其他工作，拆成两个 task，checker/traceability/prompts 同步。

[major] `/home/xp/src/copilot-api-js/.worktree/agent-acbb3131db83420e7/docs/rfc/2026-08-03-generation-emission-command-algebra/prompts/post-merge-preflight.md:44-46` — 可复制的 `git show` 门给了不存在的仓库根路径 `HANDOVER` — plan 的 SSOT 路径是 `docs/plan/2026-07-27-inter-block-anchor-allocator/HANDOVER.md`（`cutover-plan.md:492`），prompt 却写 `git show "$POINTER_SHA":HANDOVER`。命令证据：在目标 HEAD 执行 `git cat-file -e HEAD:HANDOVER`，rc=128，报 `path 'HANDOVER' does not exist`；真实文件位于深层路径。具体错误动作：执行 agent照 prompt 跑会把正确的 P/evidence 状态判成 fail-closed，阻断 Commit 0；更糟的是它可能临场改用自然语言 grep 或工作区文件，绕开 versioned pointer oracle。修复建议：逐字使用 plan 的完整 path，并把路径定义成单一变量／validator 内部常量，prompt 只引用 validator 命令，不再手抄简写。

[major] `/home/xp/src/copilot-api-js/.worktree/agent-acbb3131db83420e7/docs/rfc/2026-08-03-generation-emission-command-algebra/prompts/commit-4.md:15-18,42-43` — Q5 停门在同一 prompt 内形成自相矛盾的前置条件 — `commit-4.md:17` 要求“Q5 逐帧预测 diff 已审”才可进入本 phase，但同文件 `:43` 又把产出／审查该 diff 的 `T4.1` 分配给本 phase；已放行 plan 的真实顺序是 `T4.0a～d → T4.1 Q5 停门 → T4.2` 开始 authority publish（`cutover-plan.md:798-820`），要求的是 publish 前而非 Commit 4 prompt 启动前。命令证据：`python3 exp/inter-block-anchor-allocator/prompt-task-check.py` 仍 rc=0（83/83），说明人口 checker 看不见该语义矛盾。具体错误动作：执行 agent 会在 T4.1 尚未执行时因前置不满足而直接停工，或把 T4.1 擅自前移到 Commit 3／另一个 prompt，破坏唯一 task 归属和已放行施工顺序。修复建议：把前置改成“进入 T4.2 authority publish 前，T4.1 的 Q5 diff 必须已审；本 prompt 先执行 T4.0a～d、再执行 T4.1”，README phase 行也用同一 publish-boundary 表述。

[major] `/home/xp/src/copilot-api-js/.worktree/agent-acbb3131db83420e7/exp/inter-block-anchor-allocator/prompt-task-check.py:25,43` — checker 把 plan 全文任意 task-id 提及冒充 task population SSOT，无法证明“83 个 task 定义”各归一个 prompt — `tasks(PLAN.read_text())` 扫全文；副本 mutation 删除 `T2.8` 的 task 定义行、仅在 §12 前加 `<!-- historical mention T2.8 -->`，checker 仍输出 `plan tasks: 83`、`prompt tasks: 83`、`prompt-task-check: OK`、rc=0。另两个目标 mutation 均正确变红：`T4.0d→T4.0z` 报 orphan+unassigned；给 Commit 1 追加 `T0.1` owner 报 duplicate。具体错误动作：plan 可删除／改名一条真实 task，却因历史说明、交叉引用或“未采纳”段仍含旧 ID 而继续全绿；执行 agent随后照 prompt 执行已不在放行 task 表里的孤儿工作，或漏掉替代 task。修复建议：用结构化 task-definition marker／解析每个 Commit 的“逐 task”表第一列作为 population，不从全文提取；再做正控“删定义但保留历史 mention 必须红”与 false-red“同一 task 在正文被多次引用仍绿”。

[major] `/home/xp/src/copilot-api-js/.worktree/agent-acbb3131db83420e7/docs/rfc/2026-08-03-generation-emission-command-algebra/prompts/README.md:24-28,34-43,46` — phase 导航同时宣称 C4 可直接后继 C5／C6／C7／C8，又宣称整链严格串行 — 表中 C4 的“后继”写 `Commit 5/6/7/8`，但紧邻 DAG 是 `C4→C5→C6→C7→C8`，且 `:46` 明说没有可并行 implementation phase；已放行 plan 也逐 commit 串行（`cutover-plan.md:942,1021,1069,1095`）。命令证据：`rg -n "Commit 5/6/7/8|C4 --> C5|没有可并行" .../prompts/README.md` 可并列复现矛盾，两个 checker 仍均 rc=0。具体错误动作：Q1 在 C5 阻塞时，执行 agent可按表把 C6／C7／C8 当 C4 的合法直接后继，绕过 telemetry/History commit 后删除 legacy、审 golden、同步 docs，得到与 plan 不同的历史和不完整终态。修复建议：C4 后继只写 Commit 5；C5 后继只写 Commit 6；C6 只写 C7；C7 只写 C8，禁止用斜线列传递后继。

[major] `/home/xp/src/copilot-api-js/.worktree/agent-acbb3131db83420e7/docs/rfc/2026-08-03-generation-emission-command-algebra/prompts/README.md:61` — 集中红线把“不得重裁 Q1/Q2/#5/#6”写成无条件禁令，与各 phase 必须完成未裁决项直接冲突 — 当前 plan 明示 Q1、Q2、#5、#6 均尚未裁（`cutover-plan.md:1158-1163`）；Commit 1/5/8 prompts 又分别要求到触发点完成裁决。具体错误动作：执行 agent到 Commit 1 或 Commit 5 时，可能把“提出并取得首次裁决”误解为“重裁”而拒绝推进；反方向也可能忽略红线，连已经裁过的内容一起重开。命令证据：`rg -n "不重裁 Q1/Q2/#5/#6|未裁|不得开工" prompts/*.md cutover-plan.md` 同时命中相反指令，checker 均不报。修复建议：改成“已裁事项不得重开；截至派发时未裁的 Q1/Q2/#5/#6 必须仅在各自触发点取得首次裁决，裁后不得重裁”，并逐项区分 Q2 的默认 B 与显式 ADR 编辑授权。


## 第二轮复评（整改 commit `0eb76f26`、`f0c799a5`、`51cd3e78`）

复评证据锚：从 commit `51cd3e784f69b1367fd7b8685b737e0445e0cf46` 以 `git archive` 提取只读快照 `/tmp/command-algebra-r2-51cd3e78`；在该快照运行 prompt checker 得 84/84、trace checker 得 14 R／9 O，均 rc=0。首轮的 15-run task 归属环、短 `HANDOVER` 路径、Q5 未来前置、即时后继表、无条件“不得重裁”五项已按整改声称闭合。

### 仍存事实性发现

[blocker] `/tmp/command-algebra-r2-51cd3e78/docs/rfc/2026-08-03-generation-emission-command-algebra/cutover-plan.md:483-536,545,634` 与 `/tmp/command-algebra-r2-51cd3e78/docs/rfc/2026-08-03-generation-emission-command-algebra/prompts/post-merge-preflight.md:41,48` — validator 的 producer contract 仍未定义 T0.1 必须消费的 versioned verdict/receipt — §0.4f 冻结了 CLI flags、pointer/manifest schema、退出码与 stderr，却没有 receipt 的输出路径、schema、写入时机或 CLI flag；实际命令也无 `--receipt`，但 T0.0d 被要求“产出 versioned verdict/receipt”，T0.1 又要读取并 mutation 其中的 `ENTRY_SHA` 与 `verdict`。命令证据：`rg -n "receipt|versioned verdict" ...` 的全部命中只有消费者要求和一句“产出”，无任何 receipt schema/路径定义。具体错误动作：Commit -1 implementer 必须临场新增未放行的 CLI 输出/签名，或 T0.0d 只凭 rc=0 继续而让 T0.1 找不到 receipt；两者分别违反“不新增接口”和使 Commit 0 入场不可执行。修复建议：在 §0.4f 冻结唯一 receipt 路径传递方式（例如显式 `--receipt-out <树外绝对路径>`）、完整 versioned schema、原子写入条件（仅 rc=0）、hash/来源绑定与 T0.1 的读取命令；T0.0e 的正负控覆盖缺失、篡改、错误 A/P/validator version。

[major] `/tmp/command-algebra-r2-51cd3e78/exp/inter-block-anchor-allocator/prompt-task-check.py:39-53` — checker 仍未真正限定“各 Commit 逐 task 表”，任意位置的 task-shaped Markdown 行仍可冒充定义 — 副本 mutation 把真实 T2.8 定义行移出 Commit 2，原样放进 §12 历史/未采纳区，checker 仍报 84/84、`prompt-task-check: OK`、rc=0。此前“删定义仅留普通历史 mention”会正确报 orphan，suffix mutation也正确报 orphan+unassigned，但都未覆盖这一等价行形。具体错误动作：plan 可从执行 phase 删除一个 task、把旧行保留在 archive/历史表，prompt 仍会合法拥有这个已无执行归属的 task；执行 agent会照旧 prompt 做被 plan 移除的工作。修复建议：解析并校验 section 状态机，只接受明确 `## Commit -1`、post-merge 独立 section、`## Commit 0～8` 下首个“逐 task”表；同时核对 task prefix/phase 与 section，并加入“定义行搬到 §12 仍必须红”的正控。

[major] `/tmp/command-algebra-r2-51cd3e78/docs/rfc/2026-08-03-generation-emission-command-algebra/prompts/commit-8.md:19-20,31-32,52` — prompt 新增 continuation ADR D2 的 Commit 8 硬停门，但已放行 plan 未承载该 task/停点，且 RFC 把它留给 P8 — `cutover-plan.md:1154-1168` 的 Commit 8 只有 richest-data-flow Q2，T8.1～T8.7 无 continuation D2 replacement task；`design.md:501,681` 明写 ADR D2 第 3 点按既有 P8.4 停点／P8 文档后果处理。prompt 却要求 C8 产逐段 replacement 草案、未获用户同意不得声称 docs closeout 完成。命令证据：`rg -n "continuation-retry-sequential-anchor|ADR D2|replacement 草案" cutover-plan.md traceability.md design.md` 仅命中 RFC 的 P8 归属，不命中 plan/matrix task；prompt checker 仍 rc=0，因为它只看 marker，不审 task 内容。具体错误动作：执行 agent会在 C8 提前重开 P8 用户停点、扩写未放行产物，并无 task id 地阻断本 RFC 完成；或按 plan 忽略它而违反 prompt。修复建议：不要由 prompt 新增停点；若确需前移，先由 architect-advisor/用户重裁 RFC 的 P8 归属，再在 plan、traceability、task population 中增加具名 task 与验收；否则删除 prompt 的 C8 D2 门，保留 T8.5 对文档冲突的审计与 P8 指针。

### 第二轮总体 verdict

存在 1 blocker、2 major；首轮 1 blocker/5 major 中 5 项已证实修复，但 validator receipt 接缝仍阻断执行，checker 仍有结构性 false-green，Commit 8 prompt 仍新增未放行停点。不可进入执行阶段。


## 第三轮复评（整改 commit `78480cde`）

复评证据锚：commit `78480cde` 的只读快照 `/tmp/command-algebra-r3-78480cde`。原文 prompt checker 84/84、trace checker 均 rc=0；suffix mutation 正确报 orphan+unassigned。二轮 continuation ADR D2 越权扩展已撤回，receipt v1 的 plan 端 schema/atomic-write/消费校验已补齐。

### 仍存事实性发现

[blocker] `/tmp/command-algebra-r3-78480cde/docs/rfc/2026-08-03-generation-emission-command-algebra/prompts/post-merge-preflight.md:41,48` 对照 `/tmp/command-algebra-r3-78480cde/docs/rfc/2026-08-03-generation-emission-command-algebra/cutover-plan.md:483-497` — preflight 仍未调用 plan 冻结的“同一 CLI”，T0.0d 无法生产 T0.1 的 receipt — plan 唯一 CLI 新增必需的 `--receipt-out "$RECEIPT"`，并规定 rc=0 时原子写 receipt；prompt 的可执行命令仍止于 `--handover ...HANDOVER.md`，完全漏掉 `--receipt-out`，但下一门却要求“产出 versioned verdict/receipt”。命令证据：`rg -n "--receipt-out|validate-entry-evidence"` 显示该 flag 只在 plan，不在 prompt 命令。具体错误动作：执行 agent逐字运行 prompt 时，要么 validator 因缺必需参数返回 CLI/schema 错而 T0.0d 永远不过，要么实现者为兼容 prompt 私增默认 receipt 位置，违反“prompts 不得另造接口”；T0.1 随后无 receipt 可读。修复建议：prompt 先定义树外绝对 `RECEIPT`，再逐字复制 §0.4f 的完整命令含 `--receipt-out "$RECEIPT"`，并在 gate 中核 stdout path/hash；加一条 prompt-command parity 的静态检查或可执行 smoke fixture。

[major] `/tmp/command-algebra-r3-78480cde/exp/inter-block-anchor-allocator/prompt-task-check.py:39-59` — section relocation false-green 仍存在，只是绕法从“任意历史行”收窄为“历史标题含逐 task” — checker 对任意三级/四级标题只做 `"逐 task" in line`，不验证它位于允许的 Commit/post-merge section。副本 mutation 删除 Commit 2 的 T2.8 定义，并在 §12 下增加 `### 历史逐 task 表` 后原样放入该行，checker 仍 84/84、rc=0。具体错误动作：归档/未采纳部分若保留一个名为“历史逐 task”的旧表，就能让已从 live phase 删除的 task 继续被 prompt 合法拥有并执行。修复建议：以允许的父级 section 身份建状态机，并要求每个 live section 恰有一个指定标题的定义表；post-merge 单独白名单；mutation 必含“整张旧逐 task 表搬到 §12”而非只搬裸行。

[major] `/tmp/command-algebra-r3-78480cde/docs/rfc/2026-08-03-generation-emission-command-algebra/design.md:734,759` 与 `/tmp/command-algebra-r3-78480cde/docs/rfc/2026-08-03-generation-emission-command-algebra/traceability.md:42` — Q5 的承重总表仍保留“Commit 4 前／C4 前”旧边界，与同文件精确的 T4.2 边界相反 — design §9.4、§7.7 与 trace §4 已改为“可进入 C4，T4.2 publish 前”，但 design R-12 仍写“Commit 4前过 Q5”，trace R-12 仍写“C4 前先过 Q5”。命令证据：`rg -n "Q5|T4.2|Commit 4前|C4 前"` 同时命中两种边界。具体错误动作：按 §10.2 验收表或 trace R-12 行执行的 agent 会在尚未运行 T4.1 producer 前要求 Q5 已完成，重新制造首轮的未来前置；按细表执行则违反总表。修复建议：两行统一改成“C4 内 T4.2 authority publish 前”，并将旧短语做冻结零命中检查；不要依赖后文精确表覆盖前文。

### 第三轮总体 verdict

存在 1 blocker、2 major；二轮三项中 D2 已修、receipt 的 plan 侧已修但 prompt 调用仍漏 flag、checker section relocation 仍假绿；另发现 Q5 总表残留旧边界。不可进入执行阶段。


## 第四轮复评（稳定态 `ad87cf00`）

复评证据锚：commit `ad87cf00` 的只读快照 `/tmp/command-algebra-r4-ad87cf00`。机械基线 prompt checker 84/84、trace checker、Q1 pre gate、checker py_compile 均绿。三轮的 receipt CLI 漏 flag、Q5 R-12/trace 旧边界、D2 越权扩展与 §12 整表 relocation 已修。

### 仍存事实性发现

[major] `/tmp/command-algebra-r4-ad87cf00/exp/inter-block-anchor-allocator/prompt-task-check.py:39-79` — checker 仍未验证 task 定义属于其正确 commit，只验证“位于某个 live Commit 下的任意逐 task 标题” — 副本 mutation 删除 Commit 2 的 T2.8 定义，把原行放到 `## Commit 2` 末尾新建的 `### 历史逐 task 表`，checker 仍输出 84/84、rc=0；移到 §12 的同型 mutation会正确报 orphan。具体错误动作：plan 可把 task 从 live 施工表撤下却保留在同一 commit 的历史/废案逐-task表，prompt 仍获准执行它；也可把定义搬到错误 commit 的逐-task表而人口保持不变。修复建议：每个 live commit 只接受**恰一个、标题精确匹配**的定义表，并校验 task prefix 与 owner section（T2.* 只能在 Commit 2，T0.0a/c/e 在 Commit -1，T0.0d/f 仅 §0.4f）；新增“同 Commit 历史逐 task 表”和“跨 Commit 搬行”两条 mutation。

[major] `/tmp/command-algebra-r4-ad87cf00/docs/rfc/2026-08-03-generation-emission-command-algebra/design.md:494` — Q5 摘要仍写“保留 Commit 4 前的逐帧 diff 停门”，与同文 `:625,715,734,759` 冻结的“T4.2 authority publish 前”边界不一致 — 这是三轮旧短语残留，协调方声称的 old Q5 residue 0 不成立。具体错误动作：执行者先读 §6.1 摘要时会要求进入 Commit 4 前已有由 T4.1 产出的 diff，再次形成未来前置；后读 §7/§9/§10 又得到相反许可。命令证据：`rg -n "保留Commit 4前|T4.2 authority publish前" design.md` 同时命中两种边界。修复建议：将该摘要精确改为“保留 Commit 4 内 T4.2 authority publish 前的逐帧 diff 停门”，并对语义短语而非只对 `Commit 4前过Q5` 做零残留扫描。

[major] `/tmp/command-algebra-r4-ad87cf00/docs/rfc/2026-08-03-generation-emission-command-algebra/cutover-plan.md:495` — discovery baseline v1 仍只给“至少含”字段，未冻结完整 schema／额外字段策略，却被声明为 producer 的独立版本化接口 — 与同节 manifest/receipt 明确“完整 schema、额外字段 fail-closed”相比，baseline 没有字段名、顶层形状、identity 编码/顺序、multiset 表示、`minimum_executed` 口径载体或 schema_version 的完整定义。具体错误动作：Commit -1 实现者仍必须现场设计 `entry-test-discovery-baseline.json`，producer 与 validator/test 可各自采用不同但都满足散文的格式；T0.0f “原样调用已冻结 CLI”并不能保证它读得懂另一个实现者产出的 baseline。命令证据：全范围 `rg "entry-test-discovery-baseline|minimum_executed"` 只有该“schema v1 至少含”句与引用，无结构化定义。修复建议：像 manifest/receipt 一样冻结 baseline v1 的完整 JSON schema、canonical ordering/multiset identity、额外字段 fail-closed、生成/更新命令与 blob/hash 绑定；T0.0c 双控 producer 与 baseline writer 的真实协议。

### 第四轮总体 verdict

未发现 blocker；仍有 3 major，修复后可进入下一阶段。producer/receipt 主链已无因果环且 CLI 基本闭合，但 checker owner 归属、Q5 摘要和 discovery baseline 协议仍不足以安全派发。


## 第五轮复评（稳定态 `a7840d41`）

复评证据锚：commit `a7840d41` 的只读快照 `/tmp/command-algebra-r5-a7840d41`。prompt checker 84/84、trace、Q1 pre、py_compile 均绿。四轮的 discovery baseline 协议缺口与 design Q5 line 494 旧边界已修；producer/receipt/D2 主链未发现 blocker。

### 仍存事实性发现

[major] `/tmp/command-algebra-r5-a7840d41/exp/inter-block-anchor-allocator/prompt-task-check.py:40-79` — checker 仍只验证 task 集合，不验证 task→phase owner，跨 Commit relocation 可全绿 — 副本 mutation 从 Commit 2 正式表删除 T2.8，并把原定义行插入 Commit 3 的正式“逐 task”表，checker 仍输出 84/84、rc=0；同 Commit 历史表绕法也仍成立。具体错误动作：plan 可把 byte-critical task 排到错误依赖阶段而 checker 仍放行，prompt 则继续按文件名把它交给旧 phase，造成 prompt↔plan owner 漂移；例如 T2.8 在 plan 已移到 C3，执行 agent仍在 C2 实现 raw emitter interface。修复建议：解析时返回 `(task, owner)`，由 task prefix 和固定特例校验 owner：`T1.*→Commit 1`…`T8.*→Commit 8`，`T0.0a/b/c/e→Commit -1`，`T0.0d/f→§0.4f`，`T0.1～T0.11→Commit 0`；prompt marker 同样映射文件 owner并对账。新增“跨 Commit 搬行”和“同 Commit 历史表”正控。

[major] `/tmp/command-algebra-r5-a7840d41/docs/rfc/2026-08-03-generation-emission-command-algebra/cutover-plan.md:493-520,570-598` — baseline 已有完整 schema，但它的 identity/hash 未进入 manifest/receipt 的冻结链，T0.1 无法证明验证的是与 A 同版本、未被替换的 baseline — baseline 内只有 `runner_git_blob`，producer检查 runner blob，却没有 baseline 自身 git blob/hash；manifest 完整 schema也没有 `discovery_baseline` path/hash/blob 字段，receipt 只绑定 validator/manifest。T0.0f 后若工作区 baseline 被替换成另一份同 runner blob、不同 `minimum_executed`/skip allowlist 的 canonical JSON，producer可用它生成自洽 manifest，而 T0.0d/T0.1 从原始 artifacts重算时没有冻结哪份 baseline应当作 oracle。具体错误动作：执行者可意外拿 master/P 工作区或被改写的 baseline，而不是 ENTRY_SHA=A 中版本化 baseline，门仍可能全绿；这重新削弱 `MIN_TESTS` 独立来源。修复建议：producer必须从 `$TREE`/`ENTRY_SHA` 读取 baseline并校验其 git blob；manifest v1加入 baseline repo path、git blob和sha256，validator从 `ENTRY_SHA:path` 独立读取/验 hash后再对账，receipt经 manifest hash间接绑定；加 mutation“保持 runner blob不变，只降低 baseline minimum_executed/扩大 skip allowlist”必须红。

### 第五轮总体 verdict

未发现 blocker；仍有 2 major，修复后可进入下一阶段。Q5 跨层与 D2 范围已一致，baseline schema本身无需现场发明，但 baseline provenance 尚未闭合；checker 仍不能裁决 task owner 漂移。


## 第六轮复评（稳定态 `92cacf65`）

复评证据锚：commit `92cacf65` 的只读快照 `/tmp/command-algebra-r6-92cacf65`。prompt checker 84/84、wrong-phase none、trace、Q1 pre、py_compile 均绿；跨 Commit 搬 T2.8 正确报 wrong owner，搬到 §12 正确报 orphan。五轮的 baseline provenance 缺口已由 manifest/receipt/C11/EV26～28 闭合。

### 仍存事实性发现

[major] `/tmp/command-algebra-r6-92cacf65/docs/rfc/2026-08-03-generation-emission-command-algebra/cutover-plan.md:538-539,615` — 新增 C11 后，receipt 原子写入门和稳定退出码仍只覆盖 C1～C10 — §0.4f 明写 validator“只在 C1～C10 全部通过后”写 receipt，T0.0d task 同样写“C1～C10 全绿后”写 receipt；退出码表只将 rc=7 归 C9～C10，没有给 C11 稳定 rc。与此同时 `:642` 明确 C11 才验证 ENTRY_SHA 中 baseline path/hash/runner blob。具体错误动作：实现者可按字面在 C11 前写出 green receipt，随后 C11 失败却留下完整 receipt；或为 C11 自选退出码，违反冻结 CLI contract。T0.1 看到的 receipt 因而可能来自未通过 baseline trust gate 的验证。修复建议：所有两处改为 C1～C11；冻结 C11 的稳定退出码（可扩 rc=7 到 C9～C11或另设码）；明确任一 C1～C11 失败不得留下旧/新 receipt，并加 EV26～28 后断言 receipt 不存在。

[major] `/tmp/command-algebra-r6-92cacf65/exp/inter-block-anchor-allocator/prompt-task-check.py:40-84` — wrong-phase 已修，但“同一 live Commit 下历史逐 task 表”仍可冒充正式定义 — 副本 mutation 从 Commit 2 正式表删除 T2.8，在同一 `## Commit 2` 末尾增加 `### 历史逐 task 表` 并原样保留该行，checker 仍 84/84、wrong-phase none、rc=0。跨 Commit 搬行会正确红，§12 历史表也会正确红，但此形态仍满足同一个 owner。具体错误动作：task 已从实际施工表撤下，却因同 phase 的废案/历史表保留而继续被 prompt 合法执行。修复建议：每个 Commit 只接受恰一个标题**精确等于** `### 逐 task`（或该 commit 冻结的精确标题）的定义表，遇到第二个含“逐 task”的标题直接 parse failure；加入该同-Commit mutation。

### 第六轮总体 verdict

未发现 blocker；仍有 2 major，修复后可进入下一阶段。baseline provenance 与跨 phase owner 已闭合，但 C11 尚未进入 receipt 原子门，checker 仍把同 Commit 历史表当 live 定义源。


## 第七轮复评（稳定态 `0f5dc40c`）

复评证据锚：commit `0f5dc40c` 的只读快照 `/tmp/command-algebra-r7-0f5dc40c`。机械基线 prompt checker 84/84、wrong-phase none、trace、Q1 pre、py_compile 均绿；跨 Commit T2.8 relocation 正确报 invalid plan owner/prompt mismatch。六轮两项均未完全闭合。

### 仍存事实性发现

[major] `/tmp/command-algebra-r7-0f5dc40c/docs/rfc/2026-08-03-generation-emission-command-algebra/cutover-plan.md:615` — T0.0d task 的 producer contract 仍写“validator C1～C10 全绿后原子写 receipt”，与同文 `:538-539` 的 C1～C11 原子门冲突 — C11 正是 baseline trust gate；执行者若按 task 行施工可在 C11 前写出 green receipt。退出码总表虽已覆盖 C11，task 的具体实现指令仍漏它。修复建议：`:615` 改为 C1～C11，并用全文零命中确认不存在其他“C1～C10 后写 receipt”措辞；EV26～28 还应断言失败时 receipt 不存在。

[major] `/tmp/command-algebra-r7-0f5dc40c/exp/inter-block-anchor-allocator/prompt-task-check.py:40-84,88-118` — ID-prefix 双 owner 只能抓跨 Commit relocation，仍抓不到同一 Commit 的历史逐-task表冒充正式定义 — 复跑六轮副本：从 Commit 2 正式表删除 T2.8，在同一 `## Commit 2` 下新增 `### 历史逐 task 表` 并保留原行；新版 checker 仍 84/84、wrong-phase none、rc=0，因为父 owner 与 ID owner 都是 C2。具体错误动作：已从正式施工表撤掉的 task 仍可因同 phase 废案表而被 prompt 执行。修复建议：除双 owner 外，再要求每个 live Commit **恰一个标题精确匹配**的定义表；任何第二个含“逐 task”的三级标题直接 parse failure。把该同-Commit mutation纳入 checker 正控，不能用跨 Commit mutation替代。

### 第七轮总体 verdict

未发现 blocker；仍有 2 major，修复后可进入下一阶段。baseline trust/exit 总表与跨 phase owner 已修，但 T0.0d task 行仍漏 C11，同 Commit 历史表 false-green 仍在。


## 第八轮最终复评（稳定态 `ff3a0ae0`）

复评证据锚：commit `ff3a0ae0` 的只读快照 `/tmp/command-algebra-r8-ff3a0ae0`。机械基线 prompt checker 84/84、wrong-phase none、trace、Q1 pre、py_compile 均绿。

首轮至七轮遗留的 blocker/major 已逐项复核闭合：

- receipt 只在 C1～C11 全部通过后原子写入；退出码覆盖 C11；T0.0d task 行与 post prompt 均按十一行契约执行。
- checker 只认精确 live heading，父 phase 与 task-id canonical owner 双重对账。同 Commit“历史逐 task 表”mutation 报 orphan；跨 Commit T2.8 mutation同时报 invalid plan owner 与 wrong prompt owner。
- baseline path/raw hash/runner blob 已贯穿 manifest、receipt、C11 与 EV26～28；producer/receipt/Q5/D2 契约保持一致。

### 第八轮总体 verdict

未发现 blocker 或 major；可进入下一阶段。Blocker 0，Major 0。剩余风险仅是执行期须按冻结 mutation/false-red controls 实跑，不属于本轮 instruction-text 契约缺陷。
