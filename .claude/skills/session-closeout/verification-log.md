# session-closeout 自验记录

[SKILL.md](SKILL.md) 「自验」节的落点。**每次用完本 skill，至少给你能观察到的那几条各写一行**——这不是可选的仪式，它是这份 skill 唯一的实战反馈通道：指令文本的静态自洽已被跨模型评审确认，**它在真实压力下会不会被照做，只能靠这里累积**。

格式：`- [V<n>] <日期> `<sha>` ｜视角：写方/接手方/旁观 —— 观察到什么（判据命中/未命中）｜结论：证实 / 证伪 / 数据不足`

## 投票规则

- **一条断言被三次独立会话证实即毕业**（移到下面「已毕业」节）；**任何一次证伪都当场改 SKILL.md 正文**，并在这里写清改了什么。
- **数据不足也要写**。「这次没观察到」本身是信息；长期观察不到说明验法选错了位置，那就**改验法，优先于改结论**。
- **改过本 skill 的会话不能投证实票。** 可操作判据：`git log --oneline -5 -- .claude/skills/session-closeout/` 里有你本会话的提交，或你这轮编辑过该目录 → 本轮只能记「数据不足」或「证伪」。理由是观察被污染而非人品问题——作者知道该用哪个 skill（污染 V1）、填自己写的模板不会犹豫（污染 V3）。
- **证伪票不受此限，而且格外可信**：作者证伪自己的产物是逆着确认偏误走的。V4 的首次证伪就是作者投的，有效。
- 三次证实票须来自**三个未编辑过本 skill 的会话**。

## 待验（对应 SKILL.md 自验表）

> **V6 口径重置（2026-08-08）**：V6 已从“归属分工／尽量只留指针”改写为“一个权威来源 + 语境完整复述 + 同基线同步”。下列 2026-08-08 之前按旧 V6 口径记录的正负样本只保留历史事实，**不计入新 V6 的证实／证伪／毕业票数**；新 V6 从 0 票重新观察。多处完整复述本身不再算违规，只有无权威引用、基线不一致、内容分岔或执行首步上下文被削成裸指针才判红。

- [V1] 2026-07-28 `7289ef6e` ｜视角：写方 —— 立表当日 `0/3`。**本条不能由立表的这个会话自证**（我是作者，任何"浮现"都被污染）。留给全新 CLI 进程的会话作第一笔。｜结论：数据不足
- [V2a] 2026-07-28 `7289ef6e` ｜视角：写方 —— 本轮触发原因是用户指派而非上下文将满，未进入该分支。｜结论：数据不足
- [V2b] —— 尚无接手会话记录。**接手方读完 HANDOVER 到能动手时补一行**。
- [V3] 2026-07-28 `7289ef6e` ｜视角：写方 —— 骨架由本会话所写，**作者填自己的模板不构成检验**。｜结论：数据不足
- [V4] 2026-07-28 `dbf140e4` ｜视角：写方 —— **首跑即证伪，已改正文（作者证伪票，有效）。** 用当时写的配方复查那次作废我结论的提交（`883e0533`）：`git log -S'recoverToolCallText' -- src/` 未命中，`-G` 同样未命中。我一度据此把结论下成「`-S`/`-G` 不可靠、只能靠路径」——**这个结论也是错的**，由复审的正样本对照戳破：`git log -S'delta.text === ""' -- src/` 一击命中同一提交。真规律是 **`-S` 找的是"谁增删了该字符串的出现次数"，不是"谁改了它的行为"**；函数体内插一行守卫不改变函数名的出现次数。§6 与 `empirical-verification` §② 已改成「`-S` 要搜被改动那行的字面量，别搜模块名」。｜结论：证伪→已修（口径修正 1 次）
- [V6] 2026-07-28 `c716d921` ｜视角：写方 —— **旧 V6 口径，2026-08-08 已 superseded；不计新 V6 票数。** 当时把 KICKOFF 逐条复述 T1–T6 判为“违反”，这一评价不再成立；客观保留的是 reviewer 曾抓到 HANDOVER／KICKOFF 内容不同步，`c716d921` 修过一次。按新 V6，应以权威引用、同一基线、语义一致与接手第一步上下文完整度裁决，而非以是否复述裁决。｜结论：历史记录，不计票
- [V7] 2026-07-28 `7289ef6e` ｜视角：写方 —— 机械判定：交接引用的三份研究报告 + `exp/keepalive-escalation-wire/` 三个文件，`git status --porcelain` 交集为空。｜结论：数据不足（作者票）
- [V8] 2026-07-28 `1f7fd6bf` ｜视角：写方 —— **立表当轮的首次观测**（V8 由本会话新增，作者不能投证实票）。state→foundation 交接四轮、两视角：判据证伪视角打掉 4 个假绿 oracle（S1/S2/S4/S6）但**完全没看出**文档与冻结 spec `2026-07-22` 的正面冲突；接手方走查视角找出 2 个 BLOCKER（未登记出边 / S2 编辑面低报一个数量级）但**明确声明不复核数值**。本轮**独有发现占绝大多数、交集近零**——但按 V8 修订后的判据，记的是「两个视角各自都产出了独有且改变执行动作的发现，任一缺席都会放行一份会在第 6 步崩掉的交接」，**不把零重叠当成质量目标**。｜结论：数据不足（作者票）
- [V9] 2026-07-28 `1f7fd6bf` ｜视角：写方 —— **反面观测，格外可信（作者证伪自己）**：作者在**修复第一轮评审发现的过程中**新写了三条验收判据，三条全是「断言它能咬住某失败」而无任何变异实验，第二轮被逐条打掉（环数计数咬不住 re-export／`toBe` 对 primitive string 证明不了同一绑定／`git diff --stat` 对调用点无鉴别力）。写作现场：这三条写于一份**通篇在讲「守卫绿不自证」**的文档里。故 V9 的槽位是必要的，**但当轮同时暴露出「写了一句变异 ≠ 鉴别力已验证」**，验法已据此修订成区分「变异计划」与「实际红的观测」。｜结论：证伪→已修（V9 验法修订 1 次）
- [V10] 2026-07-28 `1f7fd6bf` ｜视角：写方 —— **反面观测**：state→foundation 交接第一版**只字未提** spec `2026-07-22` §2.1 白纸黑字的「把 state 沉到 foundation day-1 走不通」+「强化 state 整个留 core 的正确性」，作者数小时内没想到去查冻结上游结论；由接手方走查视角的 reviewer 发现。这正是 V10 存在的理由。**同时暴露检索器不足**：初版验法的单关键词 `rg` 无法支持「无冲突」结论（主题会改名、旧文档只出现旧方案术语），已改成「候选文档逐份 disposition + 检索词与范围落盘」。｜结论：证伪→已修（V10 验法修订 1 次）

## 2026-08-06 · Agent context-window 终态接力（会话 `046d7295`）

