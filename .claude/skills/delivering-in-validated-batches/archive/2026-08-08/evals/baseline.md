# 无 skill 基线

## 运行边界

- 运行器：Claude Code 2.1.223，Opus 5，5 个独立 `claude -p` 会话。
- 请求选项：`--safe-mode --disable-slash-commands --tools "" --no-session-persistence`；未显式注入待创建 skill。它们不证明运行时未继承任何项目／用户配置或指令。
- 场景：`evals.json` 的父项关闭 case 3，同一 prompt 独立运行 5 次。

## 当前冻结 RED 结果

`run-matrix.json` 冻结 5 次同一父项目关闭场景的无 skill 运行；`final-grading.json` 的绑定评分为 16/25，说明基线并非全错，但仍存在可区分的错误状态：

1. 1/5 运行把父项目写成 `Completed — Core scope delivered`，让未完成正确事项退出原父项关闭门。
2. 其余 4/5 拒绝立即关闭父项，但仍有 8 条其它冻结断言未满足，主要落在依赖／事件型复议记录和关闭点独立裁决权。
3. 基线说明模型天然能识别部分 blocker 与治理风险；skill 的目标不是替代这些能力，而是把全部 5 条关闭契约稳定同时成立。

完整逐字 envelope 已归档到 `runs/baseline-parent-closure-*.json`，并由 `run-matrix.json`、`runs/sha256sum.txt`、`final-grading.json` 与 `validate.py` 绑定；复跑方法、最终 skill 结果与证据边界见 [README.md](README.md)。

早期开发过程中曾使用非 envelope 临时微测得到不同分布；该组已被当前冻结矩阵取代，不作为项目内验收事实保留。
