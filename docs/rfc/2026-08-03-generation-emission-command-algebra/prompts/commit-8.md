# Kick-off：Commit 8 —— 文档同步与 merged-state 收口

<!-- prompt-task-ids: T8.1 T8.2 T8.3 T8.4 T8.5 T8.6 T8.7 -->

## 背景 + 为什么

Commit 8 只在 runtime/API population/goldens 已稳定后同步 live docs、supersede 关系、deferred items 与 merged-state review。文档不承担推迟迁移；也不能用文档重写替代未裁用户决定。

## 必读

- `docs/rfc/2026-08-03-generation-emission-command-algebra/design.md`：§6、§7.11、§8、§9.1 Q2、§10.4。
- `docs/rfc/2026-08-03-generation-emission-command-algebra/cutover-plan.md`：Commit 8、§0.4d、§11 状态表。
- `docs/rfc/2026-08-03-generation-emission-command-algebra/traceability.md`：T8.* 反向出处。
- `docs/plan/2026-07-27-inter-block-anchor-allocator/HANDOVER.md`：上游/已裁决。
- `docs/rfc/2026-08-03-generation-emission-command-algebra/prompts/README.md` 与进度文件。

## 前置/停点

- Commit 7 已收口。
- **Q2（richest-data-flow ADR）**：是否给 `docs/decisions/2026-07-05-richest-data-flow.md` 补 owner-minted provenance 说明；默认不改，未经用户明确同意不得编辑。
- **continuation ADR D2 不属于本 RFC 的 Commit 8**：它仍归原计划 P8（design §8 已明确）。本 phase 只核其待办/停点未被 supersede 或删除，**不产 replacement、不编辑 ADR，也不把它当本 RFC docs closeout 的阻塞项**。
- 所有本 RFC §11 未裁项应已在各自触发点取得首次裁决；T8.7 要独立核对这一点。

## 改动锚点

| 文档 | 用途 |
|---|---|
| `docs/rfc/2026-08-03-generation-emission-command-algebra/prompts/README.md` | C1～C11 live contract |
| `docs/DESIGN.md` | 活架构现状/类型架构 |
| `docs/plan/2026-07-27-inter-block-anchor-allocator/` | M2～M4 supersede、M5～M8 重锚 |
| `docs/todo/deferred-backlog.md` | §8 范围外 deferred |
| `docs/decisions/2026-07-05-richest-data-flow.md` | **仅 Q2 用户同意后**可编辑 owner-minted provenance 说明 |
| `docs/decisions/2026-07-22-continuation-retry-sequential-anchor.md` D2 第 3 点 | **只核 P8 待办仍在**；本 RFC 不出 replacement、不编辑该 ADR |

## 本 phase task 集合（唯一归属）

<!-- prompt-task-ids: T8.1 T8.2 T8.3 T8.4 T8.5 T8.6 T8.7 -->

- `T8.1`：README C1～C11 + RFC R-6 分段文字同步；辅助门同样阻断交付的措辞对齐。
- `T8.2`：anchor 精确帧序作为 C1～C11 外独立契约。
- `T8.3`：DESIGN 活架构/类型架构同步。
- `T8.4`：旧 plan supersede，不删除 O-9/后续路线；continuation ADR D2 replacement/审批仍归 P8，本 phase 只核待办可达。
- `T8.5`：权威文档 manifest + 契约轴 disposition。
- `T8.6`：telemetry/History docs 与 deferred items。
- `T8.7`：独立 merged-state review，核 §11 触发点裁决、doc↔code、commit↔plan。

## 验收 gate

R-11/O-6 与共同门；完成判定按 plan §10 逐项 verdict/证据，不能用一条全套绿折叠。生产变更判据按 plan §0.4a。

## 提交指引

精确 pathspec、Conventional Commit、无署名、绝不 push；文档/progress 同 phase commit。Q2 若未获用户同意，不把「默认 B」写成用户裁决；continuation ADR D2 属 P8，**本 phase 不提交 replacement 或 ADR 修改，只验证其待办未被删除**。

## 红线

见 `docs/rfc/2026-08-03-generation-emission-command-algebra/prompts/README.md`。特别禁止：擅改 ADR D2、把 supersede 写成删除、声称「除列举外无冲突」却未做 T8.5 manifest 审计。