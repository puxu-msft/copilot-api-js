# Kick-off 提示词：per-model 流超时（stream idle + response header timeout override）

用于开启一个新会话 / 派给 subagent 实施本计划。复制以下提示词到新会话即可开始。

---

## 提示词正文（可直接复制）

你要实施 `copilot-api-js` 项目的一个已定稿特性：per-model 流超时 override。请先完整阅读以下三份文档，再动手：

1. **权威 spec**（做什么/为什么，已两轮对抗评审+coordinator 亲手核验，不要重新质疑其架构结论）：`docs/spec/2026-07-12-per-model-idle-timeout.md`
2. **本实施计划**（怎么做，含分阶段/文件清单/TDD 步骤/验收判据）：`docs/plan/2026-07-12-per-model-idle-timeout.md`
3. 项目级指令：`CLAUDE.md`（尤其 `subagent-explicit-rubric`、`tdd`、`sync-plan-with-impl`、`dont-stop-if-clear` 几条纪律）

## 背景一句话

GHC 的 gpt-5.5（`reasoning.effort=high`）真实响应形态是单个 400s+ 零帧静默（实测地板 462s），我方 300s 的 app-level 流空闲 guard（`state.streamIdleTimeout`）会掐死这个合法长响应。修法 = per-model override 两个 knob（`stream_idle` + `response_header`），内置 `gpt-5.5:600`，复用项目既有 `Record<模型子串,值> + "*" + findMostSpecific` 范式。**两个 knob 都是纯 app-guard，不碰 undici/transport**（v1 曾误提 undici backstop 联动，已在 spec §7 证伪并删除——不要重新引入这个方向）。

## 你的任务

按计划文档的 **Phase 1 → 2 → 3 → 4** 顺序实施（Phase 1 是前置依赖，2/3 互相独立可并行，4 的两个子任务 4a/4b 互相独立可并行）。每个阶段：

1. **先写失败的测试**（TDD），测试清单在计划文档对应阶段的「TDD 步骤」小节——照做，不要跳过任何一条（尤其 INV-1 的"user 写空对象 `{}` 不能抹掉内置 600"这条，是 H3 教训的直接回归防线）。
2. 实现代码，让测试转绿。
3. 跑 `bun run typecheck`、`bun run lint:all`（或项目当前等效命令，若命名有变以 `package.json` scripts 为准）、相关 `bun test` 路径全绿。
4. 每个阶段完成后按 conventional commits 提交（显式 pathspec，不加模型署名）：例如 `feat(config): add per-model stream_idle/response_header override schema` 这类。**别把 4 个阶段攒成一个大提交。**
5. 阶段之间如无矛盾/破坏性操作/新分叉，直接推进下一步，不要每步都停下来问"接下来做 A 还是 B"——计划已经把顺序定清楚了。

## 已知的实现难点（计划文档已给出建议方案，但需要你现场验证可行性）

- **Phase 4a**：`ctx.setPipelineInfo()` 是全量替换语义，4 个既有生产调用点会覆盖你新加的 `streamIdleTimeoutMs` 字段。计划建议开一个平行的 `_streamTimeouts` 私有状态 + 一个 `mergedPipelineInfo()` 合并函数，getter 和终态组装两处都要过这个合并函数。**这是本计划里风险最高的一步，实现后务必让计划中列出的"先 setStreamTimeouts 后 setPipelineInfo / 反序"两条单元测试都跑一遍**，不要只测其中一种顺序。
- **Phase 4a 的调用点已被 2026-07-12 对抗评审定死，不要按直觉抄 messages 端点的写法**：`codec.getContext()` 在 chat-completions/responses/gemini 3 个端点的 Phase 2 threading 行（transport 构造处）恒为 `undefined`（codec 的 `parse()` 要到 `driver.runRequest()` 内部才关联 ctx），messages 因为有 eager ctx 创建能侥幸在早期拿到、**极易诱导你误以为其余端点也行**——实际会导致 3/4 端点静默丢字段（`?.` 不报错）。计划已把调用点统一定死为 `driver.runRequest()` 结算后、`result.ok===true` 分支内的 `result.env.ctx.setStreamTimeouts(...)`（5 个端点用同一模式，含 messages——**不要**给 messages 抄近道用 `codec.getContext()`），并**强制要求 5 条独立集成测试**（不是挑一个测），逐条按计划 Phase 4a「改法表格」落地。
- **Phase 2/3 的测试 mocking**：Bun test 对 ESM 具名导出函数做 spy 有限制，先 `grep -rn "mock.module"` 项目现有测试，抄现成手法，别自己发明。
- **INV-5 的 grep oracle 不是"全局 grep 归零"**：`src/lib/proxy.ts` 有多处合法保留的 `state.streamIdleTimeout` 标量读取（服务 undici/SearXNG，spec §7.3 明确不动），验收判据是"逐点核对 Phase 2/3 各自的读点/调用点清单"，不要为了让全局 grep 结果"更干净"去误改 `proxy.ts` 里合法的标量代码。
- **§7.4 反证守卫的 grep 目标是 `src/lib/proxy.ts`（不是 `src/lib/transport/proxy.ts`——后者不存在）**，且只 grep override 侧字段名（`streamIdleTimeoutOverrides`/`responseHeaderTimeoutOverrides`），不要 grep 标量 `state.streamIdleTimeout`（会对 `proxy.ts:105` 的合法代码报假阳性）。
- 计划文档末尾「已知开放点」列了 3 条需要你现场判断的实现细节（参数排布、reverse-translate leg 排除范围等）——按判据自行决定，不构成需要停下来问用户的分叉；但如果你发现任何一条的答案会改变 spec 已定的目标/架构（比如发现某个设计假设根本不成立、需要新的跨模块协议），**停下来报告，不要自行改变架构合同**。

## 收尾

实施全部 4 个阶段后：
1. 跑一次合并态自查（7+7 个读点/调用点是否有遗漏，逐点核对清单，**不是**跑全局 grep 看数字归零——`src/lib/proxy.ts` 有合法保留的标量读取）。
2. 更新 `docs/DESIGN.md`「活的架构现状」表 + 配置表（新增 2 行）。
3. 落 ADR `docs/decisions/2026-07-12-per-model-idle-timeout-is-app-guard-only.md`（Phase 4b）。
4. 用一个**独立的 subagent**（不要自审）评审全部改动的合并态——重点检查：7+7 个读点是否真的全部切到 resolver、`_streamTimeouts` 设计是否真的不影响 4 个既有 `setPipelineInfo` 调用点、Phase 4a 的 5 条集成测试是否都真的验证了对应端点（而非只测了 messages）、bundled `config.yaml` 改动是否通过 `bundled-config.unit.test.ts`。
5. 按 `docs/plan/2026-07-12-per-model-idle-timeout.md` 文末「跨阶段收尾」小节的其余条目逐条执行。