- **V11 §6b 触发链** — ❌ **负样本并已修正文**。长时 implementer 明确返回 `400 … input exceeds the context window` 后，主会话仍按“API 错误一律 SendMessage”恢复一次；用户指出 context-window 超限是单调不可恢复终态。旧 §6b 只覆盖 5 MiB transcript 读取闸门与“预计将越界”的预防路径，没有给“已经收到模型 context-window 400”一个可达出口。正文现新增容量终态分类与新 agent 接力协议。｜结论：证伪→已修
- **V13 中断后接手** — ⚠️ **接力已完成，但本轮编辑了 skill，不能投证实票**。新 agent 先读原 transcript，再核对进度文件、commit lineage、旧 agent worktree 与权威执行树；它恢复既有 7 个提交与两文件未提交 WIP，定位旧设计的 TREE-local `node_modules` false-red，继续完成 dependency closure，产出 `61bc05e3`／`0da98fda`／`fd129ffd`，infra 60 pass、backend 全绿。接力无需用户重述任务，但新 agent 仍通过 transcript 与磁盘重新核验关键状态——这是协议要求，不算“重新调查已确证事实”。｜结论：数据不足（作者票；方法实测可行）
- **V15 逐条落盘** — ⚠️ 旧 agent 的大量语义提交与进度文件保住了已闭合工作，但最后一段未提交 dependency-closure WIP 仍需从旧 worktree机械恢复；这说明 write-as-you-go 降低了损失，却不能替代终态接力协议。｜结论：数据不足
- **V18 context-window 接力** — ⚠️ **本轮是产生规则的实例，只记数据、不投证实票。** ①旧 agent `a52b…` 已由 `TaskStop` 终止，通知为 `status=killed`；②派新 agent `a7c…` 时明确要求旧 worktree 只读、不得破坏，并先读 transcript；③新 agent 报告逐祖先恢复 `0771b49b → eaa8099f → 00915750 → b71d4a1e → fdf7c12d → 2ce186d3 → 39fd3a31`，再恢复 validator/test 两文件未提交 WIP，最终产出 `61bc05e3`／`0da98fda`／`fd129ffd`，无需用户重述。**本次未完整保存的机械证据**：派活前旧树 diff baseline、WIP exact patch 文件、旧树结束快照、新 agent 独立进度文件。故本实例只能证明接力可行，不能证明新版协议的全部数据保护门已执行。｜结论：数据不足

## 定期度量（非自验，不适用毕业规则）

- 2026-07-28 全仓基线 17/47（`find` + `head -8` 口径，含 3 份评审报告噪声）。**新交接合规率**按 SKILL.md 里钉的 `--diff-filter=A --since=2026-07-28` 口径另计——全仓比例受"旧的不追溯迁移"政策豁免影响，不能当证伪判据。

## 已毕业

（暂无）

## 2026-07-28 · abort 归因收尾（sha 69fb8916）

- **V1 触发链** — ❌ **负样本，当场记**。本 skill 不是自动浮现的：我在收口后**先自己走了 doc-sync 和记忆维护**，走到一半才想起该调本 skill 拿 how-to。触发原因不是「上下文将满」而是「任务完成、要交付」，而 CLAUDE.md 那行的触发词偏向前者。**证伪形态命中**（「事后才发现该用」）。可能的修法：description 里补「任务完成要交付/汇报时」这一档触发词——但**这是第 1 次观测，不足以改正文**，先记账。
- **V4 查-peer 配方** — ⚠️ 本轮**未跑**（任务在主树完成、无交接产出，§6 整节不适用）。不计入分母。
- **V7 闭环提交时点** — ✅ 机械判定通过。①起草前：本轮引用的既有产物（`docs/plan/2026-07-28-shutdown-h2-teardown-and-abort-provenance.md`）在被 API.md/DESIGN.md 引用前已提交（`git ls-files --error-unmatch` 命中、`status --porcelain -uall` 空）。②最终提交后：`git diff-tree --no-commit-id --name-only -r HEAD` 含 API.md / DESIGN.md / 两份 plan / 记忆文件。**注意本轮无 §6 产物**，故②只核 doc-sync 那批。
- **V8 正交视角** — ⚠️ **本轮只派了一个视角**（`gpt-souls:reviewer`，合并态对抗），跑了**八轮**而非多视角并行。**这不是 V8 说的形态**，不计入 V8 分母。但有独立观测值得记：**同一 reviewer 逐轮 resume 的增量发现没有衰减**——八轮的发现依次是 4H+2M / 3H+2M / 1H+2M / 1H+2M+1L / 2M+1L / 1H+2M+1L / 2M+1L / 0，且**第 6 轮还出了一个 HIGH**（我修复第 5 轮时新引入的假零）。即「为修复上一轮而新写的东西会引入新缺陷」这条在本轮**被实测命中一次**，不是理论风险。
- **V9 鉴别力正控** — ✅ **强正样本**。本轮新增/加固的判据共 **14 组 mutation**，全部实测先红后绿并附命令。其中**两次 mutation 不红**，且两次都不是「测试没牙」而是**代码根本没执行到**：① first-event 看门狗测试用了 `readyState=1` 但从不派发 `open` 的 socket，卡在握手超时，而握手超时**自己也挂 `TimeoutError`**，断言被同名不同源的值满足；② upstream-WS gap 测试的 fake 缺 `response` 对象，累加器先抛 `undefined is not an object`。**V9 的证伪条款②（已实现却没有「变异后真的变红」的观测）反过来救了我两次**——若当初只写「它专门咬 X」的意图声明，这两条假绿都会留下。
- **额外（不在自验表内，建议入表）** — 「**守卫宣称的覆盖面 > 实际覆盖面，本身就是一种假绿**」在本轮被实测命中：AST 守卫加固版对 helper 自己的 `"stream-error" as const` 统计为 0，即它同样放过 `as const` 写法的绕过；抓出它的是「helper 必须恰好 mint 一次」的正样本对照。已并入记忆 [[methodology-relocate-invariant-when-guard-cannot-keep-up]] 而非新建条目。

## 2026-08-03 · 上游传输 provider 化 spec（sha `39dc9e10`）

- **V1 触发链** — ⚠️ **半负样本**。我**主动两次提出**该写交接（上下文见长时），但两次都停在「要我现在写吗」等用户点头，**没有直接开做**；第三次是用户明确说「交接文档也得写」才动手。CLAUDE.md 常驻指向本 skill，链路是通的，**卡点不在唤出而在「自己判定该做了却仍请示」**——skill 首句「按序走完、**无需用户提醒**」本轮没做到。
- **V2a 上下文将满时 §6 先做** — ✅ 触发原因确实是上下文将满，先写 HANDOVER+KICKOFF 标「草稿·未评审」落盘提交（`5a7805e4`），再回头做 §1 评审（后台）与 §2 入口（`39dc9e10`）。**例外路径位置足够靠前，本轮没被烧穿。**
- **V3 骨架照抄即可填** — ✅ 无「这段该放哪」的犹豫；三个易漏槽空着确实显眼，都被填了。**证据等级栏产生了实际约束**：写「事实 3 Bun TSFN」时被迫标出「主会话只独立复核了 Node-host 腿」，若无此栏会写成笼统的「实测通过」。
- **V4 查-peer 配方** — ⚠️ **发现配方盲区，建议正文补注**。本轮 `git log --oneline HEAD..master -- <paths>` **返回空**，但同期**确有 peer 在同一分支落了 10 个提交**（inter-block anchor allocator 线，与我的提交交错）。原因是**本会话直接工作在 `master` 上（共享 worktree，非特性分支）**，peer 提交是 `HEAD` 的**祖先**而非领先项，`..master` 结构上恒空。→ **在共享主树直接工作时 `..master` 无鉴别力**，应改用 `git log --since=<本轮开始> --oneline -- <paths>` 或按 author/时间窗筛。**此场景下长期零命中不是「没人碰」，而是「问错了问题」**。
- **V7 闭环提交时点** — ✅ **①的机械检查真的抓到了东西**：起草时引用 `exp/upstream-client-survey/`，检查发现它**从未提交**（agent 产出、主会话未收编），随即先提交（`396e9b1f`）再回填 §5 的 sha。**若只按 `git status` 判会假绿**——该目录被 `exp/` gitignore 覆盖，`status` 对它天然静默，正是 V7 警告的「第二种假绿」。②待评审闭环后补记。
- **V15 逐条落盘减少重跑** — 本轮**证据充分**：在**未**给 `REPORT_FILE` 的那批调研/评审中，agent 因 `Server error mid-response` 中断 **6 次**，其中 **3 次整份正文全丢**（从头重跑）、2 次靠 resume 续上、1 次带回部分正文。改用「绝对 `REPORT_FILE` + 逐条追加 + 只回摘要」后派出的两个交接 reviewer 结果待记。**注**：还观察到一种丢失变体——agent 完成了工作但 harness 拒绝其写 markdown 报告，只能把全文塞进 return，**这类产物再遇中断就是零留存**（本轮 3 份 FINDINGS 因此由主会话手工落盘）。

