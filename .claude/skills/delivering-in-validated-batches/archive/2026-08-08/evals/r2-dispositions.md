# 最终评审处置

处置对象：最终接手者复评的 3 个 major。三项均改变指令或验收证据，按 B 级处理；修订后由未卷入的新实例再次复评。

| 发现 | 处置 | 关闭证据 |
|---|---|---|
| C3：可把有未满足依赖的事项错标成 `pending／ready`，绕过只约束 `blocked` 的可达性门 | 采纳（B） | `SKILL.md` §3 将图检查扩展到全部非终态事项，并机械定义 `pending／ready／blocked`；新增 R2 case 9。最终 `final-fable-r2-9.json` 进入 `run-matrix.json`，对应 5 条冻结断言全部通过。 |
| C7：六个外部 skill 名称只是反引号文本，内部链接检查不证明它们可解析 | 采纳（B） | `dependencies.json` 冻结名称、scope 与路径；`validate.py` 按 project／user／superpowers-plugin 三种 scope 解析，最终输出 `resolved_skill_dependencies=6/6`。这是当前运行环境的可达性证据，不冒充跨机器永久保证。 |
| C8：评分摘要没有机械绑定 run 来源、prompt／skill hash 与逐字引文 | 采纳（B） | `run-eval.py` 输出自描述 envelope；`run-matrix.json` 绑定 21 次运行；`grade-runs.py` 由独立 grader 选择原始行号，确定性抽取逐字 evidence；`validate.py` 核对 21/21 envelope／prompt／skill／manifest hash、逐条原始评分证据行、最终 80/80 与基线 16/25。 |

后续复评与绑定评分又发现三类同形缺口，均已采纳（B）：

1. 父项目关闭点的“继续排期”曾被允许由可能卷入的父项负责人批准。`SKILL.md` §5 现将“未卷入”机械定义为未参与事项提出、实现、既有处置或本次关闭申请；具名、有授权、现 owner 均不自动合格。无人合格时交用户裁决，否则父项保持开放。
2. `baseline.md` 曾复述已淘汰临时微测的 4/5 分布，与当前冻结 envelope 矛盾。现只陈述 `run-matrix.json` 中 5 次基线及绑定评分 16/25，并明确早期临时组已被取代。
3. R2 case 7 曾把 B 标成 `in progress`，同时声称其全部批次门已闭合。新增冻结断言先在旧输出上精确变红 1/5；正文现要求每个完成条件使用稳定 ID 且只能落 `closed_conditions`／`open_conditions` 一侧，状态从集合派生。修订后 case 7 达到 5/5，B 的实施／验收／交付 ID 全留在 open。

修订后新增交付状态转移综合场景并重跑当时矩阵，绑定评分为 80/80；无 skill 基线为 16/25。

## 当前证据口径

上述数字属于形成过程的历史 disposition。用户后续裁定网络失败必须原会话 resume，但既有完整成功样本不追溯失效；当前 `run-matrix.json` 因而按证据角色同时保留 5 份 baseline、16 份 historical 和 5 份绑定当前 skill hash 的 resumable current 样本。当前验收数字只看 `evals/README.md` 与 `validate.py` 输出：baseline 16/25、historical 80/80、current 25/25。
