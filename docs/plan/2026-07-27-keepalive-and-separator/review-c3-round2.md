# 第二轮复审报告

## 评审范围

- 已提交合并态：`39a2a0d9`、`53758f9a`、`5b5c8c14`、`8fb19a6e`、`848ba250`，当前 `HEAD=848ba250`。
- 重点：C3／prefill 400 的新 retry 判据、system 收尾证据、全量重命名与历史字段、config 旧键迁移、测试发现与 timing cache、一致性和诚实命名。
- 未修改任何被评审文件；探针仅写入 `/tmp`，隔离服务器仅使用 4142 端口并按监听 PID 精确停止，4141 主服务器保持运行。

## 已读取／执行的证据

- `git -C /home/xp/src/copilot-api-js log --oneline -6` 与逐提交 `git show`。
- 读取核心实现与测试：`/home/xp/src/copilot-api-js/src/lib/anthropic/sanitize/assistant-block-layout.ts`、`/home/xp/src/copilot-api-js/src/lib/codec/anthropic/poisoned-thinking-retry.ts`、`/home/xp/src/copilot-api-js/src/lib/anthropic/strip-all-thinking.ts`、`/home/xp/src/copilot-api-js/src/lib/anthropic/poisoned-thinking-match.ts` 及对应测试。
- 自建 `/tmp/review-poisoned-thinking-probe.ts`，覆盖多违规消息、`[tool,T,SEP]`、assistant/system 收尾、无 thinking／无可剥块、完整事故 payload。
- 读取并分析 `/tmp/prefill-400/entry.json`；另起当前代码隔离实例 `127.0.0.1:4142`，真实打 GHC 上游验证 system 与 assistant 收尾。
- 自建 `/tmp/review-config-alias-put-probe.ts`，实跑 `validateConfig`／`applyConfigToState` 与真实 `PUT /api/config/yaml` 路径。
- 运行相关测试、typecheck、目标文件 lint、测试发现矩阵与 timing cache 对账。

## 总体 verdict

**可合并，但全量重命名尚未真正闭合，建议合并后立即由 `gpt-souls:instruction-smith`／`gpt-souls:doc-writer` 修正活指令与文档，由 `gpt-souls:implementer` 收尾源码局部命名和 bundled config。**

- blocker：0
- major：0
- minor：4
- nit：1

## 逐项核验结论

### 1. HIGH 新判据

**结论：上一轮 HIGH 已修复。新判据在本轮要求的边界上未发现假阳或假阴。**

当前实现先执行真实 `stripAllThinking`，再对 C3 cue 要求三项合取：原 payload 存在 C3 违规、真实剥离结果不再存在任何 C3 违规、原对话不以 assistant 收尾。该实现位于 `/home/xp/src/copilot-api-js/src/lib/codec/anthropic/poisoned-thinking-retry.ts:72-98`，使用的布局原语位于 `/home/xp/src/copilot-api-js/src/lib/anthropic/sanitize/assistant-block-layout.ts:51-77`。

证据命令：

```bash
bun /tmp/review-poisoned-thinking-probe.ts
```

输出摘要：

- `classification tool-terminal-prefill`
- 两条都可治愈的违规消息：`retry`，两条 assistant 均剥为 `[tool_use]`。
- 一条可治愈加一条 `[tool,text]` 不可治愈：`abort`。
- `[tool,T,SEP]`：`retry`，真实 `stripAllThinking` 同时去掉 thinking 和精确 marker，结果 `[tool_use]`。
- assistant 收尾：`abort`。
- user 后 system 收尾：`retry`。
- `[tool,text]` 且没有可剥块：`abort`。
- `[tool,SEP]` 虽无 thinking，但有真实 strip 可删除的孤儿 marker：`retry`，结果 `[tool_use]`；这不是假阳，因为实际 payload 确实改变且 C3 被真实补救消除。
- 完整事故 entry：末条 role 为 `system`，结果 `retry`，`messages[36]` 从 `[thinking,tool_use,thinking]` 剥为 `[tool_use]`。

相关测试命令与结果：

```bash
bun test /home/xp/src/copilot-api-js/tests/anthropic/poisoned-thinking-retry.it.test.ts /home/xp/src/copilot-api-js/tests/anthropic/assistant-block-layout.unit.test.ts
```

结果：`62 pass, 0 fail, 10771 expect()`。

完整相关组：

```bash
bun test \
  /home/xp/src/copilot-api-js/tests/anthropic/assistant-block-layout.unit.test.ts \
  /home/xp/src/copilot-api-js/tests/anthropic/assistant-block-layout-protection-invariant.unit.test.ts \
  /home/xp/src/copilot-api-js/tests/anthropic/assistant-block-layout-terminal-order.it.test.ts \
  /home/xp/src/copilot-api-js/tests/anthropic/poisoned-thinking-retry.it.test.ts \
  /home/xp/src/copilot-api-js/tests/anthropic/quarantine-e2e.it.test.ts \
  /home/xp/src/copilot-api-js/tests/anthropic/strip-all-thinking.unit.test.ts \
  /home/xp/src/copilot-api-js/tests/config/anthropic-block-layout-config.unit.test.ts
```

