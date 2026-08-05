# Kick-off：Commit 6 —— Legacy definitions/exports 删除与 population 审计

<!-- prompt-task-ids: T6.1 T6.2 T6.3 T6.4 T6.5 T6.6 T6.7 -->

## 背景 + 为什么

C4 已让 A/B/C legacy population 归零；Commit 6 才删除 definitions/exports 和 test shells，同时保住 adversarial old-boundary 正控。这里不以「无 consumer」为理由删 test oracle。

## 必读

- `docs/rfc/2026-08-03-generation-emission-command-algebra/design.md`：§2.6、§7.9、§10.2 R-6/R-10。
- `docs/rfc/2026-08-03-generation-emission-command-algebra/cutover-plan.md`：Commit 6、§0.4a/§0.4e、§11。
- `docs/rfc/2026-08-03-generation-emission-command-algebra/traceability.md`：R-6 C6、R-10、T6.*。
- `docs/rfc/2026-08-03-generation-emission-command-algebra/prompts/README.md` 与进度文件。

## 前置/停点

Commit 5 已收口；C4 的 A/B/C/D invariants持续成立。R-6 C6 已裁为 production hard gate；RFC §10.2 分段文本若仍未同步，记录到 C8 文档同步，不自行重裁。

## 改动锚点

| 对象 | master `file:line` |
|---|---|
| `WireBlockAllocationPort` | `src/lib/pipeline/types.ts:319-332` |
| legacy session public surface | `src/lib/pipeline/delivery/session.ts:57-67` |
| session lookup/factory | `src/lib/pipeline/delivery/session.ts:90,95,100` |
| `OwnerRawSink` | `src/lib/pipeline/delivery/types.ts:12` |
| adversarial seam | `tests/pipeline/allocation-outside-owner-control.it.test.ts` |

## 本 phase task 集合（唯一归属）

<!-- prompt-task-ids: T6.1 T6.2 T6.3 T6.4 T6.5 T6.6 T6.7 -->

- `T6.1`：closure/inventory AST 重跑，先加旧调用点证红。
- `T6.2/3/4`：A/B/C legacy definitions/exports 删除；`commandPortActivation` 不存在即记录回报，不发明。
- `T6.5`：adversarial seam manifest/behavior/replacement migration gate；旧 symbol 被删时须具名 test-only replacement，不能只登记名字。
- `T6.6`：delivery concrete codec import guard + 违规样本。
- `T6.7`：任何 guard 放宽的独立裁决记录。

判据细节唯一以 plan Commit 6、RFC §10.2 为准。

## 验收 gate

R-10 production hard、R-6 C6 production hard、R-11/O-6 和共同门。four test-oracle categories/old-boundary positive control 保留；删除清单上的 legacy export 不得躲进「test-only retained」岔路。

## 提交指引

精确 pathspec；删除/测试/architecture guard 作为同一 semantic unit 审；Conventional Commit、无署名、绝不 push；进度随 commit 更新。

## 红线

见 `docs/rfc/2026-08-03-generation-emission-command-algebra/prompts/README.md`。不整文件恢复、不删除 adversarial seam 来让测试绿、不把 legacy export 伪装 test-only、不自行放宽 guard。