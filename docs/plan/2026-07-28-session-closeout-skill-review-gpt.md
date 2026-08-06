# session-closeout skill 合并——独立评审（GPT）

## 结论摘要（四轴各一行 + 总体判定）

- **评审范围**：提交 `1fa01c6b` 与 `ed455b9d` 对 `.claude/skills/session-closeout/SKILL.md`、`.claude/skills/empirical-verification/SKILL.md`、`CLAUDE.md`、`docs/coding-conventions.md`、两条 memory stub、`docs/memory/MEMORY.md` 以及 keepalive `HANDOVER.md`/`KICKOFF.md` 的改动；同时按要求主动扫描 skill、memory、plan/spec、项目指令与 user-level rule 中的收尾/交接方法论残留。
- **已读取/执行的证据**：完整读取两个提交 diff 与上述最终文件；读取 `docs/DESIGN.md`；执行带正样本的多组 `rg` 检索、文件名扫描、wiki/Markdown 目标存在性检查、六步计数、frontmatter 大小检查、`git diff --check`、提交与符号溯源，并对 `separator_accept_extra` 的真实消费者追到 `stripAllThinking()`。
- **全面性：FAIL**——至少 7 个活的 plan/kickoff 仍把通用流程写成“收尾五步”，另有多份 plan 重述通用步骤；新 memory stub 和 `CLAUDE.md` 触发器也保留了超出“索引指针”的 how-to，尚未完成用户要求的“全面总结、补充、合并、移入，不要散落”。
- **完整性：FAIL**——§6 覆盖了入口、事实、待办、错误、产物和 KICKOFF，但没有定义交接文档的 supersede/关闭生命周期、接手方消费后的动作、多个并发交接的合并/优先级、HANDOVER 与 KICKOFF 的去重边界，也没有把 repo 精确状态作为必填项。
- **自洽性：FAIL**——skill 正文仍写“CLAUDE.md 触发器（五步名）”；多个指向 CLAUDE/user-rule 的锚点不存在；“产物必须提交”与“先 `git add` 再引用”的可执行动作不一致；coding convention 的“整体 trim 后全等”与真实前缀族识别冲突。
- **符合预期：FAIL**——方向正确，但单一事实源没有真正收口；此外 `emit-closed / accept-open` 被写成无条件安全的通则，实际开放识别值会进入删除路径，超出了代码事实能支持的范围。
- **总体 verdict**：**修复 HIGH 后可进入下一阶段**。未发现 blocker；blocker 数量 **0**。发现计数：HIGH 4、MED 6、LOW 1。

## 检索取证（命令、正样本对照、覆盖路径）

### 1. 正样本对照与主检索

先用一个已知必命中的精确短语验证检索链路：

```bash
rg -n --fixed-strings '跨会话交接 —— HANDOVER + KICKOFF' \
  /home/xp/src/copilot-api-js/.claude/skills/session-closeout/SKILL.md
```

输出：

```text
43:## 6. 跨会话交接 —— HANDOVER + KICKOFF
```

证明 `rg` 的路径与编码均可触达目标后，再执行主检索：

```bash
rg -n -i '(收尾|交接|HANDOVER|KICKOFF|归档|doc-sync|记忆库|提交前|closeout|handover)' \
  /home/xp/src/copilot-api-js/.claude/skills \
  /home/xp/src/copilot-api-js/docs/memory \
  /home/xp/src/copilot-api-js/docs/coding-conventions.md \
  /home/xp/src/copilot-api-js/CLAUDE.md \
  /home/xp/src/copilot-api-js/docs/plan \
  /home/xp/src/copilot-api-js/docs/spec \
  /home/xp/.claude/rules/00-user
```

覆盖结果：

```text
.claude/skills       files=12   hits=44
docs/memory          files=28   hits=58
docs/plan            files=212  hits=846
docs/spec            files=44   hits=148
user-level rules     files=2    hits=3
```

上述命中量很大，不能把每个命中都判成散落。我继续按“通用 how-to”与“实例状态/路径引用”分型：

- **应移入 skill 的通用 how-to**：把 `session-closeout` 明说成五步、复述五步顺序、规定 HANDOVER/KICKOFF 通用组成、规定通用交接生命周期的文本。
- **允许留在原处的实例内容**：某个具体 task 的入口、事实、待办、验收、测试命令、路径、踩坑；某个 plan 的 feature-specific doc-sync 清单；历史归档中的完成叙事。
- **允许留在 user-rule 的触发条件**：`handover-if-context-window-almost-full` 只说明何时交接，不说明如何写，符合 skill §6 的 when/how 分工。

### 2. 通用“五步”残留的精确检索

```bash
rg -n -C 2 '(收尾五步|走收尾五步|按 skill `session-closeout` 五步)' \
  /home/xp/src/copilot-api-js/docs/plan \
  /home/xp/src/copilot-api-js/docs/spec \
  /home/xp/src/copilot-api-js/.claude/skills \
  /home/xp/src/copilot-api-js/docs/memory \
  /home/xp/src/copilot-api-js/CLAUDE.md
```