结果：`81 pass, 0 fail, 10827 expect()`。

事故离线回放命令：

```bash
bun /home/xp/src/copilot-api-js/exp/thinking-terminal-block/probe-remote-c3-regression.ts /tmp/prefill-400/entry.json
```

输出摘要：客户端 `[thinking,text,thinking,tool_use]`；陈旧实例发出 `[thinking,tool_use,thinking]`；当前 master 产出 `[thinking,text,thinking,tool_use]`；全 39 条 assistant 消息满足 C1+C2+C3。

### 2. system 收尾不应按字面 prefill 拒绝

**结论：未采纳“末条必须是 user”的理由成立；上一轮该建议过严。正确排除条件是“末条为 assistant”，不是“末条不为 user”。**

事故证据分析：

```bash
bun -e '<读取 /tmp/prefill-400/entry.json，枚举 system 位置及前后 role>'
```

输出摘要：客户端与 upstream attempt 均有 system 消息位置 `1,16,19,32,35,38`；其中前 5 条 system 后紧跟 assistant 回复，末条 38 为 system。事故真正违规的 `messages[36]` 是 `[thinking,tool_use,thinking]`，不是 system 收尾本身。

更强的独立 oracle：我在 4142 启动当前代码隔离实例，确认监听 PID 后真实打 GHC 上游。请求结果：

- `messages=[user,system]`：HTTP 200，响应 text 为 `OK`。
- `messages=[user,assistant,user,system]`：HTTP 200，响应 text 为 `OK`。
- assistant 收尾控制组 `messages=[user,assistant]`：HTTP 400，正是 `This model does not support assistant message prefill...`。
- 非法位置控制组 `[user,assistant,system]`：HTTP 400，但错误是 system 必须跟在 user 后，而不是 assistant prefill；加一条 user 后的 system 立即恢复 200。

隔离服务器日志记录了两个 200 与 assistant-tail 400；结束后按 `ss` 查得的精确监听 PID `2228431` 执行 `kill 2228431`。最终：

```bash
ss -ltnp | rg ':4141|:4142'
```

仅余 4141 主实例 PID 192220，4142 已停止。

### 3. 全量重命名、config 旧键和历史旧字段

**结论：代码公共类型、主要调用点、schema、生成 schema 与新测试文件已改名；config 旧键迁移在 load 和 PUT 两条真实路径都有效；没有活代码读取历史 `destack`。但“全量重命名”本身并未闭合，详见 minor 发现。**

#### config 别名实跑

命令：

```bash
bun /tmp/review-config-alias-put-probe.ts
```

输出摘要：

- 原始磁盘：`anthropic.thinking_destack_strategy: insert_text`。
- `validateConfig`／`applyConfigToState` 后：effective config 为 `assistant_block_layout_strategy: insert_text`，`state.assistantBlockLayoutStrategy === "insert_text"`。
- 真实 `PUT /api/config/yaml` 更新无关 sibling 后返回 200。
- 写回磁盘删除旧键，新增 `assistant_block_layout_strategy: insert_text`，并保留更新后的 `strip_thinking_on_reject: false`。
- PUT reload 后 state 仍为 `insert_text`。

配置测试命令：

```bash
bun test \
  /home/xp/src/copilot-api-js/tests/config/config-compat.unit.test.ts \
  /home/xp/src/copilot-api-js/tests/config/anthropic-block-layout-config.unit.test.ts \
  /home/xp/src/copilot-api-js/tests/config/config-hot-reload.it.test.ts \
  /home/xp/src/copilot-api-js/tests/config/config-yaml-routes.http.test.ts
```

结果：`489 pass, 0 fail, 749 expect()`。

#### 历史旧字段读路径

检索命令：

```bash
rg -n 'SanitizationInfo|pipelineInfo.*sanitization|\.blockLayout\b|"destack"|destack:' \
  /home/xp/src/copilot-api-js/src \
  /home/xp/src/copilot-api-js/ui-v4 \
  /home/xp/src/copilot-api-js/tests
```

输出摘要：写侧只在 `/home/xp/src/copilot-api-js/src/lib/anthropic/sanitize/result.ts:124` 写 `info.blockLayout`；类型只在 `/home/xp/src/copilot-api-js/src/lib/history/types.ts:141-156` 声明 `blockLayout`；没有代码消费 `.destack` 或字符串键 `"destack"`。UI 对 `pipelineInfo` 是泛化展示，没有字段级 `destack` reader。因此旧 entry 的 `destack` 仍会作为持久 JSON 中的未知历史字段保留／展示，但没有任何活逻辑依赖它，不构成漏改读路径。

