# R1 评审处置

处置对象：`review-instruction-r1.md` 与 `review-user-r1.md`。所有发现都改变模型接收的指令或其验收证据，按 B 级处理；修订后必须由未卷入的新实例复评。

| 来源 | 发现 | 处置 | 证据 |
|---|---|---|---|
| 指令评审 M1 | RED 基线只有汇总，原始输出不在仓库内 | 采纳（B） | `runs/baseline-parent-closure-*.json` 保存 5 份自描述 envelope；`sha256sum.txt` 绑定内容；`README.md` 给复跑命令与边界。 |
| 指令评审 M2 | GREEN 20 条评分缺被评分完整输出 | 采纳（B） | `run-matrix.json` 绑定 16 份最终 skill 运行；`final-grading.json` 逐 run 保存 80 条冻结断言与原始证据行；`validate.py` 机械核验行号与原文。 |
| 指令评审 M3 | 另一个父项接管可成为洗债通道 | 采纳（B） | `SKILL.md` §5 增加真实转移门：接收父项 active、具名 owner、同一 ID 完整接收、双向链接、关闭责任与无环；源项只在原子闭合后标 `transferred`。R1 skill 的转移探针未主动检查循环，修订版把无环变成明确判据。 |
| 指令评审 M4 | 引用目标存在性没有随派审材料证明 | 采纳（B） | 结构 gate 检查 `verification-log.md`、两套 eval、两份评分与所有显式 Markdown 链接；最终复评输入携带 gate 输出，不再要求 reviewer 采信作者声明。 |
| 使用方 M1 | 全 `TBD` 可形成空壳后续项 | 采纳（B） | `SKILL.md` §3 明确 `TBD` 只证明捕获缺口，不代表完整；每个 `TBD` 绑定未知原因、补齐责任、可观察触发和状态门，事件触发不得裸写 `TBD`。Opus／Fable 的 R2 case 6 均保持当前批交付、父项部分完成。 |
| 使用方 M2 | 合法转移缺 `transferred` 状态 | 采纳（B） | 状态枚举加入 `transferred`；§5 定义何时才能写入该状态。 |
| 使用方 M3 | 缺少阶段完成门 | 采纳（B） | §5 改为批次／阶段／父项目三道门；阶段必须枚举全部批次并闭合阶段级集成／验收。Opus／Fable 的 R2 case 7 均拒绝以 A done 冒充 S done。 |
| 使用方 M4 | 后续项依赖环可让触发永不发生 | 采纳（B） | §3 要求检查依赖与触发组合图，每个 blocked 项必须可追溯到外部事件或可启动根项；环、自依赖和封闭分量立即转为“需裁决”。Opus／Fable 的 R2 case 8 均识别 F1↔F2 环且不要求盲目提前实现。 |

没有驳回项。修订没有以流程完整为由把合法后续项强塞回当前批：10TB 正样本仍保持 A 立即交付、B blocked、父项部分完成。
