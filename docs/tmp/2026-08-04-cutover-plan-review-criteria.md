# Cutover Plan 对抗评审：判据证伪视角

- **评审范围**：`cutover-plan.md` Commit 0～8 的 task 红／绿预测、commit invariant、锚点、Commit 4 原子发布，以及 §11 五条待裁项；对照冻结 RFC `design.md`、`traceability.md` 与 `traceability-check.py`。
- **裁判轴**：长远正确 + 完整；同时检查 false-green 与 false-red。
- **报告状态**：评审完成；发现已按验证顺序逐条追加。

## 事实性发现

### [blocker] `cutover-plan.md:75,107-118` — T0.6 要求把预期失败测试提交进 Commit 0，但共同门又要求同一测试档全绿，Commit 0 终态不可满足

- **问题**：T0.6 明写“这条测试在 Commit 0 就是红的，而且必须一直红到 Commit 4”，Commit 0 的门又把它列为 R-3 C0 段；但同一 commit invariant 要求 `unit it http` 确定性全绿。冻结 RFC §7.1 同样要求每个 commit 结束全绿。除非 characterization 被放在默认发现矩阵之外、或“红”指测试内部成功复现缺陷但测试进程为绿，否则当前文字要求一个被默认全套发现的红测试与全绿同时成立。计划没有冻结二者中哪一种形状。
- **false-red / 半坏态**：若照字面把失败断言提交进默认测试路径，正确的 legacy Commit 0 必然被共同门误红；若执行者为保全绿而跳过／排除它，则 R-3 辅助门在 Commit 0 可被假绿。
- **证据命令与输出**：运行 `rg -n 'T0\.6|旧边界.*稳定为红|unit it http.*全绿|每个commit结束都必须满足' docs/rfc/.../{cutover-plan,design}.md`；输出命中 `cutover-plan.md:75`（必须红到 C4）、`:118`（全套绿）与 `design.md:536`（每 commit 全套绿）。
- **修复建议**：由 `gpt-souls:planner` 重写 T0.6 的 oracle 形状并冻结退出语义。推荐把它写成**绿的 characterization test**：断言“旧缺陷被稳定观察到”，因此测试本身 `rc=0`；Commit 4 再替换为相反的正确性断言。若确需红测试作证据，则只能作为单独的预提交探针保存原始失败输出，不能进入 Commit 0 默认发现集，并须另设门证明该探针被实际运行且确因目标机制失败。

### [blocker] `cutover-plan.md:238,293,378` — T3.3／T4.6 把三个独立覆盖轴写成 `5 sites × 3 kinds × 4 scenarios` 笛卡尔积，正确接线也无法通过

- **问题**：五个现存 `beginLeg` lexical sites 不是每个都可承载三种 leg kind。源码中三处调用字面量固定为 `primary`，另两处分别固定为 `recovery` 与 `continuation`；source scenario 也受各控制流限制。要求“逐格写数据流断言”若按 60 个组合解释，会要求在 primary-only site 驱动 recovery／continuation 等不可达组合。冻结 RFC §9.3 只冻结三个轴各自的人口口径与 hedge winner 归类，未规定全部笛卡尔积均可达。
- **false-red**：正确实现保留五个词法位置及其固定职责时，绝大多数格天然不可达；执行者只能伪造测试入口、把 `N/A` 冒充断言，或错误扩宽 production site，三种做法都会削弱门。该歧义也污染 T4.6 与 O-1 门。
- **证据命令与输出**：运行 Python AST 级别前的逐调用枚举及 `rg -n 'beginLeg\('`，master 得到 `[(877, primary), (1018, primary), (1105, primary), (1519, recovery), (1577, continuation)]`，feature 得到 `[(885, primary), (1014, primary), (1102, primary), (1521, recovery), (1579, continuation)]`；逐段读取确认这些是不同控制流。
- **修复建议**：由 `gpt-souls:planner` 把判据改成**关系覆盖表**而非笛卡尔积：每个 lexical site 必须列其可达 leg kinds／source scenarios，所有 5 sites 至少一条正向 witness，三种 kind 与四种 scenario 的全集均至少被一个适用 site 覆盖；不适用格须具名 `N/A` 并给控制流证据。另加 mutation：删掉每个 site 的接线分别使其专属生产路径转红。

### [major] `cutover-plan.md:435` — T5.1 的“有界 accumulator”没有数值／策略 oracle，“无界增长 mutation”无法判定红绿

- **问题**：T5.1 只说 accumulator “bounded／有界”，未冻结上限、溢出策略、保留语义或测试输入长度。一个普通 `Array.push` 在任何有限测试运行里都是有限值；所谓“无界增长 mutation”不会自动产生可观察失败。实现者可写任意大 cap、只在测试样本之后截断，门仍绿；也可能因 cap 太小丢失 RFC 要求的完整 per-command records。
- **false-green**：移除 cap 后，在有限 N 个 command 的测试中长度仍恰为 N，测试无法区分有界与无界。**false-red**：若测试自行假定 cap，却没有 RFC 规定的容量与 overflow contract，正确但不同的 bounded 实现会误红。
- **证据命令与输出**：运行 `rg -n 'bounded|上限|cap|最多|accumulator' ...`；仅命中 `cutover-plan.md:435` 的“有界／无界增长 mutation”及 RFC `design.md:386` 的性质声明，没有 accumulator 上限或 overflow 行为。
- **修复建议**：在 Q1／Commit 5 设计里冻结可执行性质：例如按 command family × phase × outcome 做 bounded aggregation，同时 History detail 以独立有界 ring／spill 保存完整记录；或明确 `MAX_COMMAND_RECORDS`、达到上限后的 `droppedCount`／truncated marker、首尾保留规则。测试须驱动 `cap-1/cap/cap+1/多倍 cap`，mutation 移除截断或 marker 后才应红，并给低流量正确样本防 false-red。

### [major] `cutover-plan.md:489` — T6.5 声称删掉 adversarial seam 会被 coverage gate 咬住，但计划没有定义该 gate

- **问题**：T6.5 的 mutation 是“把测试改走合法 owner，或删掉 adversarial seam”，预期“coverage gate 必须红”；现有 plan／RFC 只命名 `tests/pipeline/allocation-outside-owner-control.it.test.ts`，没有给出测试枚举 manifest、独立 sentinel、mutation score 或任何能检测“整条测试被删除”的机制。默认 test runner 对删掉一条测试会绿，因此预测会落空。
- **false-green**：执行者删除该文件／test case，`bun run test:backend` 只是少跑一条并继续绿；T6.1 的 production AST population 也看不见 test-only seam。
- **证据命令与输出**：运行 `rg -n 'coverage gate|allocation-outside-owner-control|adversarial seam|第四类|四类' ...`；命中 RFC R-10 与 plan T0.8／T6.5 的自然语言要求，但没有 coverage gate 的实现或命令。
- **修复建议**：在 Commit 0 先冻结 test-oracle manifest（测试文件 + runtime 枚举出的 test name + adversarial seam symbol identity），Commit 6 的独立架构测试断言三者仍存在并实际运行；正控在副本中删除该 test 或把它改走 owner，要求 manifest／行为双门分别因目标机制转红。不要只用源码 grep 测试名。

### [major] `cutover-plan.md:530` — Commit 7 的“production 零改动”只检查 `src/`，会漏 `packages/` 与其他 production 载体

- **问题**：T7.3 只断言 `git diff -- src/` 为空，但本 RFC 自己把 production 代码分布在 `packages/telemetry/**`，Commit 5 也会改该目录。Commit 7 若误改 `packages/`、`config.schema.json`、runtime scripts 或其他生产构建输入，门仍绿，却违反 RFC §7.10“不改 production”。
- **false-green**：在 Commit 7 修改 `packages/telemetry/src/request-telemetry.ts`，该命令仍输出空。
- **证据命令与输出**：运行 `rg -n 'git diff -- src|production 零改动|不改 production' ...`；唯一机械命令是 `cutover-plan.md:530 git diff -- src/`，而同文 `:447-453` 明列 `packages/telemetry` 为实现面。
- **修复建议**：由 planner 冻结 production manifest／path set，至少覆盖 `src/`、`packages/`、production scripts/config/build metadata；以 `git diff <C6>..<C7> -- <manifest>` 为门。更稳妥的是按构建图生成 production file set，并给正控：在 `packages/telemetry` 加一字节必须红；合法 tests／fixtures／docs 清理仍绿。

### [major] `cutover-plan.md:297` — T4.10 只变异 owner 内部 balancing，不能证明 20+3 个旧 terminal 调用点全部接入；RFC 要求的逐 handler mutation 在 plan 中丢失

- **问题**：冻结 RFC §5.3 明确要求“逐 handler 恢复旧 write mutation 必须红”，并单列 3 个 `[DONE]` 任一站点恢复 handler write 必须红。Plan T4.10 却只要求一个“`terminate` 跳过 active anchor balancing” mutation。这个 mutation 能证明 owner 内部 balance，但不能证明每个 handler 已从旧 write 迁入 owner，更不能覆盖无 anchor 的 CC／Responses／Gemini terminal。A 集静态归零只能证明旧 symbol 未出现，不能证明某站点没有漏发 terminal 或改用等价 direct transport。
- **false-green**：遗漏一个 handler 的 `terminate` 接线，同时把旧调用删除；A 集归零绿，balance mutation 仍红，其他 route 全套若未覆盖该分支也绿。
- **证据命令与输出**：运行 `rg -n 'T4\.10|逐handler|恢复handler|20个|3个.*DONE' ...`；RFC `design.md:459,466` 要求任一／逐 handler 恢复旧 write mutation，plan `cutover-plan.md:297` 仅保留 balancing mutation。
- **修复建议**：恢复 RFC 的逐站点可判别门：冻结 20 synthetic terminal + 3 `[DONE]` + normal／WS post-owner 的 site manifest，每个 site 至少有 production-route witness；对每个站点分别删除 command 接线或恢复其旧 write，要求专属 witness 转红。静态 A 集归零继续保留，但不得替代行为 mutation。

### [minor] `cutover-plan.md:175` — T2.4 的“自死锁当场炸”没有超时／进度 oracle，错误实现可能直接挂死测试进程而非给出可判定红

- **问题**：非可重入 serializer 在持锁状态再次 enqueue 的典型错误表现是 promise 永不 settle，不是同步 throw；“确认它当场炸”未规定 deterministic timeout、队列探针或错误类型。
- **false-green / 不可判定**：测试若没有等待内部 promise，可悄悄绿；若直接 await，会挂到全局 timeout，无法区分目标自锁与环境慢。
- **证据命令与输出**：运行 `rg -n 'T2\.4|已持锁|再入队|timeout|超时|死锁' ...`；仅命中 `cutover-plan.md:175`，没有专用超时或进度断言。
- **修复建议**：用 FakeClock／可控 barrier 暂停在 serializer callback 内，触发 internal primitive，断言它同步走 non-enqueue path 并完成；mutation 改为 public enqueue 后，以短、确定性的测试级 deadline + queue-state probe 断言目标 callback 未前进。不要依赖全套测试的默认超时。

### [blocker] `cutover-plan.md:202-205,648-652`／`traceability.md:35` — 待裁项 #5 已被正文实质自裁，且机械 trace 门对此假绿

- **问题**：§11 #5 声称“实施者不可自判”，但 Commit 2 正文已经断言矩阵 C1 与计划 C2“**这不是错配**”，并据此保留 `R-5 | C1` 的门标签。其理由“Commit 1 与 Commit 2 行为等价，所以归属可不一致”改变了 traceability 的语义：矩阵 §0 将“归属 commit”定义为门在哪个 commit 生效，矩阵 R-5 行也明确写 C1；plan 的 T2.3 则到 C2 才实现，故 C1 终态并不存在该辅助门。行为等价不能让尚未实现的门追溯生效。
- **false-green**：`traceability-check.py` 只检查 production 硬门不早于依赖能力，不校验辅助门 task 实际 commit；因此这处 C1/C2 漂移照样 `OK`。执行者会在 C1 ledger 勾一个不存在的门，或者在 C2 重复勾选。
- **证据命令与输出**：运行 `python3 exp/inter-block-anchor-allocator/traceability-check.py` 得 `14 R rows, 9 O rows, 5 deferred` 与 `OK`；读取 `traceability.md:35` 得 R-5 `C1 辅助门`，读取 plan `:202-205` 得 T2.3 在 Commit 2 且正文断言“不是错配”，`:648-652` 又称其待裁。
- **修复建议**：在用户／主会话裁决前，正文不得声称“不是错配”，只能标 `UNRESOLVED`，且 C1 的门不可被视为已满足。裁决后统一 RFC、matrix、plan 三处；校验器新增“每个归属段必须至少由该 commit 的 task 实现”的结构检查，并做 C1→C2 双向 mutation。修复方应为 `gpt-souls:planner`；若需要重裁冻结 RFC，再由 `gpt-souls:architect-advisor` 更新契约。

### [major] `cutover-plan.md:490,596-608` — 待裁项 #1 的选项后果与 RFC 完成判定冲突，错误暗示“辅助门不阻断”

- **问题**：plan 两处写“若裁为辅助门，import guard 失去阻断力”。冻结 RFC §10.4 与 plan 自己 §10 明写：**辅助类型／遥测门失败同样阻止交付**，只是通过不升级 behavior 等级。因此“辅助门”并不等于 non-blocking；选项 2 的所谓代价是虚构的，选项 3“通过条件变严”也不成立——两者都必须通过，差别只在它能否贡献 behavior／production closure 等级。
- **影响**：虽然 plan 没直接替用户选 1/2/3，但它用错误后果塑造裁决，可能诱导用户把 C6 升为 production 硬门来获得一个它本来就有的阻断效果。
- **证据命令与输出**：读取 `cutover-plan.md:490,605-606` 得“辅助门失去阻断力／production 硬门通过条件变严”；同文件 `:580` 与 `design.md:779` 均写“辅助类型／遥测门失败同样阻止交付”。
- **修复建议**：重写三个选项的真实差异：所有方案失败都阻断交付；待裁的是 C1/C6 两段的**证据等级与可声称范围**，不是是否 gate。为每个候选明确它允许声称“presence ratchet”还是“production boundary closure”，避免以不存在的阻断差异代用户裁决。