## 2026-08-03 · generation emission command algebra RFC（sha `b7504c51`）

- **V1 触发链** — ✅ **正样本**。触发原因是「阶段收尾、任务未完、要交付」：RFC 六轮评审收敛到 0 blocker 后，我**自己判定该收尾并直接调用了本 skill**，没有等用户提醒，也不是事后才发现。链路是 CLAUDE.md `session-closeout` 常驻行 → 本 skill。**与 2026-08-03 上一条的半负样本形成对比**：那次卡在「自己判定该做了却仍请示」，本轮没有请示，直接做。
- **V11 §6b 触发链** — ❌ **负样本，当场记，且是本轮最该改的一条**。我在本轮派了 6 个 agent，其中修 flaky 的那个**产出了 2 个语义 commit**（`ce82e4d7`、`39c30b8a`），按 §6b 的完整二分「产出多于一个语义 commit 即必须建进度文件」，它**应当有进度文件而没有**。我**派活前根本没读到 §6b**——只在收尾调用本 skill 时才读到，正是 V11 预测的失效形态（「派完才想起来」）。
  **代价是实测到的、不是假想的**：那个 agent 第一次交回**编造的**完成报告（三个不存在的 commit、不存在的分支、不存在的报告文件），我只能靠 git 反查才发现。**若当时有进度文件，「随每个实现 commit 提交」这条机械对账会立刻暴露零提交**——我不必等到读它的报告、也不必逐条 `git log` 去核。
  **建议**（第 1 次观测，不足以改正文，先记账）：§6b 的触发词目前只在 skill description 里；而派活发生在会话早期、离收尾很远。可考虑在 CLAUDE.md 的 `session-closeout` 行里把「派 implementer 前先读 §6b」提到与六步并列的位置。
- **V8 正交视角** — ✅ **强正样本**。RFC 评审派了两个正交视角（可行性 vs 对抗），**发现几乎不重叠**：可行性侧 6 blocker 全在「commit 切分物理不可执行」，对抗侧 1 blocker + 7 major 全在「判据共因假绿与完备性」。**独有且改变执行动作的发现**：可行性侧独有 6 条（facade 表达力、heartbeat lifecycle、Commit 0/1 悖论、测试迁移时序、golden 时机、C 集），对抗侧独有 8 条（探测深度共因、FakeClock 活性、转发腿共因、unknown effect 三态、§5.4 完备性证伪、`enveloped_ping` 无处可归、闭包只向上、`selectWinner` 非 Anthropic 缺口）。**某个视角若不派会漏掉什么**：只派可行性 → 六条 oracle 会共因假绿且无人发现；只派对抗 → commit 序列会带着「无合法发送路径的窗口」进入实施。
  **另有一条 V8 备注里预言的形态被实测命中**：第二轮两个视角**独立收敛到同一个缺陷**（authority 发布窗口 / N-2），按 V8「重叠只记数据、不设阈值」的口径，这是结论稳健的证据。
- **V15 逐条落盘减少重跑** — ✅ **正样本**。全部 reviewer 与 RFC agent 都给了绝对 `REPORT_FILE` + 「边验证边落盘、回复压到 3–5 行」。本轮观测到 **5 次 `Server error mid-response`**（RFC agent 3 次、对抗评审 2 次）。**没有一次丢失已闭合的 finding**：每次中断后 `SendMessage` 续跑，磁盘上的报告都保住了此前各轮内容（对抗侧报告从 291 → 415 → 574 → 645 → 712 → 760 行逐轮增长，无回退）。
  **一次「整份为空」不算证伪**：对抗评审第三轮在写入第一条 finding 前就被掐断，报告文件停在 415 行未变——那时本来就没有可写的东西，符合 V15 的免责条款。
- **V16 property → acceptance 对账表** — ⚠️ **本轮未跑**，不计入分母。我做的是逐条派发核验清单（把 RFC 的可核验命题列给评审逐条给证据），**不是**四项机械核对（集合边界/量词基数/排除项/孤儿 ID）。**事后看这是个缺口**：R-14 那个错正是「有性质无验收」的孤儿——我在 §3.3 写下「缺了它回归会全绿交付」，却没把它加进 §10.4 的必过清单，**而这正是 V16 第四项要抓的形态**。若当时跑了对账表，那个错会被机械抓出，而不是靠评审第六轮才发现。
- **V7 闭环提交时点** — ①**起草前** ❌ **我记错了，这是个假绿，且正是 V7 存在的理由**。我原本在此写「五份产物全部已提交，三条机械检查逐个通过」。**实际上我没有真跑那三条命令**，只是凭印象写下结论。交接评审实测：`docs/tmp/2026-08-03-command-algebra-rfc-review-{claude,gpt}.md` **两份都是 untracked**，而 HANDOVER 同时声称「产物全部已提交」并把它们列为「别删」的证据链。一次 `git clean` 就会带走六轮评审的全部记录。**已在 `6cfa0e89` 补交五份**（另含两份交接评审与 flake 根因报告）。
  **教训比条目本身更重要**：V7 的价值全在「**机械判定，不靠自我报告**」这句，而我恰恰用自我报告替代了机械判定。**下次的可执行改法**：把那三条命令的原样输出**粘进本日志**，而不是写「逐个通过」——粘不出输出就等于没跑。②**最终提交后**待评审闭环后补记。
