# R1 实际使用方评审（转录件）

- 评审方式：fresh `claude -p`，Fable 5，safe mode，无工具，无项目设置，无会话持久化。
- 评审范围：`SKILL.md`、`evals/evals.json`、`evals/baseline.md`、`evals/iteration-1-grading.json`。
- 总体结论：0 blocker／4 major，暂不可定稿。

## C1-C7

- C1 当前批自洽后立即交付：满足。
- C2 correctness blocker 不后推：满足。
- C3 外部依赖不提前实现：满足。
- C4 不用 Parked／Not Planned 洗债：规则主方向满足，但合法 transfer 的落账有 major。
- C5 接手者无需问作者即可执行：不满足，关键内容可全为 `TBD`。
- C6 日期仅作提醒：满足。
- C7 批次／阶段／父项状态分离：不满足，只定义了批次与父项两道门。

## Major

1. **`TBD` 可让空壳后续项 false-green。** 规则允许缺字段写 `TBD`，交付门只要求完整清单与入口；依赖、触发、验收、证伪、正控、决策权可全空，接手者仍要问作者。
2. **合法转移没有合法状态。** 状态枚举缺 `transferred`，而父项关闭门允许转移；执行者只能让源记录继续 pending、误写 done／retired，或发明未授权状态。
3. **缺少阶段完成门。** 标题只定义批次与父项；多批组成一个阶段时，执行者可能把一批 done 误报为阶段 done。
4. **依赖环可使事件永不触发。** 两个事项互等对方 done 时，字段形式完整却永久 blocked；规则没有依赖／触发可达性检查。

## 反例走查

- 只接链接、不接关闭责任：现文能拒绝，但合法完整转移会遇到状态缺口。
- 法规变化使事项不再正确，且独立方批准：现文可证据化标 `retired`，无 false-red。
- 两事项互相依赖：现文会记录成 blocked，但不会强迫发现环，形成无限延期。