确定命中的通用流程残留包括：

```text
docs/plan/reactive-upstream-rejection-KICKOFF.md:53
docs/plan/reactive-upstream-rejection/prompts/README.md:33
docs/plan/2026-07-14-graceful-restart.md:1731
docs/plan/2026-07-14-request-timing-instrumentation.md:626
docs/plan/2026-07-27-doc-staleness-sweep-kickoff.md:79
docs/plan/2026-07-12-upstream-hook-middleware/plan-kickoff.md:25
```

另有未写“五步”字样但逐项重述旧五步的明确实例：

```text
docs/plan/live-inflight-dock-kickoff.md:19
docs/plan/2026-07-08-response-content-preview.md:1318
```

其中 `2026-07-14-graceful-restart.md` 和 `2026-07-14-request-timing-instrumentation.md` 已标 landed，属于历史执行计划；它们可以保留 feature-specific 历史任务，但不应继续声称当前 canonical skill 是“五步”。其余 kickoff/README 仍可能被复制执行，错误影响更直接。

更宽的顺序检索找到约 27 个候选文件；我没有把它们全部报成问题。像 `docs/plan/2026-07-23-upstream-silence-recovery/plan-5-closeout.md` 中的 feature-specific sink/doc/backlog 清单属于计划本身的验收内容，可以保留；只需把通用流程部分改成指向 skill。

### 3. HANDOVER/KICKOFF 文件扫描与生命周期取证

由于运行时没有 `fd`，最初 `fd` 命令返回 `exit 127`；随后按环境规则改用只读 `find`/`git ls-files`：

```bash
git -C /home/xp/src/copilot-api-js ls-files docs/plan \
  | rg -i '(^|/)[^/]*(handover|handoff|kickoff|kick-off|closeout)[^/]*\.md$'

git -C /home/xp/src/copilot-api-js ls-files docs/plan \
  | rg -i '(^|/)[^/]*(handover|handoff)[^/]*\.md$'
```

结果：tracked handover/kickoff/closeout 文档 **47** 份，其中 handover/handoff **11** 份。11 份中同时存在活入口、部分完成、已 supersede 的历史段和 review 报告；命名也混有 `HANDOVER`/`HANDOFF` 与单文件 `*-handover.md`。这不是要求把实例文档都搬进 skill，而是证明 §6 需要一个“哪个入口当前有效、何时 supersede/关闭旧交接、多个交接如何汇合”的生命周期契约。

对 §6 本身检索以下概念：

```bash
rg -n '(接手方|多个交接|并发交接|KICKOFF.*重复|HANDOVER.*重复|交接.*归档|交接.*关闭|当前分支|工作区状态|未提交改动|commit hash|HEAD)' \
  /home/xp/src/copilot-api-js/.claude/skills/session-closeout/SKILL.md
```

输出为空；“陈旧”只出现在写之前跑 `git log` 的预防动作，没有写成已发布交接的更新、supersede 或关闭规则。

### 4. 六步、链接、锚点与提交事实核对

六个标题真实存在：

```text
10:## 1. subagent audit —— 交付前独立核验
14:## 2. doc-sync + 验证
24:## 3. 归档 plan —— 迁 docs/plan + 头部实施状态注解
35:## 4. 提炼教训 + 维护记忆库
39:## 5. 细粒度提交
43:## 6. 跨会话交接 —— HANDOVER + KICKOFF
```

所有新增 wiki 目标均存在且 basename 唯一：

```text
methodology-background-agent-result-surfacing-failure: EXISTS
methodology-probe-conclusion-scope-and-peer-invalidation: EXISTS
feedback-pass-null-clean-not-self-validating: EXISTS
feedback-verify-deferred-task-not-already-landed-before-designing: EXISTS
```

新增 Markdown 目标也存在：

```text
.claude/skills/session-closeout/complete-plan.md: EXISTS
exp/keepalive-escalation-wire/README.md: EXISTS
docs/spec/2026-07-26-thinking-terminal-block-layout.md: EXISTS
```

但以下被 skill 当成 CLAUDE/user-rule 锚点的名字在当前实际文件中没有命中：

```text
always-on-not-background: no match
knowledge-routing: no match
fine-grained-staging-per-phase-commit: no match
concurrent-sessions-line-coexistence: no match
user-rule 70 / 70-save-knowledge: no corresponding file in ~/.claude/rules/00-user/
```

相邻的真实项目规则名分别更接近 `session-closeout`、文档路由章节、`细粒度、每阶段提交`、`concurrent-sessions 行级共存`。

两个提交均通过：

```bash
git diff ed455b9d^ ed455b9d --check
git diff 1fa01c6b^ 1fa01c6b --check
```

frontmatter 也未超过 agentskills 1024-byte 上限：`session-closeout` 561 bytes，`empirical-verification` 615 bytes。