### [blocker] `cutover-plan.md:70` — T0.1 在同一 task 内同时要求从待测命令取 `MIN_TESTS`、又禁止同源取值；入场门按现有步骤必然自我认证

- **问题**：T0.1 先指示“跑一次 `unit+it+http` 取真实用例数，再把它作为 `MIN_TESTS`”，紧接着又要求 `MIN_TESTS` 必须来自“你即将运行的那条命令之外”。前者正是后者禁止的同源取值。脚本与 HANDOVER 已明确给出反例：selector 若静默缩窄，先测出的数也会同步变小，15 次都与自己一致。
- **false-green**：把测试发现面从 6845 缩到 6800，先跑缩窄命令得到 6800，再设 `MIN_TESTS=6800`，所有重复运行仍绿；因此 RFC §7.1 的“完整集合以 entry 实测枚举为准”没有被验证。Plan 虽诚实限制可声称范围，却仍把该 rc=0 当作 cutover 入场条件，无法咬住“缺测试文件／选择器缩窄”。
- **证据命令与输出**：读取 `baseline-runs.sh:23-31,56-69`，脚本逐字写该同源方案会假绿，并要求 JUnit testsuite names 对磁盘 glob；读取 `HANDOVER.md:129-136`，T3-b 仍“未实施”；`cutover-plan.md:70` 仍给出被证伪步骤。
- **修复建议**：T0.1 不得在 T3-b 落地前充当 RFC §7.1 入场门。先实现独立 test-discovery oracle：磁盘枚举 `*.{unit,it,http}.test.ts` 与每次运行 JUnit 的 runtime suite/file identity 集合双向相等，且对“删 selector 中一个文件但补另一个保持总数”做 mutation；已知正确全集为绿。`MIN_TESTS` 只作次级 sanity，不再承载完整性。修复方应为 `gpt-souls:planner`，脚本实现由 `gpt-souls:implementer`。

### [major] `traceability-check.py:87-99,149-159` — “双向 trace 差集为空”的机械门只做了单向子集检查，矩阵可引用不存在 task、也可凭空新增 acceptance ID 而仍绿

- **问题**：校验器只检查 RFC IDs 缺失于矩阵、以及 plan task 缺失于 matrix；它不检查 matrix 中是否有 RFC 不存在的 R/O ID，也不检查 matrix 引用的 task 是否存在于 plan。与 `traceability.md:145-149` 声称“两个方向的差集都必须为空”不符。
- **false-green 实测**：在 `/tmp` 副本中把 R-14 的 task cell 加入不存在的 `T9.9`，校验仍输出 `14 R rows ... OK`、`rc=0`；另在矩阵增加 RFC 不存在的 `R-99`，仍输出 `15 R rows ... OK`、`rc=0`。这会允许错误归属／幽灵判据通过。
- **证据命令与输出**：命令用 `MATRIX=/tmp/... PLAN=/tmp/... DESIGN=<真实RFC> python3 exp/.../traceability-check.py` 分别注入两种 mutation；结果如上，两次均 `rc=0`。真实文档运行也为 `OK`，但该绿不证明双向完整。
- **修复建议**：校验四个差集并全部要求为空：`RFC_R == matrix_R`、`RFC_O == matrix_O`、`plan_T == matrix_T`，而不是各自一个方向；同时拒绝 matrix task cell 中无法按 `T<n>.<m>` 解析或不在 plan 的 ID。把上述两条 mutation 加入 §7 正控，并加正确两段式归属的 false-red 对照。修复方为 `gpt-souls:implementer`，随后由 reviewer 复评。

### [major] `cutover-plan.md:237` — T3.2 的红预测是“先臆造一个 enum 看它不匹配”，不是能稳定区分错误 taxonomy 的 mutation

- **问题**：计划没有定义“错误 enum”具体错在哪一项、由哪个独立 oracle 比较，也没有冻结 HTTP／WS／terminal 三来源的 expected hit set。随手臆造的 enum 可能碰巧与当前 renderer 一致，也可能因为命名差异而红但实际 effect coverage 完整；这两种都不能证明 taxonomy 判据有鉴别力。
- **false-green**：漏掉一个只在 WS 或 terminal fixture 可达的 effect，而“错误 enum”恰好只针对 HTTP，unit 仍绿。**false-red**：合法地用不同 canonical family 名聚合多个 wire event，文本 enum 比较会误红。
- **证据命令与输出**：运行 `rg -n 'T3\.2|Responses output-item|effect taxonomy|臆造|真实 renderer|真实 client oracle' ...`；RFC `design.md:301,726` 只冻结推导来源，不给枚举；plan `:237` 的唯一负控是未具名的“臆造一个 event 枚举”。
- **修复建议**：先从三个独立来源枚举 runtime-observed event/effect hit set，并为每项记录 canonical family 与依据；negative controls 分别删除 HTTP-only、WS-only、terminal-only 各一项，要求对应真实入口红；false-red 对照允许多个 wire event 映射同一 frozen effect family。最终比集合及映射，不比名称文本。

## 逐 commit／task 红绿预测覆盖结论

以下“未找到反例”只表示本轮从现有代码与冻结 RFC **没有构造出 plan-level 反例**，不表示未来实现的 mutation 已实跑。RFC §11.2 也明确当前没有目标架构 production witness。

| Commit | 本轮逐 task 结论 |
|---|---|
| C0 | T0.1、T0.6 有 blocker；T0.2～T0.5、T0.7～T0.9 的正／负方向未找到计划期反例。T0.4 的 observer 接入与 T0.3 的真实 handle recorder 明确避免了零命中自证。 |
| C1 | T1.1～T1.7 未找到计划期反例；compile fixture 同时含 common-green、indexed-negative、退化大接口 mutation 与 union 收窄 false-red 对照。 |
| C2 | T2.4 的死锁负控不可判定，为 minor；T2.1～T2.3、T2.5～T2.9 未找到计划期反例。 |
| C3 | T3.2 的 taxonomy 负控为 major；T3.3 的 60 格笛卡尔积为 blocker；T3.1、T3.4～T3.7 未找到计划期反例，其中 T3.5 是调查停门而非测试。 |
| C4 | T4.6 继承 T3.3 blocker；T4.10 丢失逐 handler mutation，为 major；T4.1～T4.5、T4.7～T4.9、T4.11～T4.16 未找到额外计划期反例。T4.1 是人工停门，T4.15 是迁移清单／guard 裁决，不应伪装成单一红测试。 |
| C5 | T5.1 “bounded” 无 oracle，为 major；T5.2～T5.7 未找到计划期反例。Q1 未裁前全节停门成立。 |
| C6 | T6.5 删除 adversarial seam 的 coverage gate 不存在，为 major；T6.1～T6.4、T6.6～T6.7 未找到额外计划期反例。 |
| C7 | T7.3 只扫 `src/`，为 major；T7.1／T7.2 是证据审计／清理任务，不是 red-first 测试，未找到其他反例。 |
| C8 | T8.1～T8.7 主要是 doc reconciliation／人工裁决／merged-state review，不存在可声称“已实跑”的红绿预测；未发现它们提前发布 runtime authority。 |

## 必查命题的核验结果

### Commit invariant 与原子发布

- **存在半坏态 blocker**：C0 的 T0.6 红测试与共同全绿门互斥，见 finding 1。
- **C1～C3**：正文均要求旧 A／B／C／D population 与 C0 机械相等、无 live call-site 切换、属性存在性快照相等；未发现 shadow authorization／timer／send 被允许。
- **C4**：plan `:270-395` 是唯一 authority publish；所有 T4 task 明确同一 semantic commit 内完成。全计划检索 `legacy_adapted`／`payload-guessing`／new-command fallback，命中均为禁止或历史旧 fallback inventory，未发现正文在别处允许部分发布。
- **C5～C8**：均要求 C4 的 A／B／C／D 终态持续成立；但 C7 的 production 零改动门漏 `packages/`，见 finding 5。
- **caller remap 风险**：当前两树仍有 `anchor.remap(..., 1)`、`continuation.remap(..., continuationOffset)` 与 `wireDeliveredBlocks` 算术；计划只允许它们在 C4 与 mapping commands 同时归零，没有在准备 commit 提前发布。T4.6 明写恢复 caller arithmetic 必须红；本轮未发现把该迁移拆到别的 commit。

### 锚点表复算

- `git diff --quiet 854421d4..2c339784 -- src` 返回 0，feature `2c339784` 的 `src/` 与 RFC 基线一致。
- master `closeAnchorViaOwner` 为 0 命中；feature 为 14 命中。feature 其中 terminal mode 10 调用、before-real 2 调用，另 2 为 helper 定义／封装，符合 plan 的集合边界。
- master 的 `closeAnchorIfOpen` terminal 调用为 10；feature 的 terminal `closeAnchorViaOwner` 调用也为 10。
- 逐行读取并复核了计划列出的 master／feature：5 个 `beginLeg`、10 个 terminal-close 决策、9 个 route-level sink creation 加 1 个 Anthropic outer helper、raw SSE／WS physical send、C 集 lookup、type declarations、telemetry anchors。所列行均命中声称的符号；未复现用户提到的旧错树／错行。
- master 锚点快照仍有效：`c259dd9d` 是当前 HEAD `174cc314` 的祖先，`git diff c259dd9d..HEAD -- src packages` 为 0 个文件。

### §11 五条待裁项逐条核验

| # | 结论 |
|---|---|
| 1 R-6 等级 | **未直接选方案，但裁决材料错误**：把 auxiliary 说成不阻断，与 RFC §10.4 冲突，见 finding 9。 |
| 2 Q1 | **未自裁**。`PHASE=pre q1-locations.sh` 实跑 rc=0，8 个 RFC section 与 2 个 carrier 均保持 open／destination 状态。 |
| 3 §4.8 与选项 A | **未自裁**。正文把两种读法保留到 Q1，并要求裁决后 §4.8 从 `mentions` 变 `ruled`。 |
| 4 entry tree | **未自裁**。虽推荐候选 4，但 T0.1 明确在裁决前不可开工；不过 T0.1 自身 oracle 有 blocker，见 finding 10。 |
| 5 R-5 C1/C2 | **已被正文实质自裁**。正文先说“不是错配”并按 C1 记账，末尾又称待裁，见 finding 8。 |

## 机械校验与证据

- `python3 exp/inter-block-anchor-allocator/traceability-check.py`：真实文档输出 `14 R rows, 9 O rows, 5 deferred`、`OK`、rc=0。该绿有 finding 11 所述盲区。
- 对 `/tmp` 副本做两条正控：矩阵引用不存在 `T9.9`，以及新增 RFC 不存在的 `R-99`；两次校验均错误返回 rc=0。
- `PHASE=pre exp/inter-block-anchor-allocator/q1-locations.sh`：8 个 RFC section + 2 carriers 全部 `ok`，rc=0。
- `bun` 读取 `package.json`：`test:backend` 等于 `bun scripts/parallel-test.ts unit it http`，与共同门命令一致。
- 未运行 typecheck／backend suite：本轮评的是尚未实施的 plan，且当前共享工作树已有与本评审无关的并发改动；现有套件绿也无法裁决本文发现的计划判据问题。

## 结构怪味扫描

- `cutover-plan.md:7,68-303` — **SSOT 声明与实际重复相冲突**：开头称测试细节只在 RFC §10.2，但逐 task 表复制了大量 mutation／false-red 细节，已经出现 T4.10 从 RFC 漏掉“逐 handler mutation”的漂移。**处置：本轮必须修**；plan 应只引用 machine-readable acceptance row，task 只补施工顺序与路径，不复制判据。
- `traceability-check.py:87-159` — **非对称集合校验**：注释与矩阵声称双向，代码只校验两个单向子集。**处置：本轮必须修**，见 finding 11。
- `cutover-plan.md:293`／`design.md:456,640` — **三个覆盖轴被压成笛卡尔积**：把 population completeness 与组合可达性混为一谈。**处置：本轮必须修**，见 finding 2。

## 主观建议

[建议] `cutover-plan.md`／`traceability.md` — 把 R/O/task 归属、等级、正控、false-red 对照与适用组合收敛为一个结构化 manifest，再生成 Markdown 视图 — 预期影响：消除“plan 声称不复制却实际复制”的漂移，并让集合差、适用矩阵和 mutation coverage 可机械验证 — 推荐用现有语言生态的 Markdown AST／schema validator，不继续扩写手工 `split("|")` parser。

[建议] 实施期 mutation — 当前多数 mutation 仍是计划预测 — 预期影响：避免“mutation 没生效”与“测试没咬住”混淆 — 每条 mutation 应在隔离 worktree 先保存 exact patch，验证 patch 确实改变 production symbol／branch，再核对失败来自目标机制；恢复用反向 exact patch。

## 最佳方案反思

1. **更好的项目内替代方案**：与其继续修补 prose tables，最好复用 T0.7 的 TypeScript checker 输出与 test runtime JUnit，生成 symbol population、task manifest、适用关系和 execution ledger；Markdown 仅作为派生展示。
2. **判据判别力**：本轮主动做了 trace validator 的正控，证明两个 false-green；其余未来实现 mutation 尚不可实跑，因此报告没有把“读起来合理”升级为“已验证会红”。
3. **成熟第三方方案**：Markdown 表解析应使用 mdast／remark 一类成熟 parser；TypeScript symbol closure 继续用 compiler API，而不是 regex。第三方不能替代 production behavior oracle，但能消除转义 pipe、表格列错位与手工解析盲区。