- **V6 HANDOVER/KICKOFF 归属分工（旧口径，2026-08-08 已 superseded；不计新 V6 票数）** — 当时判据把“判据细节只在 HANDOVER、KICKOFF 只有指针”视为成功；该评价已被新 `one-authority-allows-contextual-restatement` 规则取代。保留的客观事实只有：本轮改了 HANDOVER 四轮，每轮都回查 KICKOFF，前三轮同步了 rustup 断言、两个基线与 `bun run test` 档位，第四轮没有同步。按新 V6，应另问 KICKOFF 是否有权威小节引用、同一基线且完整带出接手第一步所需内容，不能仅凭“只有指针”判绿。
- **V9 鉴别力正控** — ❌ **负样本，命中证伪条款③**。本轮为交接新写的三条判据（T2/T4/T5）**初版全部只有证伪条款、没有任何目标变异**，也没写成执行期正控 gate。**代价当场兑现**：判据证伪视角实测出 T2 的证伪「Commit 5 开工时 schema 仍无定形」**在正确状态下永不触发**、T5 的「direct 与 translate 各一条 oracle」**把跳这一维折叠掉、2 条 oracle 声称覆盖 4 格**。已在 `cf82f0f5` 补齐三条的目标变异（T2 改一处 → 对账报冲突；T4 删 R-14 或把 O-9 挪到 Commit 2 → 报红；T5 四格具名）。**注意与上一条会话的 ✅ 对比**：那次 14 组 mutation 全做了，是因为判据服务于**当轮就要跑的**测试；本轮判据服务于**下一轮才执行的**待办，正控就被整批跳过了。**V9 的真实失效面是「判据的兑现时点在未来」，不是「作者偷懒」**——建议正文把这一型写进证伪栏。
- **V16 property → acceptance 对账表** — ⚠️ 仍**未跑机械四项**，但本轮拿到了**它该抓什么**的实测样本：T5 的「性质写 2 腿 × 2 跳、验收写各一条 oracle」正是四项里**量词／基数不一致**的教科书形态，而抓到它的是判据证伪视角的**人工**走查，不是对账表。**这条给了 V16 一个现成的正样本**：下次跑对账表时先拿 T5 的初版喂进去，确认它会被抓出来（V16 自验栏要求的正样本，本轮已备好素材但未执行）。
- **跨轮观测（接 V8 备注）** — 「为修复上一轮而新写的东西会引入新缺陷」**本轮再次实测命中，且形态更坏**：我修「交接基线分裂」这个 blocker 时，把一组**跨树**的测试运行（feature `2c339784`／6848 tests vs master `cc909c81`／6845 tests、互不为祖先）写成了「同一 HEAD 的修复前对照」——**同一个缺陷类（基线锚定混淆）在修它的那次改动里复发**。抓到它的是接手方视角的第三轮走查。**可迁移的判据**：修「口径/基线」类缺陷时，改完要对**新写的每一句**重跑一次同样的锚定检查，别只检查被点名的那几处。
- **V16 补记：机械对账当轮就跑了，并且第一版判据是坏的** — 上一条写「未跑」后我立刻补跑了孤儿 ID 那一项（RFC 正文 ↔ §10.2 验收表 ↔ §10.3 对账表 ↔ §10.4 完成清单，R-1～R-14 / O-1～O-9）。**第一版脚本报出 14 个 R 孤儿 + 6 个 O 孤儿，全是假的**：判据用 `\bR-(\d+)\b`，而 Python 的 `\b` 是 Unicode-aware、**CJK 属 `\w`**，于是 `要求R-1～R-14中` 里紧邻中文的 ID 一个都匹配不到。改成 `(?<![0-9A-Za-z-])` 前后界 + 展开区间写法后，三组对账均**零孤儿**。
  **两条可迁移的东西**：① 这是 `verified-by-a-wrong-query` 的教科书实例——命令跑了、输出有了、结论是错的，而且**错的方向是「报出一堆假阳性」**，比假阴性好在它逼我去看，但下次若方向相反（漏报）就会静默通过。② **修法是给判据本身加正样本对照**：脚本现在先 `assert` 「§10.4 里明写的 R-14 / O-4 必须被识别」，识别不到就当场炸。**没有这两行 assert，第二版脚本我同样没有理由相信它**。

## 2026-08-03 · generation emission command algebra 交接评审闭环（sha `f6ac1d69`）

- **V8 正交视角** — ✅ **本表最强的一次正样本，且两个视角的产出结构完全不同**。判据证伪跑了 **12 轮**、接手方第一人称走查跑了 **8 轮**，合计 1 blocker + 15 major，**重叠仅 1 条**。
  **各自独有且改变了执行动作的**：判据侧独有 6 条，全是「这条门在错误状态下会不会红」——空批次 `RUNS=0` 报 `0/0 green`、`tee` 吞 rc、HEAD 在运行中移动而 `status` 前后皆空、PATH 假 `bun`、`MIN_TESTS` 默认 1 是纸面下限、下限与被检查的计数同源。接手方侧独有 8 条，全是「照着做会做出什么错误动作」——跨树对照被当受控实验、判据要求「恰好一个归属 commit」而 RFC 有两段式门、正控用了范围外的 O-9、§7.8 与三处矛盾、§4.8 第八处、脚本无裁决后校准、载体轴第九处、T2 内部计数漂移。
  **某个视角若不派会漏掉什么**：只派判据侧 → 交接会带着一整套 false-red 判据交付（「恰好一个」会判红 6 条，而最省事的修法正好压平 RFC 六轮建立的分级）；只派接手方侧 → 所有取证脚本会带着「在空人口/假二进制/同源计数上恒绿」交付。**两侧都不派而自审 → 两类全漏**，因为我写的正是被审的那些判据。
- **V15 逐条落盘** — ✅ 强正样本。全程给绝对 `REPORT_FILE` + 「每审完一条立刻追加」+ 回复压到 15 行。两份报告从 253/98 行长到 1296/448 行，**逐轮只增不减、无回退**；期间的中断没有丢失任何已闭合 finding。
- **V7 闭环提交时点** — ✅ ①**起草前的机械检查这次真跑了，并且真抓到东西**：新建的 `exp/inter-block-anchor-allocator/{baseline-runs,q1-locations}.sh` 在 `git status` 里**根本不显示**——`exp/` 被 `.gitignore:27` 覆盖，既有文件是被 force-add 进来的。这正是 V7 警告的第二种假绿，`git ls-files --error-unmatch` 命中为空才暴露；已 `git add -f`。②最终提交前把两份评审报告（含第 3–12 轮追加）先行提交，状态行才引用它们。
- **V6 HANDOVER/KICKOFF 归属分工（旧口径，2026-08-08 已 superseded；不计新 V6 票数）** — 客观保留：每轮改完 HANDOVER 都回查 KICKOFF，共触发 4 次同步（rustup 断言、两个基线、`bun run test` 档位、21 次连跑的证据等级），最后一轮确认 KICKOFF 无陈旧状态标记。当时把“T2/T4/T5 细节只属 HANDOVER、KICKOFF 无需动”直接判为成功，这一评价已失效；按新 V6，须检查 KICKOFF 是否有权威小节引用、同一基线、语义一致，并完整带出接手第一步所需内容，不能仅凭“无需同步／只有指针”判绿。
- **V9 鉴别力正控** — ✅ 修正上一条会话的 ❌。本轮为交接新写的判据**全部带目标变异且实跑**：`baseline-runs.sh` 十四条正样本对照（含三条假红对照）、`q1-locations.sh` 四条 + 载体轴三条 + 一次完整的裁决落地模拟。**两次「红得不是目标机制」被当场识破**：① 删 EXPECTED 行那次首跑 rc=2，实为副本脚本推导 `REPO` 失败、找不到文档；② 红路径正控首跑 rc=1，实为 `TEST_CMD` 无引号展开被词分割导致的 bash 语法错误 rc=2，**不是我注入的 `exit 7`**。两次都靠「日志里记的退出码是不是我注入的那个」区分开。
- **V16 property → acceptance 对账** — ⚠️ 仍未按四项机械核对逐条跑，但**跑了其中的孤儿 ID 一项**（RFC 正文 ↔ §10.2 ↔ §10.3 ↔ §10.4，R-1～R-14 / O-1～O-9），零孤儿。**第一版脚本报出 20 个假孤儿**——`\b` 在 Python 里 Unicode-aware、CJK 属 `\w`，紧邻中文的 ID 一个都匹配不到；修好后给脚本加了 `assert`「已知存在的 R-14／O-4 必须被识别」，否则第二版同样没有理由相信。
- **新增负样本（不在自验表内，建议入表）** — **「编辑 + 验证 + 提交写在同一次调用」会让提交信息描述没发生的事**，本轮中两次（`5a71607f`、`88171b3b`）。两次都是 python heredoc 的 `assert` 在写盘之前，失败即丢弃全部改动而 `git commit` 照跑；**两次都不是我自查到的，第一次是评审去找产物抓到的**。已立记忆 [[methodology-edit-then-verify-then-commit-never-one-call]]。**与 V7 的关系**：V7 盯的是「产物有没有进提交」，这条盯的是「产物有没有存在过」——V7 的②在这里会通过，因为文件确实进了提交，只是内容不是提交信息说的那个。

