# `62/63/64` 拆分归属清单 v2（按问题轴）

> ## ⚠️ 执行期修订（2026-08-09）——本节优先于下文
>
> 下文第四节「需要新建 / 扶正的」在执行中被证否两处，**以本节为准**：
>
> 1. **「扶正 `methodology-edit-then-verify-then-commit-never-one-call`」的归属判错了。** 那份记忆讲的是「编辑／验证／提交的顺序」与「证据没有分辨力」，当初是按**字面词**（两边都出现「替换／编辑」）映射过去的；**按问题看它不属于 G2**。用户随后裁定新建一份并命名为「**如何精确编辑文件**」，该内容归入新 skill `editing-files-precisely` 的「落盘」一节。
> 2. **主会话曾试图把 `replacement-must-cover-what-it-restates` 的手法并入 `authoring-skills`**，并为此扩其 description。**用户叫停**——那是为迁就一个错误归属而稀释宿主意图。已完整回退（`authoring-skills` 回到当时的 HEAD、无差异），改为进入 `editing-files-precisely`。
>
> **实际执行结果**：新建 **2** 份 skill（`making-a-gate-actually-fire`、`editing-files-precisely`），而非「新建 1 + 扶正 2」——两处「扶正」实际都表现为「新建 skill + 记忆改 stub + 规则压缩」。
>
> 「散落状态收进对象五坑」那份**仍未建**，仍是唯一确认无家的域。
>
> **下文第五节「请裁决」的三个问题仍然有效、仍未全部答复。**

> **状态**：提案。下文第三节的表仍是剩余各组的执行依据。**取代 v1**（`2026-08-09-rules-62-63-64-split-ledger.md`）——v1 按名词轴聚域、逐条找家，已被证否。
> **判据**：*漏掉这一条，当场少了哪道保护？* 越权 / 不可逆 / 数据丢失 / 指令优先级被搞反 → 留 rules；只是一轮返工 → 下沉。只算这一条**直接**解除的保护。
> **条目口径**：`rg -c '^\s*- \*\*[a-z0-9-]+\*\*' ~/.claude/rules/agents/6{2,3,4}-*.md` = 顶层 23 + 缩进子条 2 = **25**。（v1 写「23 条含两个子条」自相矛盾——23 恰是不含它们的数。）
> **产出链**：独立分组（`...-question-axis-grouping-independent.md`）→ 对抗评审（`...-attack.md`）→ 第三方裁决（`...-grouping-conflict-arbitration.md`）→ 按域找家（本文第五节，转录自只读 agent）。

## 一、两种找家方法的对照（这是本轮最硬的结论）

| 方法 | 判为「无家」的数量 |
|---|---|
| v1 逐条找家、只搜 skills | 8 |
| v2 按问题聚域找家、搜 skills + memory + docs | **1** |

差距不是精度问题，是**方法错**。两个具体成因：

1. **逐条找家系统性低估覆盖率，偏差集中在短条目**——一句话的条目永远显得「不够格单独有家」。实证：`worktree-branches-are-for-merging` 判无家，实际该域有四份 skill。
2. **只搜 skills 会漏掉住在 memory 里的域**。按本项目约定记忆是引用层、实质应下沉 skill，**一条内容完整的记忆就是一个等着被扶正的家**。实证：`batching-can-silently-remove-a-gate` 判无家，而 `methodology-gates-i-write-fail-at-the-execution-seam` 正是它的域（九种形态）。

## 二、被第三方裁决改掉的三处

独立分组与对抗评审冲突，交未卷入的第三方裁决（报告见 `...-grouping-conflict-arbitration.md`），结果是**两者皆误**：

- **`check-dependency-contract` 不与 `batching-can-silently-remove-a-gate` 同组。** 前者是两个规范来源语义冲突（修法：换 API / 同步契约 / 声明不适用），后者是 shell 控制流 fail-open（修法：`&&` / `pipefail` / 拆开执行）。**对象、机制、修法三者都不同**；且反向召回测试判死——处在「给不变量选承载 API」时刻的读者不会去检索「退出码传播」。
- **三条不能全并成一个 seam-compatibility 问题。** 那抹平了一个稳定的因果方向：「依赖破坏我的不变量」与「我的改动破坏别人的契约」是两个方向。
- **`new-checks-must-not-alter-existing-contracts` 不拆半。** 插入层的选择**正是由**「不得改变既有顺序与分层契约」决定的，是同一决策的约束与目标。

裁决自陈的最弱一环：召回测试是反事实模拟，无真实 selector 日志、无多读者盲测。机制与修法的差异不依赖那一层。

## 三、最终分组 × 归属

「留 rules」一栏为空 = 整条下沉，规则里只留一句带触发词的指针。