## 总体 verdict

- **Verdict：存在 blocker，不可进入执行阶段。**
- **Blocker：4。Major：7。Minor：1。Nit：0。**
- 必须先修：T0.1 entry 完整性门、T0.6 红／绿终态冲突、T3.3／T4.6 不可达笛卡尔积、R-5 C1/C2 自裁与 trace 归属；随后修 7 条 major 并复评。

---

# 复评轮：整改 `80a4b6fc..363e81c0`

- **复评范围**：上一轮 12 条发现、9 个整改提交、`6ce493e5` 校验器修复，以及 M1 合入后受影响的 terminal／traceability／锚点相邻契约。
- **状态**：复评完成；发现已按验证顺序追加。

## 复评事实性发现

### [blocker] `cutover-plan.md:156,592` — T0.11 冻结“seam 依赖的 production symbol identity”，T6.5 又要求它仍存在，但正确的 C4/C6 正会迁移／删除这些 legacy symbols

- **问题**：现有 adversarial seam `tests/pipeline/allocation-outside-owner-control.it.test.ts` 直接依赖 `OwnerRawSink`、`createDownstreamDeliverySession`、`WireBlockAllocationPort`／allocation port。T0.11 在 C0 冻结“该 seam 依赖的 production symbol identity”；T6.5 第 ③ 项要求该 identity 到 C6 仍存在。可是同一 plan 的 T6.2／T6.4 明确删除 `OwnerRawSink` raw production export、`WireBlockAllocationPort` 与 exported `createDownstreamDeliverySession`／旧 lookup；T4.15 还会把 raw tests 迁到 test-only entrypoint。正确迁移必然改变这组 production identities，因此 manifest 门会 false-red。
- **证据命令与输出**：读取 seam `tests/pipeline/allocation-outside-owner-control.it.test.ts:20,31,55-57`，确认直接 import／持有上述 legacy production symbols；读取 plan `:589-606`，确认 C6 删除同一组 definitions／exports；`rg -n 'OwnerRawSink|createDownstreamDeliverySession|WireBlockAllocationPort'` 命中该 seam。
- **修复建议**：manifest 第 ③ 项应冻结**行为能力与测试入口的迁移关系**，而非要求旧 production symbol identity 恒存：C0 记录当前 identity；C4 同步记录其 test-only replacement；C6 门要求“每个旧 identity 要么仍存在且仅 test 可达，要么有具名 replacement，且 adversarial 行为 witness 仍能造分裂”。正控分别删除 replacement mapping、删 test、把 seam 合法化；false-red 对照允许 legacy export 按计划退役。

### [blocker] `cutover-plan.md:283-287,714,756-768` — #5 的触发点“可达”但到达过晚：若裁 T2.3 应属于 C1，C1 已经提交

- **问题**：Commit 2 门表确实保证流程会看到 #5，修复了“永不触发”；但候选 ② 是把 T2.3 前移到 Commit 1。执行者按 plan 到达 Commit 2 门时，Commit 1 semantic commit 已完成并通过其 invariant。此时才裁“应在 C1”，只能改写已经落盘的 C1／重排历史，或接受 C1 终态缺门。Plan 没有授权／说明前者，也不能用后者冒充归属成立。触发点可达不等于在分叉前可达。
- **false-green／半坏态**：按当前矩阵，C1 ledger 可继续把 R-5 辅助段记作 C1；实际 T2.3 尚不存在。`traceability-check.py` 不判辅助段 task 的 commit，因此仍绿。
- **证据命令与输出**：读取 plan Commit 1 `:229-239`，其门表无 #5；Commit 2 `:279-287` 才触发；#5 候选 `:766` 包含“把 T2.3 前移到 Commit 1”。真实 `traceability-check.py` 仍输出 `OK`。
- **修复建议**：把 #5 触发点前移到 **Commit 1 kickoff／收口前**。未裁则 C1 不得收口，因为候选集合包含改变 C1 内容的方案。裁后同步 RFC／matrix／plan，再进入 T1.x；Commit 2 只复核裁决被贯彻，不承担首次裁决。

### [blocker] `cutover-plan.md:19,213,257,322,368,770-783` — #6 把两个不同论域误称为“同一件事”，且 Commit 4 触发晚于 T1/T2 的结构冻结

- **问题一，事实框架不准**：`OwnerTerminalDecision` 并非只处理 terminal 时刻。当前生产调用把 `classifyOwnerFailure` 用于 `beginLeg`、`write-block-frame`、`close-anchor-before-real` 等任意 owner command 失败；它决定 request settlement。`TerminalEmissionResult` 则是 `terminate` command 的结果，表达 terminal frame 是否 emitted／suppressed、segments 与 socket close intent。两者在 lifecycle reason 上相邻，但不是同一判别函数的两个名字。候选 ①“Result 取代 Decision”会丢掉非-terminal command failure 的 caller action；候选 ③“合并成一个三态”也未覆盖两个正交轴。
- **问题二，触发过晚**：T1.6 已冻结 `TerminalEmissionResult` 类型，T2.7 已实现 terminate/finalize 状态机，T3.5 又产出映射；到 Commit 4 前才裁，候选若要求取代／合并就必须重写 C1～C3。门虽可达，却不在设计分叉前。
- **证据命令与输出**：`rg -n 'classifyOwnerFailure|OwnerTerminalDecision' src tests` 显示 `driver.ts:933-934,1060` 与多处 begin-leg failure 使用；`owner-failure.ts:11-45` 的三态是 caller action，`settleMessagesOwnerFailure.ts:12-23` 直接 settle；plan T1.6 `:213`、T2.7 `:257` 已先实现新 result，C4 前置停门在 `:368`。
- **修复建议**：由 architect-advisor 先重框问题为两个轴：`OwnerCommandFailureDisposition`（任意 command failure → caller action）与 `TerminalEmissionResult`（terminate effect/result）。补第四候选：二者保留正交职责，只有 terminate-failure 的单一映射桥，且用 exhaustive mapping／顺序 test 防双 settle。裁决触发点前移到 **Commit 1 kickoff**；未裁不得写 T1.6。

### [blocker] `cutover-plan.md:151,191,196`／`traceability.md:33`／`design.md:597,750` — T0.6 本身已可满足，但冻结 RFC 与矩阵仍要求“red characterization”，三份 SSOT 冲突

- **结论先行**：rc=0 的 characterization 形状本身成立，没有把矛盾挪到测试内部。当前 session 的 generic `write` 只更新 ledger／clocks（`delivery/session.ts:127-137`），owner close 才清 `openAnchorIndex`（`:417-430`）；可先用 owner 开 anchor，再经 generic write 发同 index stop，断言 wire ledger closed 且 `openAnchorIndex` 仍有值。反写“lease 已清”会因目标机制红；测试仍在默认发现集且 rc=0。
- **新 blocker**：plan 已把 C0 终态改为“characterization 绿”，但冻结 RFC §7.3 仍写“稳定作为 red characterization”，§10.2 R-3 仍写“Commit 0 只冻结……red characterization”；矩阵 R-3 行仍标“旧缺陷 characterization，红”。执行者被要求以 RFC 为契约 SSOT，却又被 plan 要求相反退出语义。该同步不能等 Commit 8，因为 Commit 0 当场要决定 gate 是红还是绿。
- **证据命令与输出**：`rg -n 'red characterization|characterization.*红|绿=缺陷在' design.md traceability.md cutover-plan.md` 命中上述三处相反状态；当前 traceability checker 仍 `OK`，因为它不比较描述语义。
- **修复建议**：实施前同步 RFC §7.3／§10.2 与矩阵 R-3 为“rc=0 的 defect-present characterization；C4 反转 assertion”，并明确“red”只可修饰被观察到的产品状态，不能修饰测试退出码。把三处一致性列入 checker／T8.7，但首次修复必须现在完成。

### [major] `traceability-check.py:155-165` — 修复仍只识别纯数字 task ID，新引入的 T4.0a～d 完全不受双向校验

- **问题**：整改新增 `T4.0a`～`T4.0d` 并在矩阵 §6 映射，但 checker regex 仍是 `\bT\d+\.\d+\b`。它把这些 token 截成同一个 `T4.0`，既无法区分 a/b/c/d，也无法发现悬空 `T4.0z` 或丢失三项。
- **false-green 实测**：在 `/tmp` 矩阵副本把 `T4.0d` 改成不存在的 `T4.0z`，checker `OK`、rc=0；再把 `T4.0a／b／c／z` 缩成只剩 `T4.0a`，仍 `OK`、rc=0。普通 `T9.9` 悬空变异现已正确 rc=1，说明旧 major 只修了一半。
- **证据命令与输出**：上述两次 `MATRIX=/tmp/... PLAN=/tmp/... DESIGN=/tmp/... python3 .../traceability-check.py` 均输出 `traceability-check: OK`；代码 `:155-156` 的 regex 不接受 suffix。
- **修复建议**：定义统一 task grammar，例如 `T\d+\.\d+[a-z]?`，plan／matrix 两侧都按完整 token 比集合；加入 `T4.0d→T4.0z`、删除 b/c/d 两条正控，以及合法 `T4.0a-d` false-red 对照。另补 matrix IDs 的反向集合检查；新增 `R-99` 仍会 rc=0（上一轮 major 的另一半尚未修）。

### [blocker] `cutover-plan.md:146` — T0.1 的 JUnit 集合不是 15 次实际 `parallel-test` 运行的集合，sharding 层漏文件仍可全绿

- **问题**：步骤 ② 引用 `scripts/parallel-test.ts:64`，但该 JUnit 只存在于 `refreshTimings(files)`：它在 `--update` 时用一次**单独的** `bun test --reporter=junit ...files` 运行。真正的入场命令在 `:120` 把 buckets 分别以普通 `bun test` 启动，不产 JUnit。于是磁盘集合与“一次 refresh JUnit”相等，只能证明 `discover()` 当时完整；证明不了随后 `balance()`／bucket spawn／15 次 baseline run 没静默漏 shard／漏 file。Plan 的正控恰写“让某个 shard 静默少跑文件”，但现有取证通道看不见这个层。
- **false-green**：保持 `discover()` 和 refresh JUnit 完整，在 `balance()` 后从某 bucket 删除一个文件；步骤 ①～③仍集合相等，15 次实际运行均少跑该文件，`MIN_TESTS` 若仍高于 floor 或同步取自一次缩窄 run 也可绿。
- **证据命令与输出**：读取 `scripts/parallel-test.ts:61-83`，JUnit 仅用于 refresh；`:119-127` 的真实 shards 无 reporter；`:165-169` 最终只聚合总数。用真实 Bun probe确认 JUnit `<testsuite file=...>` 可提供文件 identity，但当前 runner 没把它绑定到每次 gate run。
- **修复建议**：让**每一次** `baseline-runs.sh` 调用的实际 shards 各自产 JUnit，并在 runner 内合并 file identity；每次都与独立磁盘 manifest 双向比较，缺一文件立即 rc≠0。正控必须打在 `balance()` 后／spawn 前删一文件并红；false-red 对照覆盖 fully skipped／native skip 文件——实测 Bun JUnit 仍为它们输出 file-level testsuite，可合法视为“被发现”，但 verdict 要另记录 skipped。

### [major] `cutover-plan.md:538` — T5.1 同时承诺 accumulator 截断和 History 保存完整 per-command records，却没有独立数据腿保证二者可同时成立

- **问题**：整改把 telemetry accumulator 冻结为 `MAX_COMMAND_RECORDS` + truncation／dropped marker，同时引用 Q4 方案 B 声称完整 per-command records 进入 generation operation detail。若 History detail 在 settle 时从这个 bounded accumulator 读取，`cap+1` 后的 records 已丢，无法“完整”；若另有独立完整 source，则 plan 没有冻结 owner、写入时点、失败语义或双腿一致性。当前四档测试只要求 truncation 可见，不要求 History 在 `cap+1`／多倍 cap 下仍完整，因此会假绿。
- **证据命令与输出**：`rg -n 'MAX_COMMAND_RECORDS|droppedCount|truncated|cap\+1' design.md traceability.md cutover-plan.md` 只命中 plan T5.1；RFC §4.7／Q4 仍要求每个 command observation／完整 per-command records，没有 truncation 例外。
- **修复建议**：裁决前明确双腿：bounded telemetry projection 只保存可加聚合与 drop diagnostics；History detail 从独立 append-only request record source 取得完整 records。测试在 `cap+1`／多倍 cap 同时断言 telemetry 有界且 History command IDs／顺序／错误链完整；mutation 让 History 复用 truncated telemetry buffer 必须红。若决定 History 也可截断，属于 Q4 已裁契约变更，需回用户重裁。

### [major] `cutover-plan.md:146` — T0.1 未定义 `MIN_TESTS` 是否含 skipped，现有 JUnit 与 `parallel-test` 的计数口径相反，会 false-red

- **问题**：步骤 ④ 说把“该次运行的用例数”冻成 `MIN_TESTS`。Bun JUnit 的 `<testsuites tests=N>` **包含 skipped／todo**；`parallel-test.ts:148-167` 明确把最终 `tests` 定义为 `passSum + failSum`，不含 skipped。仓库当前 backend 档存在整文件 `describe.skip`、native `skipIf` 与 `test.todo`。若从 JUnit 总数取 floor，15 次 baseline 的自报数必然更小，正确状态也过不了；若取 pass+fail，又没有写明从哪个字段独立取得。
- **实测证据**：对 `tests/routes/messages/postcommit-truncation-shaping.it.test.ts` 跑 Bun JUnit，输出 `tests=7, skipped=7, rc=0`；该文件被磁盘 glob 纳入。对 todo 文件输出 `tests=16, skipped=1`。而 runner 源码 `:148-167` 只加 pass／fail。
- **修复建议**：冻结同一口径。推荐文件完整性由 file set 判；`MIN_TESTS` 只比较 **executed = tests - skipped**，并让 baseline runner显式输出 executed／skipped 两数。正确样本须含 fully skipped、native-unavailable skip、todo 文件；mutation 把 runnable case 变 skip 必须红或进入具名允许清单，不能悄悄降低 executed floor。