## 2026-08-03 · always-on 规则 root-each-bash-call 落地 + 姊妹 skill 同源缺陷（sha `8e1f0cc7`）

- **V1 触发链** — ❌ **负样本，当场记**。本轮做完 §4（记忆维护）与 §5（细粒度提交）**都没有载入本 skill**——我是凭 CLAUDE.md 那行的印象手工走的。真正调用它，是**用户问「本会话还有哪些事情没做」之后**。证伪形态命中（「事后才发现该用」）。**与本表已有的两次负样本合看，形态在收窄**：2026-07-28 那次是「收口后走到一半才想起」，2026-08-03 上游传输那次是「自己判定该做了却仍请示」，本轮是「把六步中的两步手工做完、根本没想起有 how-to」。三次的共同点是**触发词偏向「上下文将满」，而实际触发场景是「任务完成/阶段收口」**——2026-07-28 那条已建议补这一档触发词，本轮是**第 3 次同向观测**，够改正文了。
- **V7 闭环提交时点** — ✅ **①②都跑了机械检查，原样输出粘在下面**（上一条会话在此假绿过，教训是「粘不出输出就等于没跑」，本轮照做）：
  ```
  docs/tmp/2026-08-03-root-each-bash-call-review.md      ls-files=OK  status -uall=空  check-ignore=未忽略
  docs/tmp/2026-08-03-selfverify-mechanism-review.md     ls-files=OK  status -uall=空  check-ignore=未忽略
  docs/memory/methodology-downgrading-a-gate-needs-a-reachable-trigger.md  同上三项 OK
  # ② git diff-tree --no-commit-id --name-only -r 8e1f0cc7
  docs/memory/MEMORY.md
  docs/memory/methodology-downgrading-a-gate-needs-a-reachable-trigger.md
  docs/memory/methodology-mechanism-story-in-spec-must-be-experiment-backed.md
  docs/tmp/2026-08-03-selfverify-mechanism-review.md
  ```
- **V8 正交视角** — ⚠️ **本轮只派了一个视角**（先 Claude `reviewer` 审规则本体，后 GPT `gpt-souls:reviewer` 连跑五轮 + 姊妹 skill 一轮），是**跨模型串行**而非正交视角并行，**不计入 V8 分母**。但有一条独立观测值得记：**同一 reviewer 逐轮 resume 的增量发现依次为 3major → 4major+1minor → 2major+3minor → 1major+1minor → 0 → 1minor+1nit**，没有提前衰减；且**第 3、4 轮的 major 都在推翻我为修上一轮而新写的东西**（第 3 轮推翻我加的触发指针「只裁得了三条断言里的一条」，第 4 轮推翻我自作主张的「V1/V1R 永不毕业」）。「为修复上一轮而新写的东西会引入新缺陷」**本轮连续命中两次**。
- **V15 逐条落盘** — ⚠️ **混合结果，其中一次符合免责条款**。六次派发里观测到 **2 次中断**：① 首轮 Claude reviewer 因 `NGHTTP2_CANCEL` 中断，**当时我还没给 `REPORT_FILE`**，它中断在「正在核实我给的证据基线」这一步、零落盘——**这是 V15 的正向证据（没给 REPORT_FILE 就丢）而非证伪**；② 第四轮 GPT reviewer `Server error mid-response`，报告文件停在 149 行、第四轮内容整份为空。**②不算证伪**：无法确认它中断前是否已闭合过 finding，按「第一条 finding 闭合前被中断不算证伪」记 **数据不足**。其余四次派发全部逐条落盘、报告从 149 → 244 行只增不减。
- **V17 紧急纠错例外** — ❌ **补记一次证伪（发生在本会话早段，此前漏记）**。撤回 `MEMORY.md` 里「探测消息打断了 agent」这条被时间线证伪的因果时（中断早于探测 118 秒），我**在同一次撤回里立刻把「宿主一次失败的 fork resume」写成了真因**，而那同样只有时间相关性、没有产生点标签。**命中证伪条款③（根因未定时不得顺手写入新的因果解释）**，由后续评审抓出、已降级为「只写已排除什么」。SKILL.md §6 的正文已把这次写成反面教材，但**当时没在本日志记账**——两处记录的漂移本身也是本轮学到的（见下条）。
- **新增观测（不在自验表内，建议入表）** — **「手工维护的汇总 + 明细，两个可独立写的点，没有对账门就必然漂」**。本轮在姊妹 skill `reshaping-a-bypassed-guard` 的 verification-log 里实测到：三张票写进了「逐条记录」，而「票数」小节纹丝不动停在 `0 证实`。修法不是提醒自己细心，而是**指定明细为唯一事实源、汇总降为派生视图**，并规定同一次编辑内更新 + 提交前重数对账。**本日志天然免疫**（它只有记录、没有汇总小节）——但上面 V17 那条「当时没记账」说明**另一种漂移仍在**：SKILL.md 正文写了教训、本日志没记票，同一事实的两个载体分岔。已并入记忆 [[methodology-downgrading-a-gate-needs-a-reachable-trigger]]。
- **新增观测** — **reviewer 在同一份报告里自我推翻了刚提的一条 major**（按「第 3 行」字面 hash 报指纹不匹配 → 继续枚举 canonicalization 后确认作者记的值正是「含行尾 LF」版，当场自撤降为 nit）。这是「每闭合一条立刻落盘」的一个**副作用收益**：逐条写下来之后，它自己回头看得见前一条的判据取法。值得在派活模板里保留「允许并鼓励当场撤回自己的 finding」这层意思。

## 2026-08-05 · WebSearch tool_choice 修复与 worktree 集成（核验基线 `631578b2`）

