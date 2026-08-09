# Dispatch packet 生成器工作退休记录

> **状态：retired**
>
> **裁决日期：** 2026-08-08
>
> **裁决者：** 用户

## 退休对象

本记录终止批次 #8：把 `docs/plan/2026-08-06-nghttp2-cancel-series/KICKOFF.md` 内三份 dispatch packet 抽成共同模板、生成器或独立 packet 源，并增加语义／字节一致性检查。该工作不在产品运行路径，用户裁决“完整退役和封存这块工作”。

以下拟议产物不再创建，也不保留为 backlog、计划或待复议事项：

- dispatch packet 生成器；
- 共同模板或 `source.ts` 一类单一 packet 源；
- `--check` 生成一致性命令；
- 为该生成链新增的测试、设计文档和实施计划；
- 将三份 packet 去重作为后续工程目标。

## 调查结论

调查对象是 `KICKOFF.md` 中从“可复制 packet 0”到文件末尾的三份 packet。只读分析确认三者包含大段相同的 bootstrap、allowlist、路径 gate 与完成 gate；按行比较的相似度约为 92%～95%。这说明重复客观存在，但不改变退休裁决：它只影响一份已定稿交接快照的维护形状，不影响产品运行行为。

讨论中曾把“保持当前文本逐字节一致”当作迁移护栏。用户随后要求回到核心目标判断：若生成器不在产品运行路径，则不继续为该维护问题建立新代码、测试或证明基础设施。因此，字节匹配不是继续实施的产品目标，也不再作为未完成验收门。

## 冻结证据的地位

下列原件不修改、不移动、不重新生成：

- `docs/plan/2026-08-06-nghttp2-cancel-series/KICKOFF.md`；
- `docs/plan/2026-08-06-nghttp2-cancel-series/evidence-manifest.sha256`；
- 同目录 `review-factual-r10.md` 与 `review-successor-r10.md`；
- manifest 列出的其余历史证据。

理由不是这些文件仍属活跃实施入口，而是它们共同构成 `8635b180` 所冻结的点时证据集。`KICKOFF.md` 当前 SHA-256 为 `1842b7891f0b18b823363fc17192afc5d326382aacd8d98574e2dfa6bfd8ed00`，与 manifest 记录及 `8635b180` 中的 blob 相同。改写或移动任一对象都会破坏这条历史证明链。它们今后只按历史快照读取；不得据其存在重新启动已退休的 packet 生成器工作，也不得把其中的交接命令当作当前仓库状态。

本退休裁决不重新裁定原 NGHTTP2_CANCEL 产品问题、A3 剩余 correctness findings、A4 或 Phase B 是否仍需处理；这些产品事项各自由当前正式 spec、plan、todo 与代码状态决定。退休范围仅限 dispatch packet 的模板化／生成器化维护工作。

## 终态条件

- 用户退休裁决已记录。
- 生成器／模板／一致性测试／#8 设计与实施计划均未创建。
- `KICKOFF.md`、manifest 与 R10 历史证据保持原样。
- #8 的调查、设计和实施任务已从活跃任务列表移除。
- 本事项没有 open condition、复议触发点或接收父项；终态为 `retired`，不是 `done`、`superseded` 或 `transferred`。