### 5. `emit-closed / accept-open` 与代码对账

真实实现为：

```text
src/lib/anthropic/sanitize/block-layout-contract.ts:78-80
const text = block.text.trim()
return text.startsWith(SYNTHETIC_SEPARATOR_PREFIX)
  || BUILTIN_ACCEPTED_SEPARATORS.has(text)
  || extraAccepted.includes(text)
```

消费者不是只读分类器：

```text
src/lib/anthropic/strip-all-thinking.ts:21-23
isStrippableBlock(...) -> isSyntheticThinkingSeparator(...)
```

也就是说，`separator_accept_extra` 扩大识别面后，命中的普通文本会被 `stripAllThinking()` 删除。它在“识别集合”上单调，但不代表在用户数据语义上无害。

提交 `883e0533` 也已独立核实存在，确实修改 `src/lib/anthropic/recover-tool-call/stream.ts` 并增加保留空 streaming delta 的测试，因此 empirical-verification §② 的核心案例有提交事实支撑。

## 发现（逐条：编号 / 严重级 CRITICAL|HIGH|MED|LOW / 位置 file:line / 事实 / 为什么是问题 / 建议）

### F1 / HIGH / `docs/plan/reactive-upstream-rejection-KICKOFF.md:53` 等 7+ 处

**事实**：仓库仍有多份通用收尾 how-to 写成“五步”，其中至少 6 处逐字声称 canonical `session-closeout` 是五步，另有多份文件逐项重述旧五步。确定位置见检索取证 §2。

**为什么是问题**：这直接违反本轮最核心的用户要求“全面总结、补充、合并、移入 skill，不要散落”。更严重的是它们不是无害副本，而是已与六步 skill 漂移；复制这些 kickoff 的接手会话会跳过跨会话交接。即便 landed plan 作为历史记录保留，也不应继续把动态 canonical 流程冻结成“五步”。

**建议**：由 `gpt-souls:instruction-smith` 或 `gpt-souls:doc-writer` 做一次机械迁移：通用部分统一改成“按 skill `session-closeout` 执行”，只保留每个 plan 的 feature-specific 验收/doc-sync loci；历史 landed plan 若需保留原执行事实，明确标注“当时为五步，当前流程见 skill”，不要伪装成当前规则。完成后用上述精确检索做正样本对照，再要求“五步”活引用归零或逐项豁免。

### F2 / HIGH / `docs/memory/session-closeout-and-handover.md:10-16`、`docs/memory/MEMORY.md:7`、`CLAUDE.md:54`

**事实**：新 stub 自称“只留触发钩子”，但 line 14 仍重复交接落点、主树提交、三条最易漏规则和 `git log` 命令；MEMORY 索引重复待办/证伪/错误规则；CLAUDE 触发器重复路径、`/tmp` 入库、验收与错误记录等 how-to。

**为什么是问题**：这是本轮自己定义的单一事实源边界被自己突破。触发器保留“六步名字 + skill 指针”合理，但这些具体写法会与 skill 独立漂移；事实上 skill line 58 写的是“先 `git add`”，CLAUDE/stub 写“先入库/主树即时提交”，已经出现语义层级差异。

**建议**：memory stub 与 MEMORY 只保留“什么时候触发 + skill 名”；CLAUDE 只保留六步名称和指针。why/战例可以留在 stub，但 How to apply 不应重述可执行规则。若担心检索触发弱，可列关键词，不复制规则正文。

### F3 / HIGH / `.claude/skills/session-closeout/SKILL.md:43-63`

**事实**：§6 没有定义已发布交接的生命周期与消费协议。缺少：① repo 精确状态（基线 commit、当前分支/worktree、未提交/未追踪文件、已跑测试及结果）；② 接手方读完后的第一组核验和状态回写；③ 多个并发/主题重叠交接的权威入口与合并规则；④ HANDOVER 与 KICKOFF 的内容分工和允许重复边界；⑤ task 完成后对交接的 closed/superseded/archive 处理。仓库已有 11 份 tracked handover/handoff，实际存在活、部分完成和历史 supersede 混合状态。

**为什么是问题**：没有这些规则，交接文件会迅速变成“日期新但断言旧”的权威声音；多个入口并存时，接手方无法判断该读哪份，完成后旧 KICKOFF 仍可被再次执行。用户点名要求完整考虑的四个边界均未覆盖。

**建议**：扩成明确模板：

1. `HANDOVER` 必填 `as-of commit`、分支/worktree、dirty/untracked 清单、已跑门禁与精确结果、当前唯一入口和 supersedes/superseded-by。
2. 接手方起手先核 `HEAD`、`git log <as-of>..HEAD -- <相关路径>`、活文档状态，再把交接状态更新为 `accepted/in-progress`。
3. 同主题已有交接时更新现有 canonical 文件或建立显式 supersession 链，禁止并列自称“唯一入口”。
4. `HANDOVER` 存完整状态和证据；`KICKOFF` 只存可复制的启动指令、入口链接、硬约束与第一步，不复制事实正文。
5. 全部待办关闭后标 `closed` 并指向 landed/权威现状；历史材料按项目归档规则处理，不能继续充当活入口。