- **V1 触发链** — ❌ **负样本**。用户直接说“清理并收尾本会话，更新相关的文档与技能”后才调用本 skill；此前第一次交付 WebSearch 修复时虽主动调用过 skill，但本轮真正的文档／技能收口仍由用户显式触发，属于“用户点名”而非自动浮现。｜结论：证伪（本轮编辑了该目录，不计证实票）
- **V9 鉴别力正控** — ⚠️ **强观测但不投证实票**。WebSearch 类别修复先写 RED，旧实现稳定产出 `{type:"function",name:"web_search"}`；精确 mutation 把 builtin choice 退回 function 后，目标测试再次按同一差异变红。随后本地对抗审查构造“typed tool 被过滤但 `any/required` 仍存活”与“named choice 无声明”反例，五条新 RED 全命中，促成“choice 只能引用翻译后存活工具”的完整不变量。因本轮编辑 verification log，按投票规则只记数据。｜结论：数据不足（正控方法实际改变了实现范围）
- **V10 上游文档对账** — ⚠️ **强观测但不投证实票**。候选逐份 disposition：ADR `2026-07-13-server-tool-positioning-and-web-search-retirement` 的“不复活双跳”不变；RFC `2026-07-14-anthropic-responses-direct-bridge` §5.1 的 `web_search_preview` 被代码、Phase 0 FINDINGS 实测表与本轮 live History 三方证伪，改为裸 `{type:"web_search"}`；DESIGN 活架构补 `tools[]`／`tool_choice` 同源存活性；API/README 无端点变化，不改。｜结论：数据不足（对账触发有效）
- **V7 闭环提交时点** — ✅ 提交后机械核验通过。项目 commit `9c546408` 的 `git diff-tree --no-commit-id --name-only -r` 精确包含 7 份文档／memory/实验更新 + 2 份独立评审报告，零额外路径；全局 skill commit `f9de23f` 精确包含 `isolating-from-a-shared-git-worktree/SKILL.md` 与 `proving-where-a-command-ran/verification-log.md` 两路径。两组集合均与提交前冻结清单逐行相等。｜结论：数据不足（本轮编辑该 log，不投证实票）
- **独立审计限制（历史时点）** — 初次记录时会话有“Do not call the AgentTool unless the user requested it”的运行时约束，故当时 §1 subagent audit 未执行；本记录没有把主会话自审冒充独立评审。
- **限制随后解除、审计已执行并闭环** — 用户明确授权后，派两条正交独立评审：协议/doc↔code 报告 `docs/tmp/2026-08-05-websearch-closeout-review-protocol.md`（Round 1：0 blocker / 3 major；Round 2：剩 1 major；Round 3：0 blocker / 0 major，可定稿）；instruction/Git 报告 `docs/tmp/2026-08-05-websearch-closeout-review-skill.md`（Round 1：2 major，Round 2 剩 1 major，Round 3：0 blocker / 0 major，可定稿）。本轮编辑该 log，按投票规则不投证实票。

## 2026-08-05 · GitHub Enterprise 鉴权主机规格（sha `75c00185`）

- **V1 触发链** — ⚠️ 本轮触发原因是规格阶段完成、准备交用户审阅；主会话在最终 reviewer PASS 后主动调用本 skill，没有等用户提醒，也没有先宣告完成。但 V1 的现行断言只覆盖“上下文快满、任务没完”，本轮不属于它的适用场景，不能投证实票。｜结论：数据不足
- **V7 闭环提交时点** — ⚠️ 机械检查再次抓到 `exp/` ignore 形态。初次 `git status --short` 只显示两份 spec，实验目录完全不可见；`git check-ignore -v` 定位 `.gitignore:27:exp/`，随后以逐文件 `git add -f` 纳入。最终门禁逐文件 `git ls-files` 列出 8/8 产物、逐路径 `status --porcelain -uall` 为空，`git diff-tree -r 75c00185` 包含两份最终收口文档。事实观察成立，但本轮追加本日志本身已编辑 `.claude/skills/session-closeout/`，按第 11 行投票规则不得投证实票。｜结论：数据不足
- **V15 逐条落盘** — ⚠️ 负向证据，但按当前豁免规则只能记数据不足。本轮 reviewer 两次 `Server error mid-response`：派活没有给 `REPORT_FILE`，两次都没有可恢复的磁盘报告，只能 `SendMessage` 同一 agent 并把任务压到 20–40 行分段。无法证明中断前已闭合 finding，因此不投证伪票；但它再次说明“不指定报告文件时，任何已完成思考都只能赌最终 return”。｜结论：数据不足
- **V8 正交视角** — ⚠️ 本轮是两个先后 reviewer，但第二位承担的是前一位 transcript 物理不可达后的替代复核，不是预先设计的正交视角，因此不计入 V8 分母。逐轮增量仍显著：合并态最后又抓出 debug 无 token 分支缺 oracle。｜结论：数据不足
- **V9 鉴别力正控** — ⚠️ 规格中的每类新 gate 都写了目标 mutation，尤其合并态评审补出的 debug 三类 mutation、配置事务三类 mutation、proxy 旧预采样 mutation；实现尚未开始，均明确保留为执行期 gate，没有把“写了 mutation”冒充已实测红。事实观察成立，但本轮追加本日志本身已编辑 `.claude/skills/session-closeout/`，按第 11 行投票规则不得投证实票。｜结论：数据不足
- **投票规则结构缺陷** — 当前第 11 行把“本轮编辑过该目录”一律判为不能投证实票，而本 skill 又要求每次使用后追加本目录内的 `verification-log.md`；两条合用会使任何按要求记录的会话都无法投证实票。该冲突需由独立的规则维护任务裁决：可选方向是明确排除“仅追加 verification-log”，或由外部记录者落票。本轮不修改 instruction text，避免在产品规格收尾中顺手改变全局流程。｜结论：待裁决

## 2026-08-06 · 上游空正文 HTTP 499 有界重试（sha `d2607ec9`）

- **V9 鉴别力正控** — ⚠️ **强观测但不投证实票**。本轮新增 classifier → production retry registry → driver 三层判据；先观察旧实现因 499 被分类为 `bad_request` 而三层红，再把目标机制精确变异为 `status === 498`，三层测试分别在分类结果、策略认领和 1000ms backoff／第二次 transport 调用处再次变红；反向应用冻结 patch 后三层恢复为绿。负向样本同时锁定非空 499 保持 `bad_request`、空正文 401/403 保持 `auth_expired`。本轮按本 skill 要求追加该 verification log，因而命中投票规则第 11 行“编辑过该目录”，只记录客观观测。｜结论：数据不足（正控已实际改变并验证测试形状）

## 2026-08-08 · History V3 落盘重试默认值（sha `a61bcbd7`）

- **V1 触发链** — ✅ 正向观测。触发原因是实现、全后端验证与两个语义提交完成后准备交付；主会话主动调用本 skill，没有等待用户提醒，也没有先宣告完成。因本轮按 self-verification 协议追加该 log，依第 11 行不投证实票。｜结论：数据不足
- **独立审计限制（历史时点）** — 当时运行时明确禁止在用户未请求时调用 Agent，因此 §1 subagent audit 未执行；该轮只完成主会话 diff／契约审查，没有把它表述为独立评审。用户已于后续冲突解决轮明确授权主动运行 subagent，本条只记录当时限制。

## 2026-08-08 · upstream-silence recovery 本地集成与清理（sha `e45536af`）