### [major] `cutover-plan.md:633-644` — T7.3 把整个 `scripts/` 当 production，合法测试清理的派生产物会误红

- **问题**：整改把 production manifest 至少覆盖整个 `scripts/`。该目录混有 production/ops 脚本，也有纯测试基建与派生性能提示：`parallel-test.ts`、`test-timings.json`、`update-circular-deps-baseline.ts`。Commit 7 的目标正是删 tests／fixtures；若同步移除 `test-timings.json` 中已删文件或重冻测试架构 baseline，这是合法测试审计，却会被“scripts 全空 diff”误判为 production 改动。false-red 对照只豁免 `tests/`／fixtures／`docs/`，没有豁免这类位于 scripts 的 test artifacts。
- **证据命令与输出**：列出 `scripts/`，读取 `parallel-test.ts:23` 明写 timings 是“perf hint, not correctness”；`update-circular-deps-baseline.ts:17-19` 只操作 tests architecture baseline。
- **修复建议**：manifest 按**运行时构建／发布可达性**生成，不按顶层目录一刀切。将 scripts 分类为 production／ops／test tooling／generated test artifacts；C7 只禁止 production 类变化。给两向对照：改 `recover-history-v3-projections.ts` 应红；删 fixture 后同步 `test-timings.json` 应绿且需单独 review。

### [minor] `cutover-plan.md:254` — 上轮 T2.4 的自死锁 oracle 未整改，仍可能挂死或假绿

- **问题**：文字仍只有“在已持锁时再入队，确认它当场炸”，没有 deterministic barrier、专用 deadline、queue-state probe 或错误类型。若 nested enqueue 返回 pending promise，直接 await 会挂到全局 timeout；若测试不 await，则可绿。
- **证据命令与输出**：`rg -n 'T2\.4|已持锁|再入队|deadline|barrier|queue-state' cutover-plan.md` 仍只命中 T2.4 原句。
- **修复建议**：沿用上轮建议：可控 barrier 停在 serializer callback 内，mutation 改走 public enqueue，以短 deadline + queue progress 断言目标自锁；正确 internal primitive 同步完成。

### [major] `design.md:5,46` — M1 合入后冻结 RFC 仍声称代码在未合并 feature 分支，entry／权威基线与 plan 相反

- **问题**：plan 已整体删除两棵树口径，但冻结 RFC 顶部仍写设计基线是 `.worktrees/anchor-alloc`／`feat/inter-block-anchor-allocator`，§1.3 仍写“M1 保留在 feature 上，本次在该基线上重塑”。执行入口已裁为合并后 master，且 feature 内容已经 merge。新执行者按“RFC 契约唯一事实源”会从错误树取 inventory／line anchors。
- **证据命令与输出**：`rg -n 'feat/inter-block|worktrees/anchor-alloc|M1已落实现保留' design.md` 命中 `:5,46`；git log 显示 merge `8125f123` 已在 master。
- **修复建议**：执行前同步 RFC 的 current-state header 与 §1.3，保留 `854421d4` 仅作历史 inventory snapshot，并明确当前 entry 是 `8125f123` 之后的隔离 worktree。此类当前状态不能推迟到 Commit 8。

## 复评逐条处置与相邻契约结论

### 上轮发现处置

| 上轮 finding | 复评结论 |
|---|---|
| T0.6 红测试 vs 全绿 | **实现形状已修，但跨文档未闭合**：rc=0 characterization 可满足；RFC／matrix 仍写 red，转为本轮 blocker。 |
| T3.3／T4.6 60 格笛卡尔积 | **已修**：关系覆盖表 + 逐 site mutation，五个 site 的 kind 行号复算一致；未发现新 false-red。 |
| T5.1 bounded 无 oracle | **部分修复并引入新 major**：cap 四档可判，但 bounded telemetry 与完整 History 的数据腿未闭合。 |
| T6.5 coverage gate 不存在 | **门已具名，但引入 blocker**：production symbol identity 恒存与 C6 删除契约冲突。 |
| T7.3 只扫 `src/` | **漏 `packages/` 已修，但引入 major**：整个 `scripts/` 被误当 production，合法测试派生产物会 false-red。 |
| T4.10 缺逐 handler mutation | **已修**：site manifest + 逐 site 行为 mutation + owner balancing mutation，未发现新 blocker。 |
| T2.4 自死锁不可判 | **未修，minor 保留**。 |
| #5 自裁／触发不可达 | **撤回自裁，但触发仍过晚，blocker**。 |
| R-6 “辅助门不阻断” | **plan 措辞已修、裁决已落**；RFC 分段同步仍排到 T8，执行前应对齐，但主要问题被 T0.6／stale RFC findings 覆盖。 |
| T0.1 MIN_TESTS 自认证 | **思路改善但实际 15 次运行仍无 file identity，且 skipped 计数口径未定**：blocker + major。 |
| traceability 单向校验 | **普通 task 悬空已修；suffix task 与 extra R/O 仍假绿，major**。 |
| T3.2 taxonomy mutation 不稳定 | **已修**：HTTP／WS／terminal 三来源 hit set、逐来源 deletion mutation 与聚合 false-red 对照。 |

### 重点问题回答

1. **新门的 false-red**：T3.3 关系覆盖表未发现 false-red；T0.1 会因 skipped 计数口径冲突 false-red，且实际 shards 漏文件仍 false-green；T0.11 会因正确删除 legacy production symbols false-red；T7.3 会误杀合法 test-tooling 派生产物。
2. **T0.6**：rc=0 characterization 在当前代码结构上可满足，不是挪矛盾；真正未闭合的是 RFC／matrix 仍要求 red characterization。
3. **#6**：当前框法不成立。`OwnerTerminalDecision` 是任意 owner-command failure 的 caller disposition，`TerminalEmissionResult` 是 terminate effect/result；应按正交轴重框，且触发点必须前移到 Commit 1。
4. **其他未决**：见本轮 5 blocker／5 major／1 minor；因此仍不可进入执行。

### 机械与实测证据

- `traceability-check.py`：真实文档 rc=0；不存在 `T9.9` 已 rc=1。新变异 `T4.0d→T4.0z` 与删掉 b/c/d 均错误 rc=0；新增 `R-99` 仍错误 rc=0。
- Bun JUnit 实测：普通文件输出 file-level `<testsuite>`；整文件 `describe.skip` 输出 `tests=7 skipped=7 rc=0`；todo 文件输出 `tests=16 skipped=1`。
- Q1 `PHASE=pre`：8 RFC sections + 2 carriers 均符合 open 状态，rc=0。
- 合并态关键锚点复算：`closeAnchorViaOwner` 全 `src` 14 命中，其中 terminal 10、before-real 2；`beginLeg` 五点为 3 primary + recovery + continuation；`writeAnchor` declaration 仅在 `delivery/types.ts:13`，不在 `ClientSink`。计划关键重锚与当前 HEAD `363e81c0` 一致，未发现新的错行；但 RFC 顶部仍保留旧 feature-tree 当前状态，见 major。
- `git diff 8125f123..80a4b6fc -- src packages` 为空；`80a4b6fc..HEAD` 的 `src packages` 也为空，锚点代码快照未漂。

## 复评结构怪味扫描

- `cutover-plan.md:538` — **双源数据流未画清**：bounded telemetry 与完整 History 同时承诺，但未指定独立 owner／source。处置：本轮必须修，见 major。
- `cutover-plan.md:702-783` — **触发点晚于分叉**：#5／#6 虽“必经”，但到达时相关早期 commit 已冻结。处置：本轮必须前移。
- `traceability-check.py:155-165` — **ID grammar 漂移**：plan 新增 suffix task，checker 仍按旧 grammar。处置：本轮必须修。

## 复评总体 verdict

- **Verdict：存在 blocker，不可进入执行阶段。**
- **本轮新增／仍成立：blocker 5、major 5、minor 1。**
- **最先修复顺序**：①把 #5／#6 触发前移并重框 #6；②让 T0.1 的实际每次 shards 产 file identity 并统一 skipped 口径；③修 T0.11 的 identity migration；④同步 T0.6 与当前 master 状态到 RFC／matrix；⑤补 checker suffix／extra-ID 双向门。

---

# 第三轮复评：整改 `2745cb8d..0c03a4b4`

- **复评范围**：第二轮 5 blocker／5 major／1 minor、作者整改、协调者的 `aee088d7`／`4a35e745`／`93e300d3`，以及相邻 RFC／runner／manifest 契约。
- **状态**：复评完成；发现已按验证顺序追加。

## 第三轮事实性发现

### [major] `cutover-plan.md:229,474,674` — “或有具名 replacement”仍是可自证豁免：未要求 replacement 被 seam 使用、语义等价或仅 test 可达

- **问题**：T4.15 只要求“为每个旧 identity 登记 test-only replacement”，T6.5 的机械条件却退化为“有具名 replacement”。没有判据证明：replacement 实际被对应 adversarial test import／调用；它仍能提供同一旧边界能力；它只从 test entrypoint 可达；一个 replacement 没被多个不相干 old identities 随意复用。实现者可在表里填任意现存 test helper，③ 立即绿。行为门只能证明**某条** seam 还能造分裂，不能证明 manifest 中每个 old→new 迁移关系真实。
- **证据命令与输出**：`rg -n '迁移关系|replacement|仅 test 可达|T4\.15' cutover-plan.md`；T6.5 第一分支明确要求 old identity “仅 test 可达”，第二分支只要求“有具名 replacement”，约束不对称。三条 mutation 也只有“删映射”，没有“映射到错误／未使用／production-reachable replacement”。
- **修复建议**：把“或”改成具名且可验证的 disposition union：`retained_test_only` 必须 AST 证明仅 test import；`replaced` 必须冻结 old→replacement 一对一／具名多对一理由，AST 证明 adversarial test 实际调用 replacement、production 零可达，行为 mutation 在该 replacement 上打回合法 owner 时转红。正控新增“映射到未使用 helper”和“replacement 从 production barrel export”，两者必须红；合法 replacement 绿。

### [withdrawn] `cutover-plan.md:219` — 原结论越过项目允许 native 缺产物时 skip 的裁决；证据并入后续 skip-identity finding

- **问题**：plan 正确识别 native artifact 在主树、fresh worktree 缺失，却错误推出“同一 commit 两处 tests 数不同，executed 才稳定”。恰恰相反：native 可用时 18 条执行，缺 artifact 时同 18 条 skipped，因此 `executed = tests - skipped` 相差 18。若从主树冻结 floor，隔离树正确状态 false-red；若从隔离树冻结 floor，native suite 在 entry gate 根本没执行，仍可绿。文件集合只证明发现了这 4 个文件，不证明其真实 native behavior 被运行。
- **实测证据**：`isNativeHistorySearchAvailable()` 在主树为 true，artifact `native/history-search/copilot_history_search.node` 存在且被 `.gitignore`；对四个 gated files 跑 JUnit 得 `tests=18, skipped=0, executed=18`。源码注释明确 fresh worktree artifact 缺失，故同 18 条将 skip，executed=0。
- **修复建议**：entry gate 必须采用项目既定 `test:ci` 语义或在隔离 worktree 先 `bun run build:history-search`，确保 native suite 真跑；否则只能把 native 测试单列为环境性 `NOT-RUN`，不得宣称完整 backend entry。冻结 floor 必须在**最终 entry worktree 环境**取得，并按文件分层记录 executed/skipped；对 native 四文件要求 skipped=0。正控删除 artifact 后必须红，不能只降低 executed floor。

### [major] `cutover-plan.md:137-155,262` — RFC 已由 `93e300d3` 澄清，但 plan 仍断言“仍是相反要求／未改则不得开工”，制造永久 false-red 停门

- **问题**：协调者已在 RFC §7.3／§10.2 明确 red=缺陷状态、测试 rc=0；矩阵也已同步。但 plan §0.4b 的状态表仍写 RFC “仍是相反要求”，处置表仍要求未来修改，C0 门仍写“未改则不得开工——design 与 plan 相反”。正确当前状态会被这道文字门判为未满足，或者执行者重复修改已正确的 frozen RFC。
- **证据命令与输出**：`design.md:597,750` 已含 rc=0 forcing argument；`traceability.md:33` 已写 rc=0；同一 plan `:143,153,262` 仍宣称相反。
- **修复建议**：把 §0.4b 改成“已裁并同步”的 closed record，C0 门改为机械核对三份文本均包含 `rc=0 + C4反转`，而非未改停门。保留 forcing argument 作为依据。

### [minor] `design.md:597` — red forcing argument 结论成立，但“只剩这一种读法”应限定为 commit 终态测试集

- **结论**：协调者的核心推理站得住。RFC §7.1 要求每 commit 终态默认 suite 确定性全绿；T0.6 又必须进入默认发现集、不得 skip/todo，因此“提交一个持续失败的测试”确实不可能。rc=0 defect-present characterization，C4 反转断言，是同时满足两句的唯一**终态测试形状**。
- **限定**：§7.1 同时要求 production mutation 红，说明它允许在提交前／隔离副本运行非零探针；所以不能泛化成“任何红测试/命令都不允许存在”。RFC 当前措辞把结论限定到“该测试自身”，实质无误；建议把“只剩这一种读法”补成“对进入 Commit 0 默认 suite 的 T0.6 而言”，避免与 mutation red probes 表面冲突。
- **证据命令与输出**：`design.md:536` 同时写全套绿与 production mutation 红；`:597` 写“该测试退出 0”。两者分别属于终态 suite 与正控探针。

