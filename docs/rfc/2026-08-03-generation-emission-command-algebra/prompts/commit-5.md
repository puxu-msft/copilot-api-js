# Kick-off：Commit 5 —— Per-command telemetry 与 History detail

<!-- prompt-task-ids: T5.1 T5.2 T5.3 T5.4 T5.5 T5.6 T5.7 -->

## 背景 + 为什么

Commit 5 增加 rich generation operation detail 与 bounded telemetry projection，不新增 emission/state authority；wire 不变。它的输入是 C4 已闭合 authority，而不是 telemetry 反过来证明 boundary。

## 必读

- `docs/rfc/2026-08-03-generation-emission-command-algebra/design.md`：§4.7～§4.12、§7.8、§9.1 Q1、§9.3 #6、§10.2 R-9。
- `docs/rfc/2026-08-03-generation-emission-command-algebra/cutover-plan.md`：Commit 5、§0.4b/§0.4d。
- `docs/rfc/2026-08-03-generation-emission-command-algebra/traceability.md`：R-9、Q1 停点、T5.* 反向出处。
- progress 文件与 `docs/rfc/2026-08-03-generation-emission-command-algebra/prompts/README.md`。

## 停门

**Q1 内容仍未裁。** 用户只裁「现在不裁，到 Commit 5 前再说」；A/B/C 未选。**Q1 未裁，本 prompt 不进入任何 task。** 先在本触发点取得首次裁决、同步 RFC + carriers，然后运行：

```bash
cd /home/xp/src/copilot-api-js && PHASE=post exp/inter-block-anchor-allocator/q1-locations.sh
```

rc=0 才可开工；不得用 PATH 上不存在的 `q1-locations.sh` 简写，也不得把「首次裁决」误读成 README 禁止的“重裁”。

## 改动锚点

| 对象 | master `file:line` | 用途 |
|---|---|---|
| dimension registry | `packages/telemetry/src/dimension-names.ts:19-64` | bounded fields |
| settled aggregation | `packages/telemetry/src/request-telemetry.ts:337-407` | measures |
| telemetry runtime | `packages/telemetry/src/runtime.ts:67-100` | `recordSettled` |
| telemetry sink | `src/lib/observability/sinks/telemetry.ts:31-103` | 唯一 registry feed |
| History partial | `src/lib/history/types.ts:217` | stable summary 对照 |

## 本 phase task 集合（唯一归属）

<!-- prompt-task-ids: T5.1 T5.2 T5.3 T5.4 T5.5 T5.6 T5.7 -->

- `T5.1` bounded accumulator 与独立完整 History append-only leg；cap 四档与双腿 mutation。
- `T5.2` bounded canonical registry/normalizer。
- `T5.3` success/failure canonical key set 对账。
- `T5.4` phase/partial measures。
- `T5.5` Q4 双层 History schema + ui-v4 re-export/tests。
- `T5.6` Umzug/store 四层 round-trip。
- `T5.7` R-9 可诊断性。

详细 TDD/mutation/false-red 以 plan Commit 5 + RFC §10.2 R-9 为准。

## 验收 gate

R-9 auxiliary（失败同样阻止交付但不升级 closure）、Q1 post gate、R-11/O-6 与共同门。production legacy population 持续零，telemetry 不得获得 emission/state authority。

## 提交指引

精确 pathspec；`packages/telemetry/**`、History、observability、ui-v4 共享文件按本 phase 一起审；Conventional Commit、无署名、绝不 push；进度随 commit 更新。

## 红线

见 `docs/rfc/2026-08-03-generation-emission-command-algebra/prompts/README.md`。Q1 未裁不得开始；不私建 command event store；不让 telemetry 充当 behavior closure oracle；不碰 4141。