- **V1 触发链** — ❌ 用户明确要求“收尾和清理”后才调用本 skill；前一轮虽已主动完成评审、doc-sync、提交和本地 fast-forward，但没有在首次宣告完成前加载本 skill。命中“用户点名”负样本。｜结论：证伪
- **V7 闭环提交时点** — ⚠️ 本轮没有新建 HANDOVER／KICKOFF 或实验目录；现有四份 live 状态文档先经独立 reviewer 0 blocker／0 major，再精确提交为 `e45536af`，随后碰撞集 4 paths × 15 peer dirty paths = 0 才 ff-only 到共享 master。`git diff-tree -r e45536af` 精确包含这四份文档。因本轮追加 verification log，不投证实票。｜结论：数据不足
- **V8 正交视角** — ⚠️ 本轮沿用同一 merged-state reviewer 多轮复评，并未预设两个正交 closeout 视角，不计入 V8 分母。事实观察：该 reviewer 先后抓出 bundled timeout 违冻结不变量、real open block gate、Worker owning reset、per-model warning、DESIGN 漂移五类问题，整改后 0 blocker／0 major。｜结论：数据不足
- **V9 鉴别力正控** — ⚠️ 新增的 real text/tool block-start gate、scalar/per-model bounded-wait 告警与 Worker reset race 均先见目标红再恢复绿；Chat H3 配置顺序依赖亦稳定复现后连续 10 轮通过。因本轮编辑该 log，只记观察。｜结论：数据不足
- **V14 活跃写入权收口（旧标题“ 双事实源收口”已 superseded）** — ✅ 陈旧 project memory 当时缩成指向 `DESIGN.md`／implementation report／spec 的 stub，并明确 feature 已合并、worktree/branch 已删除；这证明它不再独立维护活跃实施进度。该历史动作不表示 memory 只能留裸指针：按新规则，memory 可完整保留读者所需语境，但须引用权威来源且不继续作为状态写入点。因本轮编辑该 log，不投证实票。｜结论：数据不足

## 2026-08-08 · History Worker Batch 1b 主线收口（核验基线 `775b5fb5`）

- **V1 触发链** — ⚠️ 客观事实是用户明确发出“已合并，收尾”后，本会话才调用本 skill；此前虽已完成代码、门禁、评审与主线 fast-forward，但没有主动走完六步。不过 V1 只断言“上下文快满、任务没完”时的触发链，本轮属于普通完成收口，不在其适用域，故不计 V1 分母。｜结论：数据不足
- **V12 每 commit 更新** — ❌ 按 progress frontmatter 的 `base=90e777bc…` 用正文规定的 `--first-parent` 口径审计 15 个提交，发现 5 个含实现／状态改动但未同时更新 `docs/tmp/2026-08-08-history-worker-progress-impl-1b.md`：`cca342ff`、`df0c7bf4`、`94205e89`、`0415646e`、`d3b4ac77`。缺口集中在评审整改、floor 校准与最终文档／合并点，说明后半程退化成一次性收口更新。最终进度内容已完整回填，但不改变该过程判据失败。｜结论：证伪
- **V14 活跃写入权收口** — ⚠️ `542007c9` 把 progress frontmatter 改为 `batch-1b-integrated-master-d3b4ac77-superseded-by-plan`，正文明确“已完成并停止更新”，八项待办全为 `[x]`；正式计划 Batch 1b 状态行成为活跃写入点。原文档 reviewer 逐条核验 C1～C6 后判 0 blocker／major。因本轮追加本日志，只记事实。｜结论：数据不足
- **V7 闭环提交时点** — ⚠️ `git diff-tree --no-commit-id --name-only -r 542007c9` 精确列出正式 plan、Batch 1b progress、评审处置三路径；三个文件内的 `d3b4ac77` 状态锚点均由 `git show 542007c9:<path> | rg` 命中。`775b5fb5` 只更新 kickoff，把执行入口推进到 Task 2a；独立指令 reviewer 已判 kickoff 可合、0 blocker／major。记录形成时本轮收尾提交尚待 fast-forward 合入共享 `master`，最终落地由 Git ancestry 外部裁决，不据本条投证实票。｜结论：数据不足
- **V6 权威引用＋语境复述** — ⚠️ progress 明确引用正式 plan 的 Batch 1b 状态行并停止更新；kickoff 以 `REVIEWED_PLAN_COMMIT=542007c9…`绑定同一 plan blob，同时完整复述 Task 2a 的启动门、首个 red test、crash windows 与证明边界。独立指令 reviewer 逐条核验 K1～K6 后判 kickoff 可合、0 blocker／major；本轮追加该日志，故仍不投票。｜结论：数据不足

## 2026-08-08 · History Worker Batch 1b 收尾证据终审（核验基线 `43ffac97`，`master@d1011fe7`）

> **本节所有条目一律不投证实票**：本会话已多次编辑 `.claude/skills/session-closeout/`（`2ad229ed`、`044170e1`、`794abd4e`，本节亦是新编辑），命中第 11 行判据。起草时我一度写了三张 ✅ 证实票，随后自查规则撤回——这正是该规则要防的自评污染。

- **V8 正交视角带来增量覆盖** — ⚠️ 强观测，不投票。两个视角的 major **零重叠，且各自都改变了我的动作**。「接手方第一人称走查」视角产出 H1／H2（禁止在 Batch 1b 分支继续 Task 2a、安装位置步骤缺可执行命令与提交-确认闭环），全部落在「接手方会照着做出什么错误动作」；「事实证伪」视角（另派**未卷入**实例、跨模型）产出 D1／D2（冻结判据只要求说明字节来源守不住不变量、Git 顺序门约束不了 harness job cleanup），全部落在不变量与门的鉴别力。**若不派第二个视角会漏掉的具体东西**：D1 的 false-green 反例（`history-worker-batch-1b-wip.patch` 同路径被覆写为含未提交修复 → 新判据放行 → job cleanup 删掉唯一副本）与 D2 的执行接缝缺失，两者都不在接手视角主责范围内，却直接决定未提交工作会不会丢。反向亦成立：事实视角没提出 H1，而 H1 防的是下个会话在错误分支上开工。｜结论：数据不足
- **V7 闭环提交时点** — ⚠️ ①**起草前的机械检查这次真跑了，原样输出如下**（本表历史上在此假绿过一次，教训是「粘不出输出就等于没跑」）：
  - `git ls-files --error-unmatch -- <4 份接收者>` → 四行全部列出（`...closeout-review-final.md`、`...review-dispositions.md`、`...progress-impl-1b.md`、`tests/infra/entry-test-discovery-baseline.json`），无 `did not match` 报错。
  - `git status --porcelain -uall -- <同 4 份>` → 仅 ` M docs/tmp/2026-08-08-history-worker-batch-1b-closeout-review-final.md` 一行（reviewer 刚追加的复审节，随后即提交），其余三份为空。
  - `git check-ignore -v -- <同 4 份>` → 无输出、`exit=1`，四份均未被 ignore（本表两次抓到过 `exp/` 被 `.gitignore` 静默覆盖的假绿形态，本轮不适用）。
  ②评审放行后：`43ffac97` 的 `git diff-tree --no-commit-id --name-only -r` 精确为三份收尾产物，reviewer 报告本身作为 durable receiver 一并落盘。｜结论：数据不足