### F4 / HIGH / `docs/coding-conventions.md:19-21`

**事实**：文档把开放识别轴描述为“永远不可能造出非法输出”“迁移与回滚零成本”。但 `separator_accept_extra` 的真实消费者会把识别命中的块交给 `stripAllThinking()` 删除；任意配置一个与合法用户文本相同的值，会把合法数据误判成我方合成物并删除。

**为什么是问题**：这里把集合单调性误写成语义安全性。开放识别面不会改变 emitter 的 wire 取值，但会改变 destructive consumer 的行为；它可以造成数据丢失或语义改变。作为泛化 convention，这个错误会诱导未来把 accept-open 用在更危险的分类器上。

**建议**：把规则收窄为“emit closed；accept 可扩展但每个新增值必须是明确、碰撞抗性的历史/第三方标识，并审计所有消费者是否 destructive”。明确“单调”只指识别集合，不代表业务副作用单调安全；回滚成本是降低而非无条件为零。为 `separator_accept_extra` 增加碰撞/删除路径的测试或配置约束属于实现侧后续，可交 `gpt-souls:implementer`。

### F5 / MED / `docs/coding-conventions.md:21` 对 `src/lib/anthropic/sanitize/block-layout-contract.ts:78-80`

**事实**：convention 断言“识别比较用整体 trim 后全等，不做子串匹配”，而真实 built-in family 使用 `text.startsWith(SYNTHETIC_SEPARATOR_PREFIX)`；只有 legacy set 与 `extraAccepted` 是全等。

**为什么是问题**：文档把“用户配置的额外值”规则泛化成整个识别器规则，和代码/规格的未来版本前缀族设计冲突。后续实现者可能按 convention 删除 prefix-family，破坏旧版本识别未来 carrier 的既定行为。

**建议**：分开表述：配置扩展值与 legacy literal 为 trim 后全等；受控、带封闭命名空间的 built-in version family 可以做前缀匹配。不要用“任何识别都全等”的绝对句。

### F6 / MED / `.claude/skills/session-closeout/SKILL.md:8`

**事实**：同一句先写“下面六步”，后写“CLAUDE.md `session-closeout` 是 always-on 触发器（五步名 + 指向本 skill）”。CLAUDE 当前实际列六步。

**为什么是问题**：这是直接的内部矛盾，也是本轮“五步→六步”改造漏改的承重位置。

**建议**：改为“六步名 + 指向本 skill”，并用全仓“五步”检索一起收口。

### F7 / MED / `.claude/skills/session-closeout/SKILL.md:8,37,41,67`

**事实**：skill 引用 `CLAUDE.md always-on-not-background`、`knowledge-routing`、`fine-grained-staging-per-phase-commit`、`concurrent-sessions-line-coexistence` 和 `user-rule 70`，但当前项目/用户规则中不存在这些精确锚点或编号文件。

**为什么是问题**：本轮主张“具体命令放别处、skill 用指针”，因此指针可解析性是可执行性的前提。读者无法按这些名字定位单一事实源，只能猜相邻章节。

**建议**：改用当前真实标题/规则名，或使用稳定文件路径 + 章节标题，例如 CLAUDE 的“细粒度、每阶段提交”“concurrent-sessions 行级共存”“文档路由”；user-level 文档管理直接指向现存 `41-doc-mgmt.md`。增加一个文档守卫校验 skill 中的项目内 Markdown 链接；反引号伪锚点若继续使用，至少做显式清单检查。

### F8 / MED / `.claude/skills/session-closeout/SKILL.md:56-59`

**事实**：标题要求“产物必须进仓库并提交”，正文给出的承重动作却是“先 `git add` 再写引用它们的交接”。`git add` 只进入 index，不等于形成 commit；共享 worktree 下 index 还是并发共享状态。

**为什么是问题**：该规则的目标是重启、清理和并发下可恢复。仅 staged 不能兑现“已提交”的耐久边界，也与提交信息中“artifacts must be committed BEFORE the handover cites them”不一致。

**建议**：把原子顺序写清：先把被引用产物以独立细粒度 commit 落库并记录 commit id，再写 HANDOVER/KICKOFF 并即时提交第二个 commit；若必须同一 commit，则交接不得声称引用对象已提交，只能声明“随本 commit 一并落库”，并在提交后核验 `git show --stat HEAD`。不要把 `git add` 写成 durable milestone。

### F9 / MED / `.claude/skills/session-closeout/SKILL.md:47`

**事实**：skill 在指向 `git-preference:isolating-from-a-shared-git-worktree` 的同时，又复制了 `git worktree add ...` 与 `bun install` 命令；KICKOFF 也复制同一命令。用户要求检查“git 暂存命令、worktree 操作应是指针而非副本”。