| 组（读者当时在问什么） | 成员 | 留 rules 的最低不变量 | 家 | 覆盖 |
|---|---|---|---|---|
| 我刚写完的这份文档，内容真是我以为的那样吗？ | `reread-docs-after-writing` | `[hard]` 通读**不能替代事实证伪**；不得用「我读过了」声称事实已核验 | `doc-coauthoring`（插件） | 已覆盖 |
| 我这次替换式编辑，会不会静默把文件弄坏？ | `replacement-must-cover-what-it-restates` | **旧串多、新串少 → 静默删除且不报错**（数据丢失形态） | `methodology-edit-then-verify-then-commit-never-one-call`（**待扶正**） | 部分 |
| 我写下的这句状态/数字，明天还成立吗？ | `stale-context-at-session-end`、`anchor-numbers-to-commits` | `[hard]` 写交接/计划前必须重新核对仓库状态；数字默认只给能重算它的命令 | `writing-handover-docs` + `organizing-project-docs` | 已覆盖 |
| 过渡期的东西该安置在哪，才不会被误读或静默清掉？ | `put-transient-state-in-the-right-file`、`track-transitional-symlinks` | 过渡期符号链接**必须被 git 跟踪、不得进 `.gitignore`**（否则 `git clean -xdf` 静默删除） | `organizing-project-docs` + `closing-a-development-session` | 已覆盖 |
| 我刚说的这条教训，下次真会被召回吗？ | `verify-lessons-are-actually-hardened` | — | `authoring-skills` | 已覆盖 |
| 我要交出去的派发件，它依赖的上游可信吗？ | `kickoff-inherits-upstream-defects` | — | `writing-handover-docs` | 部分 |
| 这一轮做完了，除了测试绿我还欠什么？ | `analyze-structural-smells-each-round`、`reflect-best-approach-each-round` | — | `closing-a-development-session` | 部分 |
| 收尾了，我还有哪些产出没并回主干？ | `worktree-branches-are-for-merging` | — | `closing-a-development-session` + `finishing-a-development-branch` | 已覆盖 |
| 挡我路的这个东西，是不是别人有意为之的决定？ | `check-existing-decisions-before-changing-behavior`、`red-tests-may-be-guarding-something` | `[hard]` 不得无授权推翻已有裁决；**搜索为空不等于无裁决**；`[hard]` 删除或放宽既有 guard，合并前必须交独立 reviewer 或用户裁决 | `improving-user-proposals` + `feedback-confirm-guard-purpose-before-hardening`（memory） | 部分 |
| 我这段东西该插在哪一层？ | `fix-at-the-shared-base-not-where-you-noticed` | — | `enforcing-invariants-across-mechanism-layers` | 部分 |
| 我设的这道门，在真正执行的那一刻还在吗？ | `batching-can-silently-remove-a-gate` | **不可逆动作**（提交/推送/删除/迁移/改共享状态）必须单独跑一次、亲眼确认再动作 | `methodology-gates-i-write-fail-at-the-execution-seam`（**待扶正**） | 已覆盖 |
| 依赖的契约，会不会反向许可我要禁的事？ | `check-dependency-contract-against-your-invariant` | — | `enforcing-invariants-across-mechanism-layers`「契约传播」节 | 已覆盖 |
| 我这次改动的爆炸半径里，谁的不变量会被打破？ | `new-checks-must-not-alter-existing-contracts`、`packaging-can-void-another-invariant` | — | `enforcing-invariants-across-mechanism-layers`（其自述的「反向问题」） | 部分 |
| 我写下的这条不变量，作用域是不是写大了？ | `scoped-invariant-written-as-global` | — | `enforcing-invariants-across-mechanism-layers` | 部分 |
| 切换的那个瞬间，会不会有人看见坏掉的中间态？ | `atomic-publish-with-invalidation`、`atomic-swap-for-live-paths` | **没有原子交换就停下来**：不得硬调不确定可用的 syscall，也不得退回两步法假装无窗口 | `owned-singleton-lifecycle` | 部分 |
| 把散落状态收进一个对象，有哪些已知坑？ | `shared-state-refactor-traps` | — | **无** | 完全没有 |
| 它到底生效了没有／真的能跑吗？ | `migrate-then-verify-execution-not-existence`、`environ-is-frozen-at-process-start` | — | `verifying-authoritative-claims` + `empirical-verification` | 已覆盖 |
| （已完成）变异注入后怎么安全还原？ | `mutation-baseline-must-contain-the-real-impl` | ✅ 已拆，见全局提交 `95c7740` | `positive-control-your-tests` | 已覆盖 |

## 四、需要新建 / 扶正的（从 v1 的 5 份降到 3 项）

| 类型 | 对象 | 说明 |
|---|---|---|
| **新建 1 份** | 「散落状态收进对象」的五坑 | 三层全搜无命中；`owned-singleton-lifecycle` 正文**明确排除**纯值状态，域不重叠 |
| **扶正 memory → skill** | `methodology-gates-i-write-fail-at-the-execution-seam` | 已有九形态 + 四问，内容够格，缺的只是 skill 形态与召回面 |
| **扶正 memory → skill** | `methodology-edit-then-verify-then-commit-never-one-call` | 已覆盖「逐 replacement 核命中数」，需补 old/new 覆盖面双向差集与静默重复检测 |

## 五、请裁决

1. **新建 1 份 + 扶正 2 份 memory，可以吗？** 比 v1 的「新建 5 份」轻得多，且两处扶正本就是项目约定的方向（记忆是引用层、实质该沉 skill）。
2. **执行顺序**：建议先做**两处扶正**（内容现成、风险最低、且立刻解掉两个「无家」），再按组逐个下沉，最后新建那一份。
3. **一次一组**，每组走：拆 → 逐条对账（双向）→ 独立评审 → 提交。不批量落。

## 六、执行时要一并补的实证

`batching-can-silently-remove-a-gate` 现有三形态之外的**第四种**（2026-08-09 撞到两次）：

> `grep -c` / `ls` 对无匹配输入的退出码为非零。把它写在 `&&` 左侧当判据时，一个**正确**的结果（「不含该段落 = 0」「该 glob 无匹配」）会把后续命令全部短路。
> 与第二形态（`| tail` 吞掉退出码）方向相反：那是**门消失**（假绿），这是**正确结果被当成失败**（假红）。
> 判据：**判成败的退出码必须来自被测命令本身**，不能来自计数器、过滤器或通配符展开。