### [major] `cutover-plan.md:165-185` — production manifest 仍漏根级生产／构建输入，Commit 7 可改 `bun.lock`、`tsdown.config.ts`、启动脚本而保持绿

- **问题**：MANIFEST 只列 `src/ packages/ config.schema.json package.json tsconfig.json bunfig.toml` 与部分 scripts。仓库根还有影响安装、构建或启动的 `bun.lock`、`tsdown.config.ts`、`start.bat`、`config.example.yaml`，以及 lint/build config。Commit 7 改依赖锁或打包入口，pathspec 门仍空，却违反“不改 production”。“新增 scripts 必须显式归类”也没有机械检测。
- **证据命令与输出**：`find . -maxdepth 1 -type f` 列出上述文件；MANIFEST `:177-180` 不含它们。
- **修复建议**：不用手工 allowlist 猜 production 面。冻结“允许 C7 改动”的窄 allowlist（tests／fixtures／docs／明确 test artifacts），然后断言 `<C6>..<C7>` 的**所有其他 tracked paths**为空；这对未来新增根文件／scripts 默认 fail-closed。false-red 对照逐项列合法 test artifacts。

### [blocker] `cutover-plan.md:219` — 同 run file-set 修复了漏 shard，但 `executed` floor 仍可被“先变 skip、再冻结较低 floor”自我认证

- **问题**：每次实际 shards 产 JUnit、逐次与磁盘 file set 比较，确实把证据绑到了 15 次真实运行，修掉了上一轮“另一次 refresh 替本次背书”。但 file identity 不区分 runnable 与 skipped：把一个 runnable case／suite 改成 `skip`，文件仍在 JUnit file set；若在预跑取 floor 前已发生，`executed` 随之降低，随后冻结较低 `MIN_TESTS`，15 次全自洽。原先 count 自认证只是从“漏文件”搬到了“跳过测试”。
- **native 18 条的准确裁决**：主树实测 native 四文件 `tests=18, skipped=0`；fresh worktree 会 `skipped=18`，所以“executed 才稳定”是错的。但本项目明确允许 backend 档在无 native artifact 时显式 skip，且 gate 绑定最终 `$TREE`，因此**不会因主树数不同而 false-red**，也不能据此强制 build native。真正缺的是按环境冻结／审核 skip identity。
- **证据命令与输出**：Bun JUnit 对 fully skipped 文件仍输出同一 file-level testsuite；主树 native probe为 `18 executed / 0 skipped`；`.node` 被 gitignore、fresh worktree 缺失。Plan 只要求另记 skipped 数，没有比较 expected skipped test-name set。
- **修复建议**：在最终 entry worktree 上，以项目允许的 skip policy 冻结 **skipped test identity set**（native 缺产物的 18 条 + 已裁 todo／gated 项分别 disposition），15 次每次同时要求 file set 相等、skipped identity set 相等、executed count 相等。正控把一个普通 runnable case 改 skip，必须报出新增 skipped name；合法 native 18 skip 绿。`baseline-runs.sh` 也须明确解析 runner 的 `executed` 字段，而不是当前任意 `[0-9]+ tests`。

> **更正上一条 native finding**：上一条把“fresh worktree 必须构建 native”定为 blocker，越过了本项目明确允许 backend 档无产物时 skip 的裁决；该结论撤回，不计入本轮数量。保留的 blocker 是上面“skip identity 自认证”这一条。

## 第三轮逐条处置

| 第二轮 finding | 第三轮结论 |
|---|---|
| T0.11 identity 恒存 false-red | **部分修复但形成新 major**：迁移槽解决恒存；“有具名 replacement”缺语义／接线／可达性验证，仍是逃生舱。 |
| #5 触发过晚 | **已修**：首次裁决前移到 C1 kickoff，C2 仅复核。 |
| #6 论域误框＋触发过晚 | **已修**：重框为正交轴、四候选、architect-advisor 先提案，触发到 C1 kickoff。 |
| T0.6 RFC／matrix 冲突 | **RFC 与 matrix 已正确澄清**；forcing argument 成立。Plan 状态表未更新，留下 major false-red。 |
| checker suffix／extra ID | **已修且变异实测通过**：`T4.0d→z` 与 `R-99` 都因目标机制 rc=1。 |
| T0.1 actual-run file identity | **方向已修**：明确每次真实 shard 产 JUnit、每次双向比 file set，正控打在 balance 后。仍有 blocker：skip identity 可自认证。 |
| T0.1 skipped 口径 | **计数公式明确，但“executed 稳定”事实错误**；主树／worktree差异本身按项目裁决可接受，必须冻结 allowed skipped identities。 |
| T5.1 双数据腿 | **已修**：两独立 owner/source、两条 mutation、cap 四档同时验 telemetry 有界与 History 完整。 |
| T7.3 scripts false-red | **原问题已修**：逐文件分类；但手工 production allowlist 仍漏根级构建输入，major。 |
| T2.4 deadlock | **已修**：barrier + deterministic deadline + queue-state probe。 |
| stale RFC feature baseline | **已修**（`4a35e745`）。 |

## 第三轮重点问题回答

1. **replacement 的“或”**：目前仍是万能豁免，因只验证名字存在，不验证 seam 实际使用、行为等价及 production 零可达。需改成可机械判别的 disposition union。
2. **T0.1 是否落在 15 次运行**：新文字明确要求每次实际 shards 产 JUnit、每次比集合，已落在 15 次而非 refresh run；但基础设施尚未实现，且 skip identity 仍可自认证，故尚不能开工。
3. **`executed = tests - skipped` 与 native 18**：主树实测多执行 18；fresh worktree会 skip 18，因此数值不稳定。按项目契约 backend 档允许这种 skip，不应强制 native build；应在最终 `$TREE` 冻结并审核允许的 skipped identity set，普通测试新变 skip 必须红。
4. **red forcing argument**：成立，限定于进入 Commit 0 默认 suite 的 T0.6；§7.1 仍允许隔离 mutation probe 非零。RFC 当前实质正确。
5. **未决 blocker／major**：本轮 blocker 1、major 3；另有 minor 1（forcing argument 限定语）。

## 第三轮机械证据

- `traceability-check.py` 真实文档 rc=0；`T4.0d→T4.0z` 同时报 orphan/dangling、rc=1；新增 `R-99` 报 invented acceptance id、rc=1。
- Native probe：主树 `native=true`；四个 gated files JUnit 为 `tests=18, skipped=0`；artifact `.node` 被 gitignore，fresh worktree缺失。
- Bun JUnit 已证 file-level identity 覆盖 fully skipped／todo files；这证明 file discovery 可判，不证明 skip 合法性。
- `git diff --check` 报告无格式错误。

## 第三轮结构怪味扫描

- `cutover-plan.md:229,474,674` — **自证迁移表**：登记 replacement 的人同时判它是否有效，且无外部结构条件。处置：本轮修为 AST＋行为双证据。
- `cutover-plan.md:165-185` — **手工 production allowlist**：未来新增文件默认漏检。处置：改成允许改动的窄 allowlist，其他 tracked path fail-closed。
- `cutover-plan.md:137-155` — **已完成状态未回填**：事实已变，停门仍红。处置：立即收口为 closed record。

## 第三轮总体 verdict

- **Verdict：存在 blocker，不可进入执行阶段。**
- **本轮计数：blocker 1、major 3、minor 1。**
- 修复顺序：①T0.1 冻结并逐次比 skipped identity set；②replacement 加真实接线／test-only reachability 证明；③清理已过期 T0.6 停门；④production 门改为“只允许 test/doc 清单，其他默认红”。

---

# 第四轮复评：整改至 `c1b2e219`

- **复评范围**：第三轮 1 blocker／3 major／1 minor、6 个整改提交、相邻 manifest／runner／RFC 契约及重复块清理。
- **状态**：复评完成；发现已按验证顺序追加。

## 第四轮事实性发现

### [major] `cutover-plan.md:730-734` — replacement 三判据已堵住“只登记名字”，但 `old identity 仍存在且仅 test 可达` 这条 OR 分支仍可绕过 C6 的定义删除

- **已确认改善**：replacement 分支的 (a) runtime 使用、(b) replacement 空壳 mutation、(c) production 零可达三条组合后，无法再靠随便填 helper 名通过；(b) 能抓“无害调用 replacement、实际由别路造分裂”，(c) 能抓 production barrel 泄漏。
- **剩余缝**：OR 的另一臂仍允许“旧 identity 仍存在且仅 test 可达”。对 T6.2／T6.4 点名必须删除的 `OwnerRawSink`、`WireBlockAllocationPort`、exported `createDownstreamDeliverySession`，实现者可保留原 definition/export，只让当前引用来自 tests，便满足 T6.5；但这与 Commit 6“删除 legacy definitions／exports”直接冲突。T6.1 的 A-call／C-resolution population 零不必然咬住一个零 production consumer 的遗留 export。
- **证据命令与输出**：读取 T6.2／T6.4 `cutover-plan.md:727-729`（删除 definitions／exports）与 T6.5 `:730`（old identity 仍存在且仅 test 可达即可）；两条允许集合不一致。
- **修复建议**：按 identity disposition 分类，**被 T6.2／T6.4 删除清单点名的 identity 禁止走 retained 分支，只能 `replaced` 且满足 (a)(b)(c)**；retained_test_only 仅限 RFC 明确保留的 raw-byte／owner-backed test adapter，并须迁到 test-only entrypoint、不从 production barrel export。正控保留一个待删 export 但 production refs=0，门必须红。

### [major] `cutover-plan.md:157-200` — 顶层全集覆盖已闭合，但 UI 子树 production allowlist 漏若干构建输入，正确性门仍可 false-green

- **结论**：顶层换轴有效。独立运行枚举得 38 条，分类表覆盖缺失为 0；§0.4a/b/c 各仅一份，未发现 82 行陈旧副本或悬空旧标题。false-red 侧对 `tests/`、`ui-v4/tests/`、timings 的排除清晰，未发现把合法测试改动误红的新 blocker。
- **局部缺口**：MANIFEST 的 `ui/` 只含 `src/ vite.config.ts tsconfig.json`，漏 production 构建输入 `ui/package.json`、`ui/bun.lock`、`ui/bunfig.toml`、`ui/index.html`；`ui-v4/` 漏 `vitest.config.ts` 属 test config 可合理排除。若 Commit 7 改旧 UI 依赖／入口，门仍绿。顶层覆盖只能证明“ui/ 已表态”，不能证明子树逐文件分类完整。
- **证据命令与输出**：`git ls-files ui` 与 MANIFEST 对比，列出上述 4 个未纳入生产项。
- **修复建议**：补入 `ui/{package.json,bun.lock,bunfig.toml,index.html}`；对宽目录（ui、scripts）采用同样的 tracked-child coverage 检查，确保每个二级条目被 include/exclude 归类。

### [minor] `cutover-plan.md:273-276` — skipped identity set 方向可执行，但需冻结 identity key，避免参数化重名碰撞

- **结论**：逐次从每个实际 shard 的 JUnit 合并 skipped identities，与 entry worktree 冻结集合做相等比较，是可执行且能咬住“一改 skip 一改回”的；native 18 条具名分组与执行时重取也符合项目允许无产物 skip 的裁决。
- **小缝**：计划没定义 identity key。只用 testcase `name` 会在不同 file／describe／参数化实例之间碰撞；用集合而非 multiset 还会吞掉同 key 重复项。仓库有大量 `test.each`／`describe.each`，Bun JUnit 也会生成 `(unnamed)` skipped testcase。
- **证据命令与输出**：`rg 'test.each|describe.each' tests` 多处命中；前轮 JUnit probe 的 fully skipped outer suite含 `(unnamed)`。
- **修复建议**：冻结 canonical identity 为 `(normalized file, full classname path, testcase name, parameterized ordinal/line)` 的 multiset，XML decode 后比较；同名重复要保留 multiplicity。正控造两个同名 case、只切一个 skip，必须红。

## 第四轮逐条处置

| 第三轮 finding | 第四轮结论 |
|---|---|
| replacement 具名逃生舱 | **大部修复，仍有 major**：replacement 的 (a)(b)(c) 足够咬住只登记名字；但 old identity retained-test-only OR 臂仍允许保留 C6 明令删除的 legacy export。 |
| T0.1 skipped 自认证 | **主体已修**：每次实际 shards、file set、skipped identity set 均逐次核对；native 具名重取。仅 identity key 未冻结，minor。 |
| stale T0.6 停门 | **已修**：§0.4c closed record，无旧停门。 |
| production manifest 漏根输入 | **换轴有效，顶层 38/38 覆盖且无重复块**；仍有 major：`ui/` 子树漏 package／lock／bunfig／index。 |
| red forcing 限定语 | **已修**：明确只管 C0 默认 suite，隔离 mutation probe 可非零。 |

## 第四轮重点回答

1. **replacement 三判据**：replacement 分支本身已不易绕；runtime 使用 + 同分裂行为 + production 零可达互补有效。剩余漏洞在 OR 的 retained 臂：对 T6.2/T6.4 必删 identity 不应允许 retained。
2. **manifest false-red**：顶层 tracked 38 条全部有 disposition；`tests/`、`ui-v4/tests/`、timings 的合法改动可绿，未发现扩张造成新的 false-red。发现的是相反方向：旧 `ui/` 四个 production 构建输入漏检。
3. **skipped identity set**：可执行，且已经绑定每次实际 shard；需补 canonical multiset key，避免参数化／同名／`(unnamed)` 碰撞。
4. **未决**：仍有 **major 2、minor 1**；无 blocker。尚不能写“无未决 blocker/major”。

## 第四轮机械证据