**为什么是问题**：worktree 操作细节有自己的单一源，未来分支命名、目录约定或 install 行为变化时会漂移。KICKOFF 作为某次任务的直接启动命令可以保留实例化命令，但 canonical closeout skill 不应复制另一个 skill 的 how-to。

**建议**：session-closeout 只规定分工与 required sub-skill，删除命令副本；具体 KICKOFF 可保留针对该任务已实例化的命令，并明确它是任务输入而非通用规则。

### F10 / MED / `.claude/skills/session-closeout/SKILL.md:3`

**事实**：frontmatter description 不只描述触发条件，而是完整摘要六步及多个关键动作。它虽未超 1024-byte 上限，但与 skill authoring 的 discovery 原则冲突：description 应说明“何时加载”，不应让 agent 能只读 description 就跳过正文。

**为什么是问题**：description 已经列出足够多流程，agent 很可能执行摘要而漏掉正文边界；本轮恰好新增了需要读正文才能得到的 §6 细节，却进一步扩大摘要捷径。

**建议**：description 只保留触发条件，例如“当 copilot-api-js 会话/阶段收尾、交付、ExitPlanMode、提交前或任务需跨会话继续时使用”；六步内容放正文 overview/quick reference。若项目刻意偏离该 authoring 规范，应在 skill 规范中记录例外理由。

### F11 / LOW / 两个 skill 改动的验证证据

**事实**：提交内容中未见针对 skill 行为的 RED/GREEN pressure scenario 或应用场景验证记录；只能确认文本、链接与事实对账，不能确认 agent 实际会按 §6 生成完整交接。

**为什么是问题**：这是 instruction 文本，静态自洽不等于可执行。尤其 §6 有多个“必含”字段，最适合用新会话压力场景验证是否遗漏。

**建议**：由 `gpt-souls:instruction-smith` 补最少三类场景：上下文将满且有未追踪产物、两个同主题交接并存、接手后发现 HEAD 已前进；验证生成物是否包含状态、证据、supersession、验收与关闭动作。此项目前是“未见证据”，不是断言作者从未做过外部测试。

## 我不认为是问题的（列出你考虑过但判定合格的点，防止下一轮重复讨论）

1. **user-level `handover-if-context-window-almost-full` 可以留在 user rule**。它只规定 when，不复述 how；与 §6 的分工成立，不算散落。
2. **具体 HANDOVER/KICKOFF 保留任务事实、路径、待办、测试门禁和本轮踩坑是必要的**。这些是实例数据，不是通用方法论副本；不能为了“单一源”把交接文档掏空。
3. **keepalive HANDOVER §4 改成指向两个 skill、仅保留本轮代价与一句话决定，方向正确**。删除通用 worktree 命令后，留下的三条本轮证据属于 why/实例事实。
4. **keepalive KICKOFF 保留已实例化的启动命令不必一律删除**。它是可复制入口的一部分；问题只在 canonical session-closeout skill 又复制了另一个 skill 的通用命令。
5. **六个正文标题、frontmatter 的“六步”、CLAUDE 触发器和 memory 索引的大方向已经对齐**。唯一直接数字漏改是 skill line 8 的“五步名”，不是整套编号错乱。
6. **新增 wiki 链接与 Markdown 文件目标真实存在**，没有发现 missing slug；`methodology-background-agent-result-surfacing-failure`、两条 verification 记忆和 `complete-plan.md` 均可解析。
7. **`empirical-verification` 新增的三个失效模式属于验证方法论，不是把非收尾内容过度塞进 session-closeout**。把探针边界放 empirical skill、在 closeout 的实验归档处只引用它，归属合理。
8. **“查的是投影”“peer 已修复”“配置只激活子路径”三个案例均有可核事实支撑**。特别是 `883e0533` 确实修改空 delta 保留路径；我没有把案例的第一人称叙事本身判成缺陷。
9. **coding convention 新增“配置读留装配层”与守卫时间预算的归属合理**。它们是长期编码/测试约定，不属于收尾 how-to，不应为了本轮“不要散落”硬塞进 session-closeout。
10. **frontmatter 大小、YAML 必填字段、Markdown 链接与两个 commit 的 whitespace check 均合格**。
11. **未把 archive 中旧 `completion-includes-doc-sync` 或历史 HANDOFF 当作必须清零的活规则**。历史叙事可以保留；只有仍自称当前 canonical 五步或可复制执行的活 kickoff 才构成漂移。
12. **没有把所有 212 个 plan 命中一概报成问题**。feature-specific doc-sync、测试和验收步骤应留在各自计划；单一源只要求抽走跨项目通用流程。


## 2026-07-28 复审

### 结论

