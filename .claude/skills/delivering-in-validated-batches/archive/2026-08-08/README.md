# 分层迭代交付 skill 开发证据封存

## 状态

- 封存日期：2026-08-08。
- 用户裁决：停止继续实测该功能；完成 skill 文本、落盘并封存。除非未来用户重新决策，不再扩展场景、运行模型 grader 或追加复评。
- 活的执行入口：`../../SKILL.md`。
- 活的依赖身份清单：`../../dependencies.json`。
- 未来真实使用自验日志：`../../verification-log.md`。

## 已保留内容

`evals/` 原样保留开发期场景、runner、grader、validator、评审报告、处置记录、run matrix 和全部完整 envelope。网络／API 中断后的强制原会话 resume 纪律不追溯作废此前已经完整成功取得的样本；历史样本按其 envelope 绑定的 skill hash 与 evidence role 阅读。

## 最后完整检查点

在用户叫停继续实测前，最后一次完整通过的机械检查点输出为：

```text
frontmatter_bytes=323
skill_lines=202
markdown_files=8
checked_internal_links=2
resolved_skill_dependencies=6/6
evaluations=10
run_envelopes_verified=26/26
schema_1_successful_runs=21
schema_2_resumable_runs=5
prompt_hashes_verified=26/26
skill_hashes_verified=26/26
manifest_hashes_verified=26/26
grader_session_id=1a29dade-b989-47ea-afa0-161da408917c
grader_resume_count=1
bound_grading_evidence_lines=509/509
baseline_assertions=16/25
historical_assertions=80/80
current_assertions=25/25
validation=PASS
```

该检查点之后又完成了仅文本／基础设施修订：统一所有受治理对象的条件集合 schema、互斥状态优先级、授权终态条件处置、完整示例、外部 skill frontmatter 身份检查、runner／grader 同 session 强制 resume，以及“成功样本不追溯失效”的 evidence role。随后新增 case 11 和 6 份 current-v2 envelope；最新 grader 在机械行号校验阶段未完成，旧的 `final-grading.json` 仍是上一个完整成功检查点的产物。因此不得宣称封存时的最新文本已经通过扩展后的 32-run 评分或最终双绿复评。

## 证据边界

- 完整成功 envelope 继续作为其产生时 skill hash 下的历史证据，不因网络恢复纪律或后续文本修订而失效。
- schema-2 envelope 记录持久 session ID 与 resume 次数；其中一个 blocker 样本通过同一 session resume 补充了独立验收门。
- model grader 的 verdict 是可审计的模型判断，不是独立 ground truth；行号绑定只证明引用来自对应 run。
- runner 请求 safe mode、无 tools 等选项，但这不证明运行时没有继承任何项目／用户配置或指令。
- 自动触发、所有未来模型版本和全部项目治理形态均未被穷尽证明。

## 重新开启条件

只有新的用户决策才重新开启实测。届时从归档 runner／matrix 继承已有成功证据，失败调用必须用原 session 身份恢复；不得把重新开启解释为清空或重跑全部历史样本。