- `git ls-files | awk ... | sort -u` 实得 38 个 tracked 顶层条目；与锚 commit `54dbd4f3` 集合一致。分类表覆盖缺失 0。
- §0.4、§0.4a、§0.4b、§0.4c、§0.5 各出现一次；未发现 82 行陈旧副本或悬空旧标题。
- `traceability-check.py` 真实文档 rc=0；`git diff --check` 通过。
- UI 子树枚举显示 `ui/package.json`、`ui/bun.lock`、`ui/bunfig.toml`、`ui/index.html` 未在 MANIFEST。

## 第四轮结构怪味扫描

- `cutover-plan.md:730-734` — **两臂不对称**：replacement 臂三重证明，retained 臂仅“test 可达”。处置：按 identity 删除契约限制可选 disposition。
- `cutover-plan.md:141-200` — **顶层闭合、子树手列**：完整性问题下沉一级复发。处置：宽目录加 child coverage。
- `cutover-plan.md:274` — **identity 未类型化**：自然语言 set 未定义 key／multiplicity。处置：冻结 canonical multiset。

## 第四轮总体 verdict

- **Verdict：修复 major 后可进入执行阶段。**
- **Blocker：0；major：2；minor：1。**
- 需修：①必删 legacy identity 禁止 retained；②补旧 UI 构建输入并做子树 coverage；③定义 skipped identity multiset key。

---

# 第五轮复评：整改至 `b06c6510`

- **复评范围**：第四轮 2 major／1 minor、3 个整改提交、相邻 manifest／replacement／evidence lifecycle 契约。
- **状态**：复评完成；发现已按验证顺序追加。

## 第五轮事实性发现

### [blocker] `cutover-plan.md:229-259` — U-1 的三方互斥没有解开：把 15 份日志提交进“它证明的 infrastructure commit”会改变被证明的 SHA，形成自指死循环

- **问题**：流程先提交 runner 基础设施，得到 SHA A；T0.1 在 A 上跑 15 次并生成日志，日志的 `head=` 都是 A。若再把日志“随前置基础设施那个 commit 一起提交”，只能 amend／重写为 SHA B；此时日志证明的是 A，不是最终 entry B。若另开 evidence commit B，plan 又要求重取 entry=B，需在 B 上重跑并生成新日志，再提交成 C，无限递归。`git add` 后 porcelain 为空的 `/tmp` 探针只证明“提交后能 clean”，没证明 commit identity 仍是日志记录的那个。
- **证据命令与输出**：plan `:229-233` 要“基础设施先提交→重取 entry sha→15 次锚新 sha”；`:251` 又把随后生成的 15 份日志归同一个前置基础设施 commit。Git commit 内容加入日志必改变 tree 与 commit SHA。
- **修复建议**：证据必须落在被测 worktree **之外**的绝对目录（如主树 `docs/tmp/` 或 `/tmp` 持久路径），不参与 `$TREE` clean 判定；entry SHA A 保持不变。任务完成后可由主线单独提交证据/摘要，明确其 `measured_sha=A`，但不得把该 evidence commit 重新定义为 entry。若必须仓内跟踪，使用独立证据分支／commit且冻结被测 SHA，不再递归重取 entry。

### [minor] `cutover-plan.md:143-208` — exclusion 反转的 false-red 方向是可接受的 fail-closed，但排除表更新需要显式裁决记录

- **结论**：反转没有形成 blocker。漏 exclusion 会让合法非-production 改动在相应 commit 收口趟立即红；红是具名 path diff，可定位、不会静默污染后续 commit。将该 path 经 review 分类后加入排除表即可重跑。FR2 新 `ui-v5` 默认红证明未知路径 fail-closed。
- **需要补的操作约束**：当前写“误红一次，加进排除表即可”，但修改排除表等于放宽 correctness gate；按项目 guard 纪律不得由执行者当场自判。否则执行者遇到难解释的 production path 也可称“非 production”并排除。
- **证据命令与输出**：判据命令直接输出 unexpected tracked paths；排除表含逐条理由，但未要求新增 exclusion 有独立 reviewer／用户裁决。T6.7 的 guard 裁决只写“本 commit 删除或放宽”，不明确覆盖 C0～C7 的 manifest exclusion。
- **修复建议**：新增 exclusion 必须落 disposition（path、为何非 production、正反例）并经独立 reviewer／用户裁决；未裁时该 commit 不收口。这样 false-red 可见且可修，不变成随手 bypass。

## 第五轮逐条处置

| 第四轮 finding／相邻项 | 第五轮结论 |
|---|---|
| manifest 子树漏 production | **已修**：tracked 全集减 exclusions 默认 fail-closed；UI 新旧与未来 ui-v5 自动入门。未发现新的 major false-red。 |
| retained-test-only 避难所 | **已修**：T6.2／T6.4 删除清单 identity 只能 replacement；保留待删 identity 的正控会红。未发现不可满足——test-only replacement 已由 (a)(b)(c) 定义。 |
| skipped identity key | **已修**：`file+classname+name+ordinal` multiset，逐次比较；mutation probe 豁免移到共同门附近。 |
| U-1 三方互斥 | **未修且形成 blocker**：把 run logs 提交进其证明的 infrastructure commit 改变 commit SHA，证据失效并递归。 |

## 第五轮重点回答

1. **反转后的假红面**：合法的新非-production path 会在所属 commit 收口趟立即红，diff 具名可见，技术上可通过新增 exclusion 后重跑；不会静默越过。需补独立裁决，避免“加排除即可”成为 bypass，但属 minor。
2. **replacement-only 限定**：对 T6.2/T6.4 明令删除的 identities 是可满足且正确的；它们迁到满足 runtime 使用、同分裂行为、production 零可达的 test-only replacement。删除清单外才可 retained_test_only。
3. **U-1**：未解。日志在 SHA A 上生成后提交会得到 SHA B；日志不再证明 B。另开 evidence commit 同样使 entry 前移并递归。必须把原始证据放被测 worktree 外，冻结 measured SHA。
4. **未决**：blocker 1、major 0、minor 1；因此不能写“无未决 blocker/major”。

## 第五轮机械证据

- 反转命令默认覆盖所有 tracked paths；FR2 新 `ui-v5/src/x.ts` 会红。排除项均具名 pathspec。
- §0.4／a／b／c 各一份；traceability rc=0；`git diff --check` 通过。
- T6.5 已含 retained 限域正控、replacement (a)(b)(c) 与“只登记名字” mutation。
- U-1 的 `/tmp` clean 探针只验证 commit 后工作树干净，未验证日志内 `head` 等于最终 commit；Git content-addressing 推导确定 SHA 必变。

## 第五轮结构怪味扫描

- `cutover-plan.md:229-259` — **证据与被证对象自包含**：把测量结果塞回被测 commit 改变 identity。处置：证据外置、冻结 measured SHA。
- `cutover-plan.md:160,208` — **排除表自评放宽**：误红处置仍由执行者决定。处置：新增 exclusion 独立裁决。

## 第五轮总体 verdict

- **Verdict：存在 blocker，不可进入执行阶段。**
- **Blocker：1；major：0；minor：1。**
- 必修：将 T0.1 原始 logs 放到 `$TREE` 外并固定 `measured_sha`，禁止 evidence commit 反向定义 entry。

---

# 第六轮复评：整改至 `7f354fe3`

- **复评范围**：第五轮 1 blocker／1 minor、2 个整改提交及 evidence identity／temporary exclusion 相邻契约。
- **状态**：复评完成；发现已按验证顺序追加。

## 第六轮事实性发现

### [blocker] `cutover-plan.md:227,248,252,272,306` — “唯独 entry 日志自指”不成立；每个 commit 的收口趟 `head=` 输出同样不能随该 commit 提交

- **问题**：entry 日志不是唯一内容指涉所在 commit SHA 的证据。每个 semantic commit 生成后，收口趟重跑 O-6；输出按 §0.3 明含 `head=<本 commit sha>`，并要求与本 commit 相等。若把这份“各 commit 自己的门输出”再随该 commit 提交／amend，SHA 同样从 A 变 B，输出仍写 A。收口趟还被要求不得引用开发趟结果，因此不能改用不含最终 SHA 的旧输出。T0.10 的建立材料若记录当前 head、各 commit 的 population／invariant evidence 若内嵌 `TO=<sha>`，也属同类；判据应按内容而非“T0.1 特例”分类。
- **证据命令与输出**：plan `:227` 要 commit 后重跑；`:103,111-113` 规定 O-6 输出含 head 并核对当前 commit；`:272` 又允许各 commit 门输出随该 commit 提交。这与已实测的 A→B content-addressing 循环同构。
- **修复建议**：所有**生成于 commit 之后或内容含被测 SHA/tree 状态**的收口证据一律外置，并冻结 `measured_sha=A`；可事后归档到独立 evidence commit，但不得声称“随 A 提交”。仅不含当前 commit identity、在提交前已生成的 mutation／设计记录可随实现 commit。把规则写成内容分类表，并覆盖 T0.10、O-6、population audit、invariant output。

### [blocker] `cutover-plan.md:210-216` — 具名临时 exclusion 可跨整个相位旁路门，且未裁通过前 commit 已收口，无法“未通过则回滚”

- **问题**：流程允许执行者在门调用处加临时豁免，然后继续；只到“相位收口”才批量交裁。若相位包含多个 semantic commits，这些 commits 的 production gate 实际都在豁免 path 后为绿，且已提交／进入下一 commit。末尾 reviewer 拒绝时，“当场回滚”意味着改写多个已完成 commits 或补一个反向 commit；前者 plan 未授权，后者不能让历史 commit 的 invariant 重新成立。临时豁免还没有 TTL、适用 commit、最大范围或“下一 commit 前必须裁”约束，可一路累积成长期旁路。
- **证据命令与输出**：`:214` 允许当场加豁免；`:215` 直到相位收口批量裁；§0.4b `:227` 明确每个 commit 收口后进入下一个 commit，应当当时满足全部 invariant。两套时序冲突。
- **修复建议**：临时豁免只能用于**开发趟诊断**，不得用于收口趟。该 commit 收口前必须由独立 reviewer／用户逐条裁决并正式更新 exclusion；未裁则 commit 不得生成或不得进入下一 commit。每条临时豁免绑定 exact path、单 commit、expiry=本 commit 收口，且收口命令拒绝任何剩余 temporary exclusion。

## 第六轮逐条处置

| 第五轮 finding | 第六轮结论 |
|---|---|
| T0.1 entry logs 自指循环 | **entry 原始日志已正确外置，机械半边与 measured_sha 语义半边闭合**；但“唯独 entry 日志”分类过窄，收口趟 head 输出同构自指，形成新 blocker。 |
| exclusion 自批自加 | **排除表本体只由裁决修改是改进**；但临时豁免可跨相位／多个 commits，收口门可在未裁状态下通过，形成 blocker。 |

## 第六轮重点回答

1. **“只有 entry 日志不行”不严密**：任何 post-commit 生成、内容含本 commit SHA／tree 状态的证据都不能随同一 commit 提交。漏网包括每 commit 收口趟 O-6 `head=` 输出、可能含 `TO` 的 population／invariant 报告；T0.10 建立材料若含当前 SHA 亦同。
2. **临时 exclusion 会退化成长旁路**：当前允许开发趟加豁免并到相位末补票；中间 commit 收口实际未受门约束，拒绝后无法恢复历史 invariant。临时豁免必须 expiry=本 commit 收口，收口趟不允许残留。
3. **未决 blocker/major**：blocker 2、major 0。不能写“无未决 blocker/major”。

## 第六轮机械证据

- `baseline-runs.sh` 的绝对 `OUT` 路径确实不拼 `$REPO`；新命令已改为 `$TREE` 外路径，entry SHA 不因日志生成改变。
- Plan 明确收口趟在 commit 后重跑，并核对 `head=` 等于本 commit；同时仍称各 commit 门输出可随该 commit 提交，构成确定的 A→B 循环。
- Temporary exclusion 只规定“相位收口批量裁”，没有 per-commit expiry 或收口拒绝未裁豁免。
- `git diff --check` 与 traceability checker 均通过；问题是计划时序语义，不是格式／映射。

## 第六轮结构怪味扫描

- `cutover-plan.md:272` — **按文档类型特判而非内容性质分类证据**。处置：按 pre/post-commit 与是否内嵌 SHA 分类。
- `cutover-plan.md:212-216` — **provisional bypass 跨越硬门边界**。处置：开发趟可临时，收口趟必须零临时豁免。

## 第六轮总体 verdict

- **Verdict：存在 blocker，不可进入执行阶段。**
- **Blocker：2；major：0；minor：0。**
- 必修：①所有 post-commit／SHA-bearing 收口证据外置；②temporary exclusion 在每个 commit 收口前裁决，禁止跨 commit／相位累积。

---

# 第七轮复评：整改至 `e7b7f03f`

- **复评范围**：第六轮 2 blocker、2 个整改提交及 self-reference detector／temporary exclusion gate 相邻契约。
- **状态**：复评完成；发现已按验证顺序追加。

## 第七轮事实性发现

### [blocker] `cutover-plan.md:304-314` — 自指 grep 判据既有假阴也有假阳，不能作为“不得靠执行者判断”的机械门

- **假阴**：判据只匹配 full SHA 与 `git rev-parse --short` 的默认长度。自指产物可写 `HEAD`／`本 commit` 符号引用，或使用 7、9、12 位等不同合法缩写，均不命中；大小写 SHA 也不命中。实测当前 HEAD 的 8 位命中，但 `measured HEAD` 与 uppercase SHA 均 CLEAR。若某工具输出 `--short=12`，也会漏。
- **假阳**：产物可合法引用同一 SHA 作为历史／基线事实，而非声称“本产物属于该 commit”；grep 仍命中。实测 `historical <SHORT> unrelated` 被判 SELF。纯字面命中无法判断关系语义。
- **修复建议**：不要扫描任意 prose。要求所有可提交 artifact 使用结构化 frontmatter，显式 `evidence_timing: pre_commit|post_commit`、`measured_sha`、`claims_current_head: true|false`；post_commit 或 claims_current_head=true 一律外置。对工具输出 wrapper 在生成时记录 timing，而非事后猜。若保留文本扫描，只能作为辅助 tripwire：匹配 `HEAD`、`head=`, `TO=`, 7～40 位 SHA prefixes，红后人工 disposition，不可独立裁决。