### 4. 测试发现矩阵与 timings

**结论：测试文件后缀与 discovery 守卫一致；timing cache 不留任何旧 rename path。`assistant-block-layout-terminal-order.it.test.ts` 没有 timing 项，但它的旧文件也从未有 timing 项，runner 对未知文件按 median 回退，因此不是本轮重命名回归。**

命令：

```bash
bun test \
  /home/xp/src/copilot-api-js/tests/infra/test-discovery-matrix.unit.test.ts \
  /home/xp/src/copilot-api-js/tests/anthropic/assistant-block-layout-terminal-order.it.test.ts \
  /home/xp/src/copilot-api-js/tests/anthropic/quarantine-e2e.it.test.ts
```

结果：`8 pass, 0 fail, 21 expect()`。

对账命令：

```bash
bun -e '<Glob 发现五类后缀测试，与 scripts/test-timings.json key 对账>'
```

输出摘要：发现 635 个测试文件，timing cache 441 项；没有任何 stale `destack-*` key。与本次改名相关的 cache key 已更新为：

- `tests/anthropic/assistant-block-layout-protection-invariant.unit.test.ts`
- `tests/anthropic/assistant-block-layout.unit.test.ts`
- `tests/config/anthropic-block-layout-config.unit.test.ts`

`assistant-block-layout-terminal-order.it.test.ts` 不在 cache；`scripts/parallel-test.ts:23-25,87-103` 明确 timing 是性能提示，未知文件用 median，故不会漏跑。

其他门禁：

- `bun run typecheck`：通过。
- 对本轮核心 source／test 文件执行定向 `bunx eslint ...`：通过，仅打印 `baseline-browser-mapping` 数据陈旧提示。
- `bun run lint:all`：全仓失败，但失败集中于本轮范围外的大量并发／既有文件；本轮核心目标文件定向 lint 通过。不能据此声称全仓 lint 绿。
- 三个相关 commit 执行 `git diff <sha>^ <sha> --check`：通过。

## 事实性发现

### [minor] `/home/xp/src/copilot-api-js/config.yaml:789-792` — bundled canonical config 仍使用旧键，导致每次启动走 compat 并告警

问题：`config.yaml` 仍写 `thinking_destack_strategy: move_blocks`，相邻注释也引用旧键和“de-stack”。但生成的 `/home/xp/src/copilot-api-js/config.schema.json:475` 只声明新键 `assistant_block_layout_strategy`。bundled config 是项目默认配置的 canonical source，不应自己依赖面向用户旧配置的 compatibility 层。

证据：

```bash
git -C /home/xp/src/copilot-api-js grep -n -E 'thinking_destack_strategy' HEAD -- config.yaml config.schema.json
bun test tests/config/bundled-config.unit.test.ts tests/config/config-schema-json-export.unit.test.ts
```

输出摘要：旧键只在 bundled `config.yaml` 出现；schema 只有新键。测试虽 `14 pass`，启动／测试均实际打印：`anthropic.thinking_destack_strategy is renamed to anthropic.assistant_block_layout_strategy`。隔离生产实例启动也打印同一警告。

修复建议：把 bundled key 改为 `assistant_block_layout_strategy`，同步两条注释为“assistant block layout repair”；compat 旧键只保留在 `/home/xp/src/copilot-api-js/src/lib/config/compat.ts` 及明确的迁移说明／迁移测试。

### [minor] `/home/xp/src/copilot-api-js/.claude/skills/ghc-anthropic-upstream/SKILL.md:16,20` — 活的操作 skill 仍指向旧 config 键和已删除判据

问题：第 16 行仍指导使用 `thinking_destack_strategy`；第 20 行声称 L2 依赖 `thinkingCausesToolTerminalViolation`，该符号已被删除，真实实现是 `hasToolTerminalViolation` 对真实 strip 前后各跑一次。这不是历史叙述，而是当前“已修”的操作说明，会让后续 agent 搜索不存在的符号并写回 deprecated config。

证据：

```bash
git -C /home/xp/src/copilot-api-js grep -n -E 'thinkingCausesToolTerminalViolation|thinking_destack_strategy' HEAD -- .claude/skills/ghc-anthropic-upstream/SKILL.md src
```

输出摘要：skill 命中两处；`src` 中不存在 `thinkingCausesToolTerminalViolation`，只有 compat 的旧键 literal。

修复建议：更新为 `assistant_block_layout_strategy`；将 C3 判据准确写成“真实 `stripAllThinking` 前后分别调用 `hasToolTerminalViolation`，并排除 `endsOnAssistantTurn`”。此类 instruction text 建议交给 `gpt-souls:instruction-smith`。

