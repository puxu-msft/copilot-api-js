# `62/63/64` 逐条拆分归属清单（待用户拍板）

> **状态**：提案，尚未执行任何搬迁。
> **口径来源**：user-level skill `authoring-skills` 的 `rules-hold-judgements-skills-hold-practices`，经五轮独立评审收敛，试点见全局提交 `95c7740`（`mutation-baseline-must-contain-the-real-impl`）。
> **判据**：*漏掉这一条，当场少了哪道保护？* 越权 / 不可逆 / 数据丢失 / 指令优先级被搞反 → 留 rules；后果只是一轮返工 → 下沉 skill。只算这一条**直接**解除的保护，不推到最坏下游用途。
> **「现成的家」一栏**来自一次只读 explorer 全域搜索（`~/.claude/skills`、`~/.claude/plugins`、项目 `.claude/skills`，中英文 + 全称/缩写 + 错误原文多轮关键词）。该 agent 工具集无写权限、无法自行落盘，本表由主会话转录，判「无」的依据附在原始回复中。
> **清单条目数与规则现状请重取**，不要引用本文快照：
> ```bash
> cd ~/.claude/rules/agents && rg -c '^- \*\*[a-z0-9-]+\*\*' 6{2,3,4}-*.md
> ```

## 一、先说三件影响整批的事

**① 不是所有条目都该拆。** 有五条**短到拆开的接缝成本大于收益**——正文本身就几乎只有那条不变量，拆完 rules 侧不会变短，反而多出一个可能没人跟进的指针。这些标为 `留（不拆）`。**「能拆」不等于「该拆」。**

**② 八个话题没有现成的家。** 这意味着批量执行会**新建 skill**，而不只是搬运。新建有双源风险，所以本表把无家话题**按域合并**成尽量少的新 skill，并在下方单列，请优先裁决这一部分。

**③ `64` 与 `62/63` 的形态完全不同。** `64` 整份是并发/迁移的技术陷阱，几乎每条都是纯领域知识，是最干净的一批；`62/63` 混得很紧，**同一条里既有必须常驻的不变量、又有上千字操作细节**，拆解风险最高。建议的执行顺序因此是 `64` → `62` → `63`。

## 二、`62-docs-and-handover.md`

| 条目 | 处置 | 留 rules 的最低不变量 | 下沉内容 | 家 |
|---|---|---|---|---|
| `reread-docs-after-writing` `[hard]` | **拆** | `[hard]` 通读**不能替代事实证伪**；不得用「我全文读过了」声称事实已核验。写完文档必须自己通读一遍再交付（触发句 + 指针） | 通读能查的四类清单、三个实证案例 | **无 → 新建**（见 N1） |
| └ `replacement-must-cover-what-it-restates` | **拆** | **两个方向都会出事**：新串多→重复；**旧串多→静默删除且不报错**（数据丢失形态，必须常驻） | 机械检查怎么做、两版被证否的简化判据（反例教学）、frontmatter `---\n---` 相邻同行的坑、批量替换的 span 计数对账 | **无 → 新建**（见 N1） |
| `stale-context-at-session-end` `[hard]` | **拆** | `[hard]` 写交接/计划前必须重新核对仓库状态；四类证据对象；逐条验证 pending 断言（触发句 + 指针） | 具体核对手法与三个实证 | `writing-handover-docs`（**已覆盖**，只需回指） |
| └ `anchor-numbers-to-commits` | **留（不拆）** | 全条即不变量，本轮刚收紧（`3b0d214`） | — | — |
| `verify-lessons-are-actually-hardened` | **下沉** | 触发句：说出「这是个教训」后必须去查它是否已写成会触发的判据 | 三要素（具体形态/可执行判据/本轮实例）、触发接缝检查 | `authoring-skills`（**已覆盖** description 召回面与自验，补三要素即可） |
| `kickoff-inherits-upstream-defects` | **下沉** | 触发句：写 kick-off 前先查所引章节有无未闭合 blocker/major | 全称词的执行接缝检查、「用户可观察到 X」须实跑 | `writing-handover-docs`（**部分覆盖**，需补「逐份检查被引文档未闭合发现」） |
| `put-transient-state-in-the-right-file` | **下沉** | 触发句：过渡态写易变状态真相源、不写稳定文档 | 实证与「提炼长期成立部分」的做法 | `organizing-project-docs`（**已覆盖**三层 carrier） |

