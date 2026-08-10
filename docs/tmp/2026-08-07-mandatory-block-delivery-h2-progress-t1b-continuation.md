---
slug: t1b-continuation
status: completed
base: d83218a4bdcbf5928c34294e6385d7ca9107f9c7
branch: agent-a5c59dd66952edb78
worktree: /home/xp/src/copilot-api-js/.worktree/agent-a5c59dd66952edb78
plan: docs/plan/2026-08-07-mandatory-block-delivery-h2-observability/plan-1-sse-and-delivery-foundation.md
agent-id: a5c59dd66952edb78
session-id: unavailable
continuity: 须连续；原 implementer transcript 物理不可达，旧 worktree 仅只读参考。
---

# Task 1b 接力实施进度

## 接力来源

- 起点 `c972a946` 缺少原候选链，已按用户指令非破坏性 cherry-pick `130b9c36 f2ec190b 42490038 608b0dc0 e3a02282 c4c2824a 737dc19e ff6972b0 3cd33f48`，本树对应新 SHA 为 `937027bd 2852814b 3bcfe403 55e00cdb fafde806 d564b908 4db592f3 9769bb8b d83218a4`。
- 原树 `/home/xp/src/copilot-api-js/.worktree/agent-a52f4205c72531f71` 只读；交接事实来自其 `.superpowers/sdd/task-1b-report.md` 与既有 `docs/tmp/2026-08-07-mandatory-block-delivery-h2-progress-t1b.md`。

## 整改中间态

- 初轮定向验证曾为 119 pass／0 fail；其后发现并补入 `refusal-recovery` synthetic-origin transfer 的回归，故该数字只描述整改中间态，不是最终门。
- 第一轮整改修复 History V3 nested parsed-message projection、encoder 的 multiline `event`／`id` 与非法 `retry` 语义、direct parsed projection 的 synthetic origin transfer，以及 route reset fixture 与重复测试 decoder。
- 第二轮复审修复 NUL `id` fail-closed、public `createResponses` streaming 边界回投影为 plain `ServerSentEventMessage`；内部 pipeline rich carrier不变。
- 最终复审将 rewrite contract 显式分为 `preserve`（仅 identity re-emit）与 `fresh`（构造的 wire frame），移除 ID 值／shape 启发式；各 response rewrite producer 明确声明，fresh Anthropic producer 在构造时删除 parser current ID，合法 own same-value ID 保留。

## 剩余项

- 无实现剩余项。最终组合 Task 1b／S8／History／transport 门为 163 pass／0 fail；public Responses client 子集 9 pass／0 fail；typecheck 与 target lint 通过。
- 不跑完整 backend，按用户指令交由主集成树 deterministic gate。

## 在途意图

- 无未提交的半实现意图；最终组合门已通过，下一步仅提交本轮整改并交主会话安排双复审。

## 已作废的路子

- 不修改旧 worktree，不将 `ParsedSseFrame` 降级为扁平 frame 以绕开 History consumer。
- 不将 multiline `event`／`id` 按 data 字段重复编码，因为 WHATWG 仅采纳最后有效 field，无法与单一 projection 同源。
- 不把 route reset 放在 candidate-race 过滤的 `[DONE]` frame。
- 不保留两个手写测试 decoder 或用生产 encoder/parser作为唯一 wire oracle。