- **复审范围**：独立核对 `ef616367`、`887602fd`、`1b7b2afb`、`ba0c8345`、`1938599c`、`847f8bc8` 的提交内容及当前最终文件；六个提交均为当前 `HEAD` 祖先，相关目标文件无未提交改动。
- **原发现落地情况**：F1、F4–F9 的主修属实；F3 的 canonical skill 与新模板已覆盖状态、基线、消费动作、supersession、关闭动作和 HANDOVER/KICKOFF 分工。F2 对 memory stub 的收窄属实；对 CLAUDE 压缩触发器的保留理由成立。F10 不再坚持为事实性缺陷，降为待压力测试的假设。F11 仍未做，但不构成本轮 blocker。
- **复审 verdict**：**修复下面 1 个 HIGH 后可进入下一阶段**。修复代码/skill 主体可采信，但 `847f8bc8` 的“自我施用”交接文档仍有内部矛盾，不能按当前状态作为可靠的新会话入口。
- **新增发现计数**：HIGH 1、MED 1、LOW 1；blocker 0。

### 抽查命令与输出

#### 1. 六个提交确已落地，原目标文件干净

```bash
for c in ef616367 887602fd 1b7b2afb ba0c8345 1938599c 847f8bc8; do
  git merge-base --is-ancestor "$c" HEAD
  printf '%s ancestor=%s\n' "$c" "$?"
done

git status --short -- \
  .claude/skills/session-closeout/SKILL.md \
  .claude/skills/session-closeout/handover.md \
  CLAUDE.md docs/memory/session-closeout-and-handover.md \
  docs/coding-conventions.md \
  docs/plan/2026-07-27-keepalive-and-separator/{HANDOVER.md,KICKOFF.md}
```

输出：六项均为 `ancestor=0`；目标文件 status 无输出。仓库整体仍有大量 peer dirt，但不在上述修复文件中。

#### 2. F1 的五步冻结已基本清零

先做正样本：

```bash
rg -n --fixed-strings '收尾 == “完成”的一部分' \
  .claude/skills/session-closeout/SKILL.md
```

输出：

```text
8:收尾 == “完成”的一部分：按序走完下面六步……
```

再查旧表述：

```bash
rg -n -i '(收尾五步|走收尾五步|按 skill `session-closeout` 五步|每 phase 收尾走五步|session-closeout[^\n]{0,30}五步)' \
  .claude/skills docs CLAUDE.md \
  --glob '!**/2026-07-28-session-closeout-skill-review-*.md'
```

只剩：

```text
docs/plan/2026-07-22-continuation-retry-sequential-anchor/HANDOFF.md:65:
## 7. 收尾状态（skill `session-closeout`，当时为五步；当前流程以 skill 为准）
```

该条是明确标注的历史事实，不是活规则，合格。`1938599c` 实际改了 **15 个文件、15 个 hunk**；提交说明所谓“14 处”与文件数不完全同义，但每个替换都有计数且结果检索成立，不构成实质问题。

#### 3. F4/F5 的代码对账已修正

`docs/coding-conventions.md:19-22` 现在明确：

- 单调性只限 **wire 合法性/识别集合**；
- destructive consumer 会把碰撞值送进 `stripAllThinking()` 删除；
- `extraAccepted`/legacy 走 trim 后全等；内置封闭命名空间允许 prefix family；
- “零成本”改成“成本大幅下降”。

这与 `src/lib/anthropic/sanitize/block-layout-contract.ts:78-80` 及 `src/lib/anthropic/strip-all-thinking.ts:21-23` 一致，F4/F5 关闭。

#### 4. F6–F9 的承重修复属实

- `.claude/skills/session-closeout/SKILL.md:8` 已改为“六步名”。
- CLAUDE 锚点“文档路由”“文本风格偏好”“细粒度、每阶段提交”“concurrent-sessions 行级共存”“docs-merge-before-execute”均真实命中；`01-core-principles.md`、`21-git-workflow.md`、`40-dev-workflow.md`、`41-doc-mgmt.md` 均存在。
- `.claude/skills/session-closeout/SKILL.md:64` 已把 durable boundary 写成显式 pathspec `git add` 后立即显式 pathspec `git commit`，并说明仅 add 的 peer 卷入风险。
- worktree 建立命令已从 canonical skill 移除，交回 `git-preference:isolating-from-a-shared-git-worktree`。

### 三条未全盘采纳的裁决

#### F2：CLAUDE.md 保留压缩 how-to——理由成立，原判部分撤回

项目 CLAUDE 的稳定写法确实是“always-on 压缩线索 + 深层指针”。当前 line 54 的内容虽与正文重叠，但它是触发器层的最短高价值不变量，没有复制具体命令、模板字段或边界分支；memory stub 也已明确“别在这里找可执行细节”。因此：

- **不再要求 CLAUDE 只剩裸六步名**；
- 当前 CLAUDE 压缩摘要可接受；
- memory stub 的 How to apply 已收成纯指针，F2 主体关闭。

但 stub 当前新增了一处机械重复，见 R3。