## 三、`63-engineering-practice.md`

| 条目 | 处置 | 留 rules 的最低不变量 | 下沉内容 | 家 |
|---|---|---|---|---|
| `analyze-structural-smells-each-round` | **留（不拆）** | 输出必须落纸面，三字段缺一不可（`file:line` + 怪味类型 + 处置）；「无发现」与「没扫」必须可区分 | — | （怪味目录另见 `mattpocock-skills:code-review`，**部分覆盖**，可加一句参见） |
| `reflect-best-approach-each-round` | **留（不拆）** | 三方向逐项过；发现更优路径本轮不做须记录并提请裁决 | — | **无家且无长尾**，留 |
| `mutation-baseline-must-contain-the-real-impl` `[hard]` | ✅ **已完成** | — | — | `positive-control-your-tests`（`95c7740`） |
| `worktree-branches-are-for-merging` | **留（不拆）+ 指针** | 隔离 worktree 的分支默认就是要合并回主干，不合并才是需说明理由的例外 | — | `git-preference:isolating-from-a-shared-git-worktree`（**部分**：有集成流程，**没有**「默认必须合并」这条默认值） |
| `check-existing-decisions-before-changing-behavior` `[hard]` | **拆** | `[hard]` 不得无授权推翻已有用户裁决；**搜索为空不能当作「无裁决」** | 决策真相源怎么定位、查到后如何引用、拆分不算推翻的边界 | `improving-user-proposals`（**部分**：已有搜索合同，但适用面偏「用户正在形成提案」，需扩到「任何行为修改前」） |
| `red-tests-may-be-guarding-something` | **拆** | 两条 `[hard]`：改测试前先落盘记录守的是什么；**删除或放宽既有 guard，合并前必须交独立 reviewer 或用户裁决，不得自判放行** | 实证、占位数据豁免、判别流程 | **无 → 扩充 `reshaping-a-bypassed-guard`**（同一对象、反方向；见 N2） |
| `new-checks-must-not-alter-existing-contracts` | **留（不拆）** | 新增校验不得顺带改动既有顺序契约或分层边界 | （实证三步可留可沉，量太小） | `enforcing-invariants-across-mechanism-layers`（**部分**，已把本条识别为反向问题） |
| `fix-at-the-shared-base-not-where-you-noticed` | **下沉** | 触发句 + 判别句：*这个坑，下一个复用者还会踩吗？* | 两个实证形态、与 `root-cause-over-patch` 的差别、**最低共同层**选层判据 | `enforcing-invariants-across-mechanism-layers`（**部分**，缺最终选层规则） |
| `check-dependency-contract-against-your-invariant` | **下沉** | 触发句：立不变量前先读被调用 API 自己声明的用法 | 冲突时的三选一、实证 | `enforcing-invariants-across-mechanism-layers`（**已覆盖**「契约传播」节） |
| `batching-can-silently-remove-a-gate` | **拆** | **不可逆动作**（提交/推送/删除/迁移/改共享状态）必须单独跑一次、亲眼确认再动作 | 三种写法对照表、`pipefail`、实证 | **无 → 新建**（见 N3） |
| `packaging-can-void-another-invariant` | **下沉** | 触发句：改 import 可达性前先 grep 依赖「不可 import」的断言 | `find_spec`/`python -I`/`-S`/`.pth`/`sys.path` 专项检查、打包决定要写理由 | `enforcing-invariants-across-mechanism-layers`（**部分**，已识别为反向问题） |

## 四、`64-concurrency-and-refactor.md`（最干净的一批）