### [blocker] `cutover-plan.md:221-235` — pending exclusion 文件不是完整 authority；清空／改名／旁路 pathspec 都可让收口假绿

- **问题**：机制只检查一个由执行者按模板设置的 `$PEND`。临时 exclusion 实际加在“门的调用处”，没有要求每次调用只能从 `$PEND` 生成，也没有扫描其他文件／shell variables／手写 pathspec。执行者可把豁免写到另一文件名、直接在命令行追加 exclude、或收口前清空／删除 `$PEND`；`[ -s ]` 即 rc=0，随后所谓“无豁免原样重跑”也没有机械比较命令与 canonical §0.4a。进度文件虽记录理由，但收口不对账它。
- **修复建议**：禁止任意“调用处手写豁免”。开发趟只能通过单一 wrapper 读取固定、commit-slug 与 base SHA 绑定的 ledger；wrapper 记录每次实际 applied exclusions。收口时：①扫描 worktree／进度 ledger，pending 与 applied 集合必须相等；②pending 必须为空且有 adjudication receipts；③对 canonical command 计算 hash／由脚本内部生成 pathspec，拒绝额外 argv exclusions。清空 pending 但保留 applied history 必须红；改名文件／直接 argv exclude 两条 mutation 必须红。

## 第七轮逐条处置

| 第六轮 finding | 第七轮结论 |
|---|---|
| post-commit／SHA-bearing evidence 自指 | **产物外置后循环确实断开**；但用于分类的 grep 机械门不可靠，形成 blocker。 |
| temporary exclusion 跨 commit | **时序已收紧到 commit，收口原样重跑方向正确**；但 `$PEND` 不是应用豁免的 authority，可清空／改名／旁路，形成 blocker。 |

## 第七轮重点回答

1. **自指判据假阴／假阳**：假阴包括 `HEAD`、不同长度 SHA prefix、uppercase；假阳包括合法引用当前 SHA 的历史说明。实测均复现。该 grep 只能辅助，不能机械裁决。
2. **循环是否断开**：是。只要 post-commit evidence 真正写到 `$TREE` 外，运行门不改变 tree／HEAD，porcelain 保持 clean，输出 head 等于当前 HEAD；环在外置处断开。
3. **豁免旁路**：存在。改文件名、直接 argv 追加 exclude、收口前清空／删除 `$PEND` 均可绕；需 wrapper + applied ledger + canonical command hash 三方对账。
4. **未决 blocker/major**：blocker 2、major 0；不能写“无未决 blocker/major”。

## 第七轮机械证据

- 自指 detector 变异：full/default-short 命中；8 位当前恰命中；`HEAD`、uppercase 漏；历史说明含短 SHA 误红。
- `byte-equivalence.sh:133-135` 确实每次输出默认短 SHA；外置该输出不会改变 repo。
- Pending gate 实跑形状只有 `[ -s "$PEND" ]`，空／不存在均放行；没有 applied-exclusion ledger 或命令 hash。
- `git diff --check` 与 traceability 均绿；问题是判据鉴别力。

## 第七轮结构怪味扫描

- `cutover-plan.md:304-314` — **用文本内容猜 provenance**。处置：生成时结构化标注 timing／measured SHA。
- `cutover-plan.md:221-235` — **声明 ledger 与实际 command 分离**。处置：单一 wrapper 同时消费并记录 applied exclusions。

## 第七轮总体 verdict

- **Verdict：存在 blocker，不可进入执行阶段。**
- **Blocker：2；major：0；minor：0。**

---

# 第八轮复评：稳定基线 `d7f6c222` + `c4624139`

- **复评范围**：第七轮 2 blocker、执行方 2 major、结构化 evidence intent、Commit -1、tree-out manifest／master pointer、exclusion wrapper 与 §0.4d 元边界。
- **状态**：复评完成；发现已按验证顺序追加。

## 第八轮事实性发现

### [major] `cutover-plan.md:438-445` — master pointer 被断言为 A 的后代，但计划没有任何步骤让 master 包含隔离分支上的 Commit -1

- **问题**：Commit -1 明确在 `$TREE` 上提交，A 是该隔离执行分支的 HEAD。随后要求在 master 状态线提交 pointer，并断言“pointer commit 是 A 的后代”。若 master 未先 merge／cherry-pick A，master 上的新 pointer commit 与 A 是分叉兄弟，不是后代；若先整合 A，必须明确谁、何时、以何门把 Commit -1 合 master，以及 `$TREE` 后续如何继续，当前流程完全缺失。仅在 pointer 里写 `measured_sha=A` 不会产生 ancestry。
- **失败场景**：执行者直接在 master 提交 pointer，`git merge-base --is-ancestor A <pointer>` 返回 1；文档声称的拓扑为假。若为满足文字临时 merge A，又会改变 master／执行路由并引入未经计划的整合步骤。
- **证据命令与输出**：plan §0.2 固定从 master 建隔离 `$TREE`；§0.4b `:268` 明写基础设施在 `$TREE` 提交；Commit -1 `:438` 取该分支 A；`:442` 却无整合步骤直接断言 master pointer 是 A 后代。
- **修复建议**：二选一并冻结：①pointer 不要求 ancestry，只保存 A 的完整 SHA、manifest hash，并由接手方用 `git cat-file -e A^{commit}` 验证对象存在；或②把 Commit -1 作为共享基础设施先独立合 master，经复评后从新 master **重新创建** execution worktree，A=该 master SHA，再提交 pointer。不得只用散文断言 ancestry。

### [major] `cutover-plan.md:441` — evidence manifest 只列内容，没有冻结对所有脚本产物逐份验证结构化字段与 SHA 一致性的门

- **问题**：脚本本身已正确输出字段；但 topology 要求 manifest 收集 run log 清单／hash，却没有明确机械断言：baseline stdout、每个 run log、O-6 输出都必须恰有合法三字段；所有 `claims_current_head=true`；所有 `measured_sha` 相等且等于 manifest A／生成时 HEAD；timing 与运行趟一致。缺一 log 的字段、混入旧批、或 manifest 手填另一个 A，仍可能有完整-looking hash 清单。`claims_current_head=true` 也可能被误读成 pointer/归档 commit HEAD，因为 manifest 未要求保存 `measured_tree`／producer。
- **实测证据**：baseline 两种 timing stdout + run log 字段一致且 SHA=当前 HEAD；invalid timing rc=2；O-6 invalid timing／nonrepo SHA rc=2。说明**生产方已闭合**，缺的是消费／manifest consistency gate。O-6 真请求 500，正确地未声称 PASS。
- **修复建议**：Commit -1 收口门增加 manifest validator：遍历日志清单及 baseline stdout/O-6 artifact，字段缺失／重复／非法即红；`measured_sha` 全等于 manifest A；`claims_current_head` 仅解释为**producer 生成时的 measured tree HEAD**，manifest 另存 `repo_path`／producer／timing，不与 pointer commit 比；hash 逐文件重算；额外未列文件与清单缺文件均红。正控删除一份 log 字段、篡改一份 SHA、把 A 改成 pointer SHA，均必须红。

## 第八轮逐条处置

| 上轮／执行方 finding | 第八轮结论 |
|---|---|
| 自指 prose grep 假阴／假阳 | **脚本生产方已修**：结构化 intent 真落地，baseline 两 timing stdout＋每 log 实测一致；O-6 字段路径 fail-closed。仍有 major：manifest 消费端未定义逐 artifact consistency validator。 |
| exclusion 改名／清空／argv／跨 commit | **四种绕法在 plan 中均具名覆盖**：wrapper、applied ledger、receipts、canonical hash、收口无豁免重跑；诚实标为纪律＋事后裁决。剩余可伪造性属已登记边界，不继续冒充机械门。 |
| Commit -1 无门表 | **已修**：T0.0a/b/c、逐 mutation、正样本与独立收口门可达；task 81/81、checker rc=0。 |
| measured_sha 落点二难 | **tree-out manifest + master pointer 基本解开自指**；但 pointer 被声称为 A 后代而无 branch integration 步骤，major。 |

## 第八轮重点结论

1. **结构化字段**：invalid timing、非 40 位 SHA 均 rc=2；baseline stdout 与每 log 含同一 40 位 SHA／timing／claims=true。缺标记的 fail-closed 目前只写在 plan，manifest validator 未落任务／门，故仍有 major。
2. **`claims_current_head=true`**：应且只能指 producer 生成时 measured repo 的 HEAD，不是归档／pointer commit HEAD；plan 语义如此，但 manifest 应机械保存 producer/repo/timing 并验证，避免误读。
3. **exclusion bypass**：四种具体绕法均已在设计中对账；由于 wrapper/ledger 由执行者维护，仍可伪造，但 §0.4d 已诚实降为纪律＋独立裁决边界。该剩余项应记为已知边界而非缺陷。
4. **Commit -1**：门表与重锚可达，旧 15 次明确作废；但 Commit -1 是否先合 master／重建 worktree 未冻结，导致 pointer ancestry 断言不成立。
5. **未决**：major 2、blocker 0；尚不能写“无未决 blocker/major”。

## 第八轮机械证据

- Baseline probe：dev/closeout 均 rc=0；stdout 与 run-01.log 三字段一致，SHA=`c4624139…`；invalid timing rc=2。
- O-6：invalid timing rc=2；非 repo 无 full SHA rc=2。未重试真请求，不声称 O-6 PASS。
- Task 集：plan 81、matrix 81、差集空；`traceability-check.py` rc=0。
- `git diff --check` 通过。

## 第八轮结构怪味扫描

- `cutover-plan.md:438-445` — **跨分支 ancestry 靠散文成立**。处置：冻结整合步骤或取消 ancestry 要求。
- `cutover-plan.md:330-332,441` — **producer schema 有，consumer validator 无**。处置：Commit -1 增 manifest validation task／门。

## 第八轮总体 verdict

- **Verdict：修复 major 后可进入执行阶段。**
- **Blocker：0；major：2；minor：0。**

---

# 第八轮稳定态复评：`4425f156`（脚本 `d7f6c222`）

- **复评范围**：第七轮 2 blocker、执行方第六轮 2 major、Commit -1 mutation/evidence validator、用户裁定 git 图与 §0.4d 元边界。
- **状态**：复评完成；发现已按验证顺序追加。

## 第八轮稳定态事实性发现

### [blocker] `cutover-plan.md:431-470` — T0.0d 被放进 Commit -1 自身门，但它的正样本输入只有 Commit -1 合 master、跑完 15 次并提交 pointer 后才存在

- **问题**：T0.0d 列在 Commit -1 的逐 task 表；Commit -1 门表又要求“evidence 消费正控”与“§0.4f validator 绿”才能收口。然而 §0.4f 的触发点明确是 **Commit -1 已合 master、A 已测、pointer P 已提交之后**；其输入包含 A、15 logs、tree-out manifest、P、cutover progress.base。Commit -1 尚未收口／合 master 时，这些对象在因果上不可能存在。门要求用自己的后果验收自己，Commit -1 无法完成。
- **证据命令与输出**：plan `:444` 把 T0.0d 放在 Commit -1；`:453-455` 将 validator mutation／正样本列为本 commit 门；`:470-477` 明确其输入到 merge+15 runs+P 后才出现。
- **修复建议**：拆相位：Commit -1 只交付 validator 实现及**合成 fixture** 的五类 mutation/正样本；这可在合 master 前验收。合 master 得 A、跑 15 次、提交 P 后，另设不可提交的 **Entry Gate E0** 对真实 evidence topology 跑 validator，绿后才从 A 进入 C0。矩阵把 T0.0d 拆为 `T0.0d-impl`（若 grammar 不支持连字符则用 T0.0d）与新 `T0.0e`（真实消费门），各自有可达触发点。

### [major] `cutover-plan.md:441-491` — evidence validator 未验证 15 份 log 的 file/JUnit/skipped hash 都等于 manifest 冻结值，表第 7 行“manifest 内互相一致”没有外部比较对象

- **问题**：manifest 保存 disk manifest hash、runtime identity hash、skipped multiset hash；每份 run log 又应代表一次真实 run。表第 6 行只要求每 log 的“文件集合／executed-skipped verdict 全绿”，第 7 行只说 manifest 三个 hash“与 manifest 内互相一致”。它没有明确从**每份 log/JUnit artifact 重算三类 hash并逐 run 等于 manifest**，也没有把每 run 的 JUnit artifact 列入清单/hash。实现可让 manifest 三个字段自洽，同时某次 run 的 identity/skipped set 漂移；log 只写 `verdict=green` 即通过。
- **修复建议**：manifest 对每个 run 记录 log hash + JUnit artifact hash + 重算的 file identity hash + skipped multiset hash + executed；validator 从实际 artifact 重算，要求 15 次逐项等于 frozen disk/expected skipped hashes。`canonical command` 也须逐 run 等于 manifest。正控修改一份 JUnit 的 file identity、skip identity、executed，各自必须红。

## 第八轮稳定态逐条处置