#### F10：description 保留六步名——理由基本成立，原 MED 撤回

我能给出的最强反证仍只是 authoring skill 的通用经验：description 摘流程可能诱导 agent 跳过正文。当前版本已经删除可执行动作，只保留六个覆盖面标签，并显式写“可执行细节只在正文，必须读正文”；这些标签确实帮助 discovery 判断该 skill 是否涵盖归档、记忆和交接。

在没有本仓 pressure test 证明 agent 仍会跳读之前，我没有更强的项目内事实依据继续把它定为缺陷。因此 **F10 从 MED 撤回，改为待验证假设**；若未来压力测试出现跳读，再依据观测收窄 description，而不是现在凭通用偏好删除。

#### F11：未做全新 CLI 压力测试——不是完成 blocker，但不能宣称“行为已验证”

“同一 CLI 进程不能完全验证新注册/修改后的 skill 触发行为”是合理的运行时限制。它不阻断本轮文本修复合并，因为静态链接、事实、模板和自我施用均可独立复核；原 F11 本来也是 LOW。

裁决是：

- **不构成“不能完成本轮文本修复”的 blocker**；
- 仍不得宣称 skill 的真实触发/遵从行为已经 pressure-tested；
- 后续应在全新 CLI 进程验证三类场景：上下文将满且有未追踪产物、同主题两个活交接、接手时 HEAD 已越过核验基线。

该后续目前只存在两份评审报告中，未找到独立 todo/plan 条目。报告本身已入库，因此不算“无记录”，但若团队把评审报告视为只读历史而非待办源，应另登记 backlog。

### 新发现

#### R1 / HIGH / `docs/plan/2026-07-27-keepalive-and-separator/HANDOVER.md:3,93,162` 与 `KICKOFF.md:25-32,44-48`

**事实**：`847f8bc8` 声称按新模板自我施用，但最终文档仍有三组直接冲突：

1. HANDOVER line 3 写“T1–T4 用户已批准未开工”，line 93/95 又写“T1 已完成，master `da59c586`”。
2. HANDOVER line 162 仍写“`test:backend` 跑不起来、会先 build native”，而 KICKOFF line 46 和当前 `package.json:56` 均证明 `test:backend` 已直接等于 `bun scripts/parallel-test.ts unit it http`。
3. 新模板要求头部列“未提交与未追踪清单”，HANDOVER line 5 只写“本轮代码改动已提交”，没有记录当前 shared worktree 的 dirt；复审时主树确有大量 modified/untracked peer 文件。

此外，canonical 规则说 KICKOFF 的待办“只标批准状态与建议顺序，不复述内容”，但 KICKOFF lines 27-32 仍逐条复述 T1–T6 的机制、门槛与文件；这已经实际证明“模板写对”不等于自我施用正确。

**为什么是问题**：这是新会话的 operational entry point。接手方无法判断 T1 是否还需执行，并会同时看到 `test:backend` 可跑与不可跑两个相反结论，足以造成重复工作或错误绕行。

**建议**：把头部状态按每项真实状态重写；删除/标 superseded 的 line 162 旧门禁；头部显式写 dirty/untracked（区分本任务与 peer）；KICKOFF 的 T1–T6 只保留状态和顺序，正文一律指向 HANDOVER §3。修后再用冲突检索：

```bash
rg -n '(T1.*未开工|T1.*已完成|test:backend.*跑不起来|test:backend.*可以直接跑)' \
  docs/plan/2026-07-27-keepalive-and-separator/{HANDOVER.md,KICKOFF.md}
```

逐条解释剩余命中，不能只报 grep 空。

#### R2 / MED / `.claude/skills/session-closeout/SKILL.md:51`

**事实**：skill 新增绝对数字“本仓另有 21 份历史扁平式 `docs/plan/<date>-handover-<topic>.md`”。按这个精确命名形状，在 `1b7b2afb` 时只有 **5** 份，当前只有 **6** 份；放宽到 `docs/plan/` 直属、文件名含 handover/handoff 也只有 **7** 份。按文档内容标题搜索能得到约 17–22 个候选，但其中混有普通 plan、review 与 kickoff，不等价于所声称的精确路径模式。

复现：

```bash
git ls-tree -r --name-only 1b7b2afb docs/plan \
  | rg '^docs/plan/[0-9]{4}-[0-9]{2}-[0-9]{2}-handover-.*\.md$'
```

输出 5 条。

**为什么是问题**：这是新增的“已实测”式绝对事实，并被用来支撑“不迁移”的决定。决定本身可成立，但数字和定义不成立。

**建议**：删除易腐数字，改成“仓库已有多种历史扁平式 handover/handoff 与单文件交接”；如确需数字，先定义统计口径并用可复跑命令生成。

#### R3 / LOW / `docs/memory/session-closeout-and-handover.md:16-18`