| 条目 | 处置 | 留 rules 的最低不变量 | 下沉内容 | 家 |
|---|---|---|---|---|
| `atomic-publish-with-invalidation` | **下沉** | 触发句：拆锁时，指针发布与「据它判新鲜度的状态失效」必须同临界区 | 探针要求（确定性停在发布中点）、审阅提问法 | `owned-singleton-lifecycle`（**部分**，需泛化出「拆锁后的新鲜度失效」） |
| `scoped-invariant-written-as-global` | **下沉** | 触发句：这类不变量往往只在某作用域成立 | 三个动作（写下作用域/构造跨作用域反例/grep 全部复述点） | `enforcing-invariants-across-mechanism-layers`（**部分**，方向互补） |
| `shared-state-refactor-traps` | **下沉（整条）** | （无常驻必要） | 五个坑 + 各自机械判据 | **无 → 新建**（见 N4） |
| `migrate-then-verify-execution-not-existence` | **下沉** | 触发句：验证组件可用要真正执行它、查退出码与副作用 | `rc=127` 实证、必要条件清单 | `empirical-verification`（**部分**，已有「执行结果 ≠ 静态属性」内核） |
| `atomic-swap-for-live-paths` | **拆** | **没有原子交换就停下来**：不得硬调不确定可用的 syscall，也不得退回两步法假装无窗口（会让运行中服务出现真实 ENOENT 窗口） | Linux/macOS/Windows 各自方案与能力探测、架构 gate | **无 → 新建**（见 N5） |
| `environ-is-frozen-at-process-start` | **下沉** | 触发句 + 通用内核：判断「新配置是否生效」必须读**进程持有值**，不能拿声明值冒充 | `/proc/<pid>/environ` 等平台手段、「持有值未必等于启动时继承值」 | `verifying-authoritative-claims`（**部分**，已有「声明配置 ≠ 进程持有值」） |
| `track-transitional-symlinks` | **拆** | 过渡期符号链接**要让 git 跟踪、不得写进 `.gitignore`**（否则 `git clean -xdf` 静默删除，且症状是「新会话起不来」极难诊断） | 实测挡住哪六条命令、挡不住哪一条 | **无 → 新建**（并入 N5） |

## 五、需要新建的 skill（合并同域后）

| # | 提议 skill | 覆盖的话题 | 为什么不能塞进现有的 |
|---|---|---|---|
| N1 | 编辑既有文本而不丢内容（暂名） | 写后通读复核；字符串替换两侧覆盖面（重复 / 静默删除） | `authoring-skills` 的意图限定在「写给模型读的 skill」，而本域适用于**任何**文档编辑。`authoring-skills` 的 `rewriting-drops-coverage-silently` 应回指它 |
| N2 | （扩充而非新建）`reshaping-a-bypassed-guard` | 成片测试红时先辨识守护的不变量 | 同一对象（guard）、反方向（那份管「守卫被绕过」，本条管「守卫挡住了你」）。按「意图到位内容不到位＝扩充」处理 |
| N3 | 工具调用里的门禁保真（暂名） | `check && action` vs 管道 vs 换行；退出码来自谁 | 全域无家。`authoring-tokenized-bash-hooks` 只管 hook 命令解析 |
| N4 | 状态收拢重构五坑（暂名） | 哨兵两份 / 持锁自调 / 只读视图 / 默认值掩盖漏传 / 锁内复核被丢弃 | `owned-singleton-lifecycle` 正文**明确排除**纯值状态，域不重叠 |
| N5 | 运行中路径与过渡期产物的迁移（暂名） | 原子交换 live path；过渡期 symlink 必须被 git 跟踪 | 全域无家；两者同属「迁移期间别让运行中的东西塌掉」 |

## 六、本轮要补的一处实证（执行时一并写入）

`batching-can-silently-remove-a-gate` 现有三种形态之外，**2026-08-09 又撞到第四种**：

> `grep -c <pattern>` 在**命中 0 时退出码为 1**。把它写在 `&&` 左侧做判据时，一个**正确**的结果（「不含该段落 = 0」）会把后续验证命令全部短路掉。
> 与既有第二形态（`| tail` 吞掉退出码）的区别：那是**门消失**（false-green），这是**正确结果被当成失败**（false-red）。同族的还有 `methodology-output-filter-fakes-a-failure`。
> 判据：**判成败的退出码，必须来自被测命令本身**，不能来自计数器或过滤器。

## 七、请裁决

1. **新建 5 份 skill（其中 N2 是扩充）可以吗？** 这是本提案里最重的一项。若不接受新建，替代方案是这些内容留在 rules 不动——但那样 `62/63/64` 的篇幅问题基本没解决。
2. **执行顺序** 建议 `64` → `62` → `63`（干净 → 混合 → 最紧）。每条按试点流程走：拆 → 逐条对账 → 独立评审 → 提交，**一次一条，不批量落**。
3. **五条标为「留（不拆）」的**是否同意不动？