### [minor] `/home/xp/src/copilot-api-js/src/lib/anthropic/sanitize/index.ts:154-166`、`/home/xp/src/copilot-api-js/src/lib/anthropic/sanitize/result.ts:29-35,94-112`、`/home/xp/src/copilot-api-js/src/lib/history/types.ts:150-155` — 新职责下仍大量以 `de-stack`／`destacked` 命名

问题：公共 API 已改为 `repairAssistantBlockLayout`／`blockLayout`，但终末装配的局部变量仍叫 `destacked`，核心统计与 history 注释仍称“Terminal de-stack pass”“adjacent-thinking separation”。该 pass 现在会在完全没有 thinking 的 `[tool_use,text]` 上执行 C3 repair，故这些当前实现注释与局部变量仍然名实不符，正是本轮声称修复的同类问题。

证据：

```bash
rg -n 'destack|de-stack|destacked' /home/xp/src/copilot-api-js/src/lib/anthropic /home/xp/src/copilot-api-js/src/lib/history/types.ts
```

输出摘要：核心生产代码仍有多处当前职责描述；`sanitize/index.ts` 的返回值局部名为 `destacked`，而调用的函数已是 `repairAssistantBlockLayout`。

修复建议：局部变量改为 `layoutRepair`／`repairedLayout`；当前职责注释改为“assistant block-layout repair”。仅在解释历史机制、旧 marker 字面值或 compat 旧键时保留“de-stack”。

### [minor] `/home/xp/src/copilot-api-js/exp/thinking-terminal-block/probe-remote-c3-regression.ts:31` — 可复跑探针仍读已不存在的 `out.stats.destack`，输出假空证据

问题：探针是 spec 推荐的当前离线判定工具，但第 31 行仍打印 `out.stats.destack`。合并态字段已改为 `out.stats.blockLayout`，所以探针对确实发生的 repair 打印 `undefined`，削弱“payload 自证版本”的诊断价值。

证据：

```bash
bun /home/xp/src/copilot-api-js/exp/thinking-terminal-block/probe-remote-c3-regression.ts /tmp/prefill-400/entry.json
```

输出摘要：布局已正确修复且全量约束审计通过，但统计行打印 `=== destack stats === undefined`。

修复建议：改读 `out.stats.blockLayout`，标签改为 `block-layout stats`；最好追加断言 `repairedMessages > 0` 与 `toolTerminalRepairs`／`terminalRepairs` 的预期，避免探针再次“布局看似对、统计接线断了仍绿”。

### [nit] `/home/xp/src/copilot-api-js/tests/anthropic/quarantine-e2e.it.test.ts:5,88` 与 `/home/xp/src/copilot-api-js/docs/plan/2026-07-27-handover-server-tool-provenance.md:31,161` — 仍引用旧测试名／旧函数名／旧 config 键

问题：测试注释引用不存在的 `destack-terminal-order.test.ts`；当前 handover 仍说 `destackAdjacentThinking` 已落地，并指导实验配置 `thinking_destack_strategy: passthrough`。后者是活的接手文档，会触发 deprecated warning，且函数名不存在。

证据：

```bash
git -C /home/xp/src/copilot-api-js grep -n -E 'destack-terminal-order|destackAdjacentThinking|thinking_destack_strategy' HEAD -- tests/anthropic/quarantine-e2e.it.test.ts docs/plan/2026-07-27-handover-server-tool-provenance.md
```

输出摘要：上述四处均命中；tracked 新测试名为 `assistant-block-layout-terminal-order.it.test.ts`。

修复建议：更新活 handover 和测试注释。历史实施计划 `/home/xp/src/copilot-api-js/docs/plan/2026-07-07-thinking-quarantine.md` 可保留旧代码快照，但应在顶部明确“历史计划，现名见 2026-07-26 spec”，避免被当作当前命令复制。

## 主观建议

[建议] `/home/xp/src/copilot-api-js/tests/anthropic/poisoned-thinking-retry.it.test.ts:159-264` — 把本轮独立探针中的“两个都可治愈的违规消息”与“system 收尾可 retry”固化进正式测试 — 预期影响：当前代码已正确，但正式测试只有“一条可治愈＋一条不可治愈”和 assistant-tail，缺少合取判据的正向多消息控制与 system-tail handle 级断言 — 推荐直接复用现有 `envFor` 增加两个用例；system 上游行为已有本轮真 GHC oracle。

## 总体结论

**上一轮 HIGH 已被真实 strip-all 前后判据正确修复，system 收尾不等于 prefill 的反驳有事故数据与真 GHC 对照双证；当前没有 blocker／major，但“全量重命名”仍残留 bundled config、活 skill、当前源码注释／局部变量和可复跑探针四类 minor，应尽快收尾。**