- **新增负样本（不在自验表内，建议入表；按第 93 行先例处理）** — **「把不可控的平台生命周期事件写成受控 Git 门」**。**这不是对 V7 的证伪**——V7 断言的两个提交时点本轮都做到了；它命中的是 V7 **覆盖不到**的一层：V7 盯「产物有没有进提交」，盯不到「我给清理设的前置条件在物理上能不能被执行」。本轮该错误还被**逐行复述了 56 遍**（清单每行「清理前置」列），单看任一行都像已有 disposition，正是「判据之间留缝」而非「某条判据写错」。可执行改法：凡写下「X 必须晚于 Y」，**先声明它是哪一型**，再按该型判——**状态门**：每个 X 入口的放行都控制依赖于该 Y 谓词（只读不判的旁路 observer 不算）、谓词在放行点仍有效、Y 读不到时阻断（fail-closed）、以原子 check-and-act／lease／锁或 Y 单调性消除竞态；其中**「权威」按可验证的一致性契约定义、不按物理载体**——线性一致读副本、lease 保护的 materialized state、带 generation 且放行时校验的快照都合格，拒绝的是未经验证、可能滞后的副本。**因果／capability 门**：permit／event 只可能由 Y 成立而产生、不可伪造或旁路取得、**每个 X 入口都必须消费它**——此型**不要求**放行时再读 Y 的真相源。两型共同验收**必须隔离目标门**（X 往往有多个前置，**不能假定 Y 是 X 的充分条件**）：负控＝固定其他前置、只翻转 Y，X 被阻断**且阻断 provenance 命中目标门**（否则兄弟门代咬，连不读 Y 的假门都能通过）；正控＝其他前置全满足时**该 Y 门不再阻断 X**（不是「X 一定发生」，否则误杀合法多前置门）；再加**入口全集**与**只破坏目标 gate／permit** 的失效对照（须变红且失败位置命中目标机制）。两型都不成立就消门（让 X 提前发生也无害）。**这条判据被独立 reviewer 连打四轮、方向各不相同**（收在直接执行者上→误杀因果门；放松成「有谁读过 Y」→放行旁路日志与 fail-open；四条全局合取→又误杀 capability 门；共同双控未隔离目标门→兄弟门代咬），根因是想用一条判据管两类形状不同的门；**判据反复朝相反方向被打回时，先去分型，别继续调措辞**。已立记忆 [[methodology-ordering-gate-needs-a-trigger-that-reads-it]]。｜结论：新形态，待独立评审后决定是否入表
- **V10 与冻结上游文档对账会被触发** — ⚠️ 触发有效，不投票。本轮抓到实质冲突：kickoff 的 `REVIEWED_PLAN_COMMIT` blob 门与「每批回填 plan 状态」构成两阶段时序，回填后旧 anchor 必然失效。处置是保持门 fail-closed、复审新 plan 提交、再由单独提交 `64e40640` 更新 anchor，而非放宽或移除门。｜结论：数据不足
- **V9 新判据写鉴别力正控** — ⚠️ 本轮新增的 initialize 四字段判据有明确目标变异且**已实测**：旧 protocol 缺 `maxBackoffMs` 时 15 pass／1 fail，补第一项后缺 `maxTotalMs` 仍 15 pass／1 fail，完整 validator 落地后 68 pass／0 fail；终审 reviewer 独立复核确认删除任一目标 validator 后对应 `toThrow` 会红、不会由旁路断言代咬（其实跑 16 pass／0 fail）。Task 2a 的 `maxBackoffMs` 真实 backend 消费 mutation 尚未实现，明确留成执行期 gate。｜结论：数据不足
## 2026-08-08 · HTTP/2 header deadline 阶段 1 收尾（分支 tip `f0cb1f1e`，master 核验基线 `d1011fe7`）

- **V1 触发链** — ❌ 负样本。用户说「完成了开始收尾」之后我才加载本 skill；在此之前我已用 `result:` 宣告过阶段 1 交付完成，却没先走六步。命中「用户点名」。｜结论：证伪
- **V4 查-peer 配方** — ✅ 配方按路径口径跑通且给出了有判别力的答案：`git log --oneline HEAD..master -- src/lib/transport src/lib/fetch-utils.ts src/lib/models/timeout-resolver.ts docs/spec/2026-08-06-*.md` 零命中，而同期不限 path 的 `HEAD..master` 有 16 条（全是 History worker／skill 文档）。零命中在此是**正确结论**而非配方失灵——正因为它把无关的 16 条排除掉了。因本轮追加本 log，依第 11 行不投证实票。｜结论：数据不足
- **V8 正交视角** — ✅ **计入分母**：派活前就写死两个视角与各自证据义务（判据证伪 / 接手方第一人称走查），不是先后替补。**各自都有独有且改变动作的发现**——判据视角独有：plan 注解 sha 口径错、KICKOFF 数字锚错树、记忆里的 `14475` 复现不出（实测 `14541`）；接手视角独有：**T1 的证伪方法根本不成立**（`package-boundaries.unit.test.ts` 三个检测器只匹配 import specifier，不检测同名类型复制），以及交接文档尚未进 master 导致「从 master 建树就找不到 HANDOVER」。若只派判据视角，那条 major 会漏——它只有靠「实地打开那个测试看它到底检测什么」才暴露。因本轮编辑该 log，只记客观观测。｜结论：数据不足（但分母 +1，独有发现双向成立）
- **V9 鉴别力正控** — ⚠️ 初稿 T1–T3 写了「待执行期跑」的目标变异、T4 只写了验收判据的否命题（漏正控）。**证伪发生在评审中**：T1 那条不仅缺正控，其证伪方法本身不成立。整改后 T1 补了守卫真实边界说明、T4 补了三种具体 mutation（只等第一道 barrier／从 `errorSnapshot` 读 tag／logical terminal 当场 settle）。**教训：写「证伪方式」时必须去打开那个守卫确认它真的检测那件事，不能从测试文件名推断能力。**｜结论：数据不足
- **V10 上游对账触发** — ✅ 触发并逐份 disposition：block-level buffered retry ADR（依据未被拆，无需重裁）、旧 `protect_streaming_generation`（用户已裁「不启用、未来删」，列为独立后续项）、2026-08-06 系列交接（其「CANCEL 主线未实施」表述已被阶段 1 部分推翻，写明以 spec 状态节为准）。检索词与范围已落盘在 HANDOVER 的对账节。｜结论：数据不足
- **V16 property→acceptance 对账** — ⚠️ 本轮 HANDOVER 的 T1–T4 就是该表的实例：**抓到 1 处真漂移**——T4 的性质写「三条 settlement 路径都写入**最终**observation」而验收只写「三条路径都写了字段」，量词一致但**排除项不同**（没有排除「写了中间值」），三种 mutation 正落在这个缝里。证明该对账不是零命中的仪式。｜结论：数据不足
- **V19 job tmp 逐文件 manifest** — ⚠️ 数据：枚举 **42 项**顶层条目（`-maxdepth 1 -mindepth 1`；⚠️ 换成 `-maxdepth 2` 得 49 行，是**另一个量**，别混），manifest 覆盖 42/42，判定须入项目 **12 项**（落 `exp/http2-cancel-provenance/`，commit `216a2187`），清理前复扫**新增 0 项**（故先前评审未作废），清理后残留 **0 项**。两项机械判定：① 枚举**发生在最终报告之前**；② 删除发生在「载体已提交且逐文件 `git hash-object` == `git rev-parse 216a2187:<路径>` 12/12 相等 + 两份独立评审 0 blocker/major」**之后**，且按 exact path 逐项删、无通配符展开。**manifest 确实抓出了未持久化产物**——12 个探针/变异件当时只存在于 tmp，不做这一步会随 job 删除一起消失，而 spec §6 的冻结约束正引用它们的结论。**同时暴露 skill 自身的一处坑**：`exp/` 被 `.gitignore` 忽略，`cp` 进去后 `git status` 仍干净，「已归档」差点被当成事实——V7 的三条谓词（`ls-files --error-unmatch` / `status -uall` 为空 / `check-ignore` 不命中）里正是第三条抓住它。因本轮编辑该 log，只记客观观测。｜结论：数据不足