| 复核项 | 结论 |
|---|---|
| 结构化 intent | **脚本生产侧闭合**：baseline 两 timing stdout＋每 log 三字段一致，invalid timing／非 full SHA fail-closed；O-6 仅核字段路径、不冒充 PASS。消费侧仍有 per-run hash major。 |
| exclusion authority | wrapper／pending-applied-ledger／receipt／canonical hash 覆盖四种绕法；剩余伪造性按 §0.4d 诚实登记为纪律＋独立裁决边界，**不再算缺陷**。 |
| Commit -1 mutation protocol | 第二隔离树／exact patch、reverse-check、先证 hunk、目标 FAIL、恢复后 diff 均写清；未发现整文件恢复或 mutation 残余进 A 的允许路径。 |
| T0.0d | validator 需求覆盖 pointer/hash/A/base/15 logs/字段；但被错误要求在真实 evidence 尚不存在时作为 Commit -1 自身门，形成 blocker。 |
| 用户 git 图 | #4 与 HANDOVER 已逐字冻结：Commit -1 合 master→A→cutover tree→15 runs→P；A 是 P 祖先且 P 不回执行分支，循环已解。 |
| §0.4d | 已停止为无外部 oracle 的纪律项叠推断门，剩余项明确事后裁决，边界定性正确。 |

## 第八轮稳定态重点回答

1. **结构化字段**：生产方字段在 O-6/stdout/每 baseline log 均真实存在；缺/非法 timing 与非 40 位 SHA fail-closed。`claims_current_head=true` 明确是 producer measured tree 的生成时 HEAD，P 不参与比较。
2. **Exclusion 四绕法**：改名、清空、直接 pathspec、跨 commit 均在 wrapper/ledger/hash/receipt 中具名；其不可抵赖性不足属已登记纪律边界。
3. **Mutation hard rule**：共同 protocol 符合 exact patch／隔离树恢复约束，且要求确认真实实现基线、mutation 生效、目标 FAIL 与恢复 diff。
4. **T0.0d**：真实消费 gate 触发点不可达于 Commit -1 自身，必须拆实现验收与真实 E0 gate。
5. **Git 图**：用户裁决后的图无未接线 ancestry；A→P 机械成立，P 不定义 entry。
6. **未决**：blocker 1、major 1；尚不能写“无未决 blocker/major”。

## 第八轮稳定态机械证据

- Baseline probe：dev/closeout rc=0，stdout 与 run log 三字段一致、SHA=`c4624139…`；invalid timing rc=2。
- O-6 invalid timing／nonrepo SHA 均 rc=2；未运行真请求，不声称 PASS。
- Task 集 plan 82／matrix 82、差集空；checker rc=0。
- `git diff --check` 通过。

## 第八轮稳定态总体 verdict

- **Verdict：存在 blocker，不可进入执行阶段。**
- **Blocker：1；major：1；minor：0。**

---

# 第九轮复评：稳定整改 `bcaf9e07`

- **复评范围**：第八轮 1 blocker／1 major、执行方第七轮 1 blocker／1 major、T0.0d preflight、ENTRY_SHA 拓扑、九行 validator 与相邻已闭合契约。
- **状态**：复评完成；发现已按验证顺序追加。

## 第九轮事实性发现

### [blocker] `cutover-plan.md:445,447-456` — T0.0d 摘要已移出 Commit -1，但 Commit -1 门表仍残留两行未来输入，因果矛盾未清干净

- **问题**：`:445` 明写 T0.0d 不属于 Commit -1；但紧接的“本 commit 的门”仍包含 `evidence 消费正控 | T0.0d ...`，正样本仍要求 `§0.4f validator 绿`。这两行需要 A／15 logs／P，只有 merge 后 preflight 才存在。因此执行者按门表仍无法收口 Commit -1，或只能跳过表中两门。`:456` 说“上面三种 mutation 红”与表实际四类门也自相矛盾，说明残留是实质而非历史注释。
- **证据命令与输出**：直接读取 `:445-456`；matrix 已把 T0.0d 映射到 post-merge preflight，但 plan 本 commit 门表未同步。
- **修复建议**：从 Commit -1 门表删除 `evidence 消费正控`，正样本删 `§0.4f validator 绿`；Commit -1 只验 T0.0a/b/c 与 validator **实现的合成 fixture tests**（若需）。把 T0.0d 九行 mutation／真实正样本只放 post-merge preflight 自己的独立门表，并明确该 preflight 绿才允许 C0。

### [blocker] `cutover-plan.md:41-49` vs `:1127-1137` — 用户裁定从 A 建 cutover tree，但主执行入口仍命令“从当前 master”建树；P 提交后会错误从 P 起步

- **问题**：完整 git 图要求 A 上跑 15 次，master 再提交 pointer P，cutover worktree 仍从 A 开始且 P 不合入。可是 §0.2 仍写 `git worktree add ... -b <branch> # 从当前 master`。按因果顺序执行到建 cutover tree 时，当前 master 已是 P；该命令创建 HEAD=P。随后 T0.0d 第 4 行会因 `worktree HEAD != ENTRY_SHA=A` 正确失败，导致用户裁定图不可执行。
- **证据命令与输出**：读取 §0.2 `:41-49` 与 #4 `:1129-1137`；两条是相反的起点。HANDOVER 也明确 P 不合回执行分支。
- **修复建议**：§0.2 命令改为显式 `git worktree add ... -b <branch> "$ENTRY_SHA"`，并要求 `ENTRY_SHA` 从 validator 外部参数／pointer 读取且为 40 位；创建后立即断言 `git -C "$TREE" rev-parse HEAD == ENTRY_SHA`。不得依赖当前 master。同步所有“从当前 master 起”的复述。

### [major] `cutover-plan.md:477,488-500` — T0.0d 九行 validator 的 mutation 数量／任务表仍写“五类”，且第 4 行合并两个 mutation，未做到每行一条

- **问题**：协调者前提称九行每行有 mutation；实际第 4 行 target mutation 是“传错 ENTRY_SHA／让执行树 HEAD 偏离 A”两个机制，第 9 行是三个 hash 的置空／篡改；T0.0d task 与旧门表仍概括成 pointer/hash/A/log/字段“五类 mutation”。这不必然错误，但“每行一 mutation”的可追溯声明不成立，执行者可能只跑每格第一个变体，漏 worktree 起点错误或某一种 hash。尤其 §0.2 恰有 HEAD=P 的真实反例，必须单独 mutation。
- **修复建议**：把九行展开为 mutation IDs（E1…E至少13），每个 slash 分支独立一项；T0.0d task、preflight 门表、矩阵摘要引用同一 mutation manifest，不再写“五类”。至少分开：wrong ENTRY_SHA vs wrong worktree HEAD；disk/runtime/skipped 三 hash；timing/SHA/claims/verdict/command 五字段。

## 第九轮逐条处置

| 第八轮／执行方 finding | 第九轮结论 |
|---|---|
| T0.0d 因果不可达 | **正文与矩阵已移到 post-merge preflight，但 Commit -1 门表残留 T0.0d／validator 绿，blocker 未清净。** |
| per-run 原始 artifact 重算 | **九行表已补原始 JUnit/log 重算、逐 run compare 与三 hash**；主要 major 已修。mutation 映射仍用 slash 合并多机制，留下 major。 |
| progress.base 自指 | **已修**：外部 `ENTRY_SHA=A`，progress.base 恢复任务基线；A tree 不写未来 P。 |
| Git 图／pointer | **用户图已冻结且 ancestry 可成立**；但 §0.2 实际 worktree 命令仍从当前 master=P，blocker。 |
| mutation hard rule | **保持闭合**：第二隔离树／exact patch、reverse-check、hunk 生效、目标 FAIL、恢复 diff 均在。 |
| 结构化 intent/exclusion/§0.4d | **未被拆坏**；纪律项停在已知边界，不继续叠推断门。 |

## 第九轮重点回答

1. **T0.0d**：独立 preflight 的因果顺序已正确；但 Commit -1 门表仍要求未来 validator 输入，必须删除残留两行。
2. **ENTRY_SHA**：外部参数解掉 A tree 文件自指；但 worktree 创建命令必须显式从 A，而非 P 后的 current master。
3. **九行 validator**：已从原始 artifacts 重算 file identity、skips/executed、canonical command、intent/verdict 与三 hash；不再只是 manifest 内互比。mutation 需拆 slash 分支为独立 IDs。
4. **Mutation protocol**：符合 hard rule，无整文件恢复或残余进 A 的允许路径。
5. **元边界**：§0.4d 仍正确区分机械与纪律，剩余执行者伪造性是已知边界。
6. **未决**：blocker 2、major 1；不能写“无未决 blocker/major”。

## 第九轮总体 verdict

- **Verdict：存在 blocker，不可进入执行阶段。**
- **Blocker：2；major：1；minor：0。**

---

# 最终复评：加入 `3f9169d1`

- **复评范围**：第九轮 2 blocker／1 major、`3f9169d1` mutation split、T0.0d 唯一归属、ENTRY_SHA／POINTER_SHA 图及相邻已闭合契约。
- **状态**：复评完成；发现已按验证顺序追加。

## 最终复评事实性发现

### [blocker] `cutover-plan.md:437-461,474-559` — T0.0d 的运行时机已正确后移，但 validator 实现没有可落地的 commit／树

- **问题**：T0.0d 真实验证必须在 P 后运行，这一点已修；但 validator 在那时必须已经存在。Plan 又明确 `d7f6c222` 没实现它，Commit -1 的 task／门只含 T0.0a/b/c，T0.0d 不属于 Commit -1；post-merge T0.0d 行同时承担“实现 validator + 对真实 A/P/logs 跑 25 mutations”。若在 P 后把 validator 写进 cutover tree，会让 HEAD≠A、C4 门立即红；写进 master 会产生未在用户图中定义的新 commit Q，且执行树 A 不含它；写成树外临时脚本则无版本化／独立评审基线。`:559` 说“由 Commit -1 基础设施交付者交付”，但没有任何 Commit -1 task 或收口门要求交付／用合成 fixtures 验它。
- **证据命令与输出**：Commit -1 `:447-461` 只有 a/b/c，且门表明确 T0.0d 不在本 commit；`:474-559` 才首次要求 validator 实现与 EV mutations；仓库当前无 validator 脚本。
- **修复建议**：Commit -1 增一个**实现任务**（例如 T0.0d-impl，按现 grammar 可命名 T0.0e）及合成 fixture tests，把 validator 代码随 Commit -1 合 master 得 A；post-merge T0.0d 只负责用真实 A/P/artifacts 跑既有 validator 与 EV-01…25，不再写代码。矩阵分别映射 implementation 与 real preflight；Commit -1 收口只验合成 fixtures，不用未来输入。

## 最终逐条处置

| 第九轮 finding | 最终结论 |
|---|---|
| Commit -1 门表残留未来 T0.0d | **已修**：门表仅 a/b/c；T0.0d 唯一归 P 后／C0 前。 |
| worktree 仍从 current master/P 建 | **已修**：显式 `ENTRY_SHA=A` 创建并立即核 HEAD；A→P ancestry 门存在。 |
| EV mutation 合并多机制 | **已修**：10 conditions、25 单 action EV IDs，双向对账与 ownership 无差。 |
| 新发现：validator 实现归属 | **blocker**：真实 preflight 时机正确，但 validator 代码没有在 Commit -1 被实现／版本化，P 后再实现会破坏 A 图。 |

## 最终重点结论

1. **T0.0d 唯一归属**：plan、matrix、摘要均已后移；Commit -1 门无未来 evidence 残留。
2. **Git 图**：ENTRY_SHA/POINTER_SHA 外部参数解自指，worktree 显式从 A 建，A 是 P 祖先，P 不回执行分支。
3. **Validator properties**：10 conditions 从 raw artifacts 重算；25 EV IDs 单动作、无重复／孤儿／错误 ownership。
4. **Mutation hard rule**：第二隔离树／exact patch、reverse-check、hunk 生效、目标 FAIL、恢复 diff 均保持。
5. **结构化 intent/exclusion/§0.4d**：未拆坏；剩余执行者可伪造性仍是已登记纪律边界。
6. **未决**：blocker 1、major 0。Validator implementation 必须成为 Commit -1 的真实交付物；否则 post-merge preflight 无可运行程序。

## 最终机械证据

- Task plan/matrix 82／82，差集空；checker rc=0。
- EV rows 25、unique 25、duplicates 0；EV-01…25 全列。
- 非 Markdown 代码面搜索不到 entry-evidence validator／EV implementation。
- `git diff --check` 通过。

## 最终总体 verdict

- **Verdict：存在 blocker，不可进入执行阶段。**
- **Blocker：1；major：0；minor：0。**

---

# 最终复评补充：`bf237c36`

- **复评范围**：上一轮唯一 blocker——validator 生产点；核对 T0.0e、合成 EV fixtures、T0.0d 消费边界与 mutation hard rule。
- **状态**：复评完成。

## 最终补充事实性发现

## 最终补充处置

- **T0.0e 生产点**：已成立。Validator 在 Commit -1 以版本化代码交付，使用合成 A/P/git 图/pointer/manifest/15 logs/JUnit，不依赖未来真实 evidence；因果可达。
- **合成 fixtures／EV-01…25**：覆盖 10 conditions、25 个单动作 mutation；共同 mutation protocol 已扩到 T0.0e，要求第二隔离树或 exact patch、reverse-check、先证 hunk、目标 FAIL、恢复 diff，满足 hard rule。
- **T0.0d 消费边界**：仍唯一位于 P 后、Commit 0 前；明确只消费 T0.0e 已交付 validator，不实现代码、不重跑合成 mutations。
- **Traceability**：plan/matrix 83／83、差集空；checker rc=0；Commit -1 与 post-merge preflight 分列。
- **相邻契约**：ENTRY_SHA／POINTER_SHA 图、结构化 intent、exclusion authority、§0.4d 已知边界未被拆坏。

## 最终 verdict

- **Verdict：可进入执行阶段。**
- **Blocker：0；major：0；minor：0。**
- **剩余项应记为已知边界而非缺陷；无未决 blocker/major。**