**事实**：完全相同的 `Related：[[methodology-background-agent-result-surfacing-failure]] … [[methodology-probe-conclusion-scope-and-peer-invalidation]]` 连续出现两次。

**为什么是问题**：纯机械重复，不影响规则语义，但与本轮“去重复、单一指针”的目标相悖。

**建议**：删掉一行即可。

### 复审后不再坚持的问题

1. CLAUDE always-on 层保留压缩行动线索，不再视为 F2 缺陷。
2. description 保留六步覆盖面标签，不再视为 F10 缺陷；等待新 CLI pressure test 再裁决。
3. `usage-token-net-normalization.md:119` 仍列出一条 feature-specific 收尾链，但其中包含该计划独有的 doc-sync、backfill 与 commit 分组落点；未把它升级成 F1 残留。
4. HANDOVER/KICKOFF 实例保留本轮事实与踩坑仍然必要；R1 针对的是相互冲突和超出双方分工的重复，不是要求把实例掏空。


### 2026-07-28 最终收口复核

#### 已确认修复

`5d909872`、`31e39d6f` 均为当前 `HEAD` 祖先，相关目标文件无未提交改动。以下修复属实：

- HANDOVER 头部已改为“T1 已完成；T2–T4 已批未开工；T5 待裁决；T6 待用户一句话”，与正文 `HANDOVER.md:93-95` 一致。
- HANDOVER 头部和 §3 T6、KICKOFF 均统一为 `test:backend` 可直接运行；当前 `package.json:56` 也确为 `bun scripts/parallel-test.ts unit it http`。
- HANDOVER 已记录 shared master 上有大量 peer dirt、我方无未追踪残留。
- memory stub 的重复 `Related` 已删除；`handover.md` 已把实验产物改为“就地留在 `exp/`”；过时的 `exit 127` 说法已在两组交接中订正。
- `31e39d6f^..31e39d6f --check` 无输出。

“二十多份历史扁平式命名”不再把 21 绑定到窄路径模式，方向正确；但它仍没有稳定统计口径：在 `31e39d6f` 上，按文件名含 handover/handoff/kickoff 的宽口径是 44，排除目录式 `HANDOVER.md/KICKOFF.md` 后是 40，只看 `docs/plan/` 直属文件是 20。这个数字不再构成正确性 blocker，但最好最终删掉数字，改为“已有多种历史扁平式命名”。

#### accept 轴再次对账

`ba0c8345` 后的 `docs/coding-conventions.md:19-22` 与生产路径的核心语义一致：

- `isSyntheticThinkingSeparator()` 的识别结果确实由 `strip-all-thinking.ts:21-23` 送入删除判据；
- “单调”已收窄为 wire 合法性/识别集合，不再冒充用户数据安全；
- 成本已从“零”改成“大幅下降”；
- built-in family 确实走 `startsWith(SYNTHETIC_SEPARATOR_PREFIX)`，legacy 与 extra 走集合/数组全等。

有一处措辞应理解为“**先 trim 被识别的 block text，再与配置值全等**”，而不是“配置项本身也会 trim”：代码是 `const text = block.text.trim()` 后 `extraAccepted.includes(text)`，`nullableNonemptyStringArray()` 不 trim 配置项。若要消除歧义，可把 convention 的“用户配置的额外值……走整体 trim 后全等”改成上述精确句。

但跨文档仍有未同步事实：`docs/spec/2026-07-26-thinking-terminal-block-layout.md:170,175` 仍写开放 ACCEPT “永远不可能造出非法 payload”并把所有识别概括为“整块 trim 后全等”，没有 destructive-consumer 限定，也漏掉 built-in prefix family；`src/lib/config/schema.ts:449-453` 的注释也仍只强调“不会造非法 payload”。因此 F4/F5 在 **coding-conventions 本文件**已修好，但 doc↔doc / doc↔code 的合并态收口尚未完成。

#### 仍有保留

`31e39d6f` 没有修掉上一节 R1 的 KICKOFF 分工问题：`KICKOFF.md:19-26` 仍逐条复述 T1–T6 的机制与门槛，而 canonical skill `SKILL.md:49` 和模板 `handover.md:81` 要求 KICKOFF “只标批准状态与建议顺序，不复述内容”。其中 line 19 还说“用户已批准 T1–T4”，却没有标出 T1 已完成；接手者只读 KICKOFF 仍可能把 T1 当待办。

#### 最终裁决

**仍有保留，尚未 consensus reached。** 保留点只有两类：

1. 修 KICKOFF，使 T1–T6 只保留真实状态与建议顺序并指向 HANDOVER §3；
2. 同步修正 `docs/spec/2026-07-26-thinking-terminal-block-layout.md:170,175` 与 `src/lib/config/schema.ts:449-453` 的旧 accept-axis 绝对表述。

“二十多份”数字建议删除，但可降为非阻断的准确性清理。上述两类完成后，我预计可明确给出 consensus reached；F2/F10/F11 不再是共识障碍。
