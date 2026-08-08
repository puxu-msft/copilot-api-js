# 分层迭代交付 skill 评测

## 当前验收真相源

- `evals.json`：4 个初始场景，覆盖 scope creep、当前批 blocker、父项目关闭和合法外部依赖。
- `r2-evals.json`：6 个评审驱动场景，覆盖空壳父项转移、全 `TBD` 记录、批次／阶段／父项三层状态、依赖／触发环、非终态状态逃逸和交付状态转移。
- `run-eval.py`：在持久、可恢复的 `claude -p` session 中运行单一场景，并输出自描述 envelope；默认加载当前 `SKILL.md`，`--without-skill` 生成基线。
- `run-matrix.json`：冻结 26 次运行及 suite／case／model／mode／evidence role 映射。
- `runs/`：26 份完整 envelope；5 份 baseline、16 份历史成功 skill 样本、5 份绑定当前 skill hash 的发布验收样本。每份绑定 prompt、其实际 skill hash、模型与请求的运行选项，`sha256sum.txt` 再绑定逐文件内容。旧成功样本不因恢复纪律或当前 skill 演进而追溯失效。
- `final-grading.json`：每条 verdict 指向具体 run，并用原始 result 的行号及逐字原文作证据。
- `dependencies.json`：正文引用的 6 个外部 skill 接缝；`validate.py` 在当前运行环境解析它们。
- `validate.py`：机械证据完整性门。它核对 run matrix、envelope、prompt／skill／manifest hash、评分断言、原始证据行、依赖与链接；它不裁决 grader 的语义判断，语义终审由独立当前状态复评承担。

R1／R2 的历史发现链保留在 `review-*-r1.md` 与 `r{1,2}-dispositions.md`；已被最终 envelope／评分取代的中间评分摘要不再保留，避免形成第二套验收真相源。

## 结果

- 无 skill 的父项目关闭基线保留 5 份 envelope；绑定评分为 16/25，9 条红证明场景能区分错误状态。
- 16 份历史成功 skill 样本完整保留，绑定评分为 80/80；它们证明对应旧 skill hash 下的行为，不冒充当前版本验收。
- 5 份当前发布验收样本覆盖 blocker、父项关闭裁决、TBD 来源、依赖环和交付状态转移，绑定当前 skill hash，评分为 25/25；其中 blocker 样本通过同一 session ID resume 一次补齐独立验收门，`resume_count=1`。
- `validate.py` 实测：26/26 envelope、prompt hash、角色相应的 skill hash 与 manifest hash相符；509/509 条评分证据行与对应原始 result 逐字一致；6/6 外部 skill frontmatter 身份可解析。独立 grader 首次调用网络中断后在同一 session `1a29dade-b989-47ea-afa0-161da408917c` 原样 resume 一次完成，`grader_resume_count=1`。
- R1 评审发现的 transfer 洗债、裸 `TBD`、阶段误报与依赖环，以及最终评审发现的 `pending／ready` 状态逃逸与关闭点裁决权限，均已进入正文和冻结场景。

## 复跑

从仓库根目录运行：

```bash
python3 .claude/skills/delivering-in-validated-batches/evals/run-eval.py --suite core --id 1 --model opus
python3 .claude/skills/delivering-in-validated-batches/evals/run-eval.py --suite r2 --id 5 --model haiku
```

生成无 skill 基线：

```bash
python3 .claude/skills/delivering-in-validated-batches/evals/run-eval.py --suite core --id 3 --model opus --without-skill
```

runner 把 `SKILL.md` 作为显式 system prompt 注入，并请求 safe mode、禁用 slash commands 与 tools。新运行预分配持久 session ID；网络／API 中断时只用同一 session ID 原样 resume，不设妥协性重试上限，也不换模型或另开会话。明确 context-window 终态才交给容量交接协议。旧的 schema-1 成功 envelope 继续作为证据，不因恢复纪律升级而追溯失效；schema-2 新 envelope 额外记录 session ID 与 resume 次数。请求选项只能证明 runner 请求了这些模式，不证明运行时没有继承任何项目／用户配置或指令。

## 它没有证明什么

- 26 次运行不是统计意义上的模型总体成功率，也不证明所有未来模型版本都遵守本 skill。
- `run-eval.py` 显式注入正文，只验证**加载后的行为**；它不验证 description 在真实会话中一定被自动触发。自动触发只能靠 `SKILL.md` 自验表和 `verification-log.md` 的真实使用记录积累。
- grader 与被测模型仍属于模型 oracle；行号和逐字原文绑定证明“评分引用的确来自对应 run”，不证明 grader 的语义裁决天然正确。独立最终复评与未来真实使用仍需继续证伪。
- 场景覆盖当前已知失败面，不声称穷尽所有批次／阶段／父项治理形态。
