# Plan: 拦截清洗畸形 tool_use input —— 实现交接稿（plan-review 接线修正后）

> **实施状态：已完成**
> **落地**：—
> **现状锚点**：运行时选项 `toolRepairMalformedInput`；spec/anthropic-malformed-tool-input-repair.md
> **备注**：核心修复能力全落地；原三档枚举后被 tool-input-repair-composable-items 演进为可叠加项目集

> 对应 spec：[docs/spec/anthropic-malformed-tool-input-repair.md](../spec/anthropic-malformed-tool-input-repair.md)（已过两轮对抗审查 + 主线核验，§7 记接线修正）。
> 落地形态：扩展既有 `src/lib/anthropic/decode-tool-input.ts` 解码器 + handler fail 信号（**挂 ctx 非 acc**），配置 `anthropic.tool_repair_malformed_input: false|"tags"|"repair"`，默认关。
> 范围：仅 Anthropic 路径。commit invariant：每个 phase 的 commit 都让系统**绿且不半坏**（`false` 时逐字节同前）。

## 命名 / 落点（已对照源码核验，符号名修正）

- 配置键：`anthropic.tool_repair_malformed_input`（`schema.ts` ~L294，紧邻 `tool_decode_input_fields`/`tool_recover_call_text`）→ state 字段 `toolRepairMalformedInput`。
- 新纯函数模块：`src/lib/anthropic/tool-input-repair.ts`（Layer 1 + Layer 2 + 编排，纯函数）。
- 解码器：`src/lib/anthropic/decode-tool-input.ts` —— `finalize`（L159-168，parse 成功原样 replay `rawDeltas` L168；失败经 `report` L167）；缓冲选择 `shouldDecodeToolInput`（content_block_start guard ~L193-198）；server 排除 `block.type==="tool_use"`（L194，注释 L152）；`buildInputJsonDelta`（L136，re-emit 单帧、`event` 继承 template）；回调 `ToolInputRewriteOptions.onDecodeFailure`（L61）+ `DecodeFailureInfo.reason`（L41）+ 默认 sink `reportDecodeFailure(info, ctx)`（L97）。
- decode rewrite 装配：`src/lib/codec/anthropic/response-rewrite-adapters.ts` —— `appliesTo`（L192-193，**须加 repair 开关**）、`createState` 里 `createToolInputStreamDecoder({fields,all},{backfillAskUserQuestionHeader,onDecodeFailure})`（L195-200）、`transformWhole`（L208-216）。
- fail 信道：`DecodeFailureInfo.reason`（L41）加 `"input-unrepairable"`；信号经 `onDecodeFailure` 闭包置 **`env.ctx`** 标志（**非 acc**——`acc` 在 buffered-retry `onAttemptReset` 被重建 `handler-v4.ts` L863-864、会清掉）；handler complete-分支 **L949-984**（现读 `acc.streamError` L960 / `!acc.sawMessageStop` L965）增读 ctx 标志。
- 非流式 fail：`renderNonStreamingV4` 调 `runResponseWhole` 后（`handler-v4.ts` L681/695 区，现 `anthropicNonStreamingTruncation` gate 旁）读同一 ctx 标志（`runResponseWhole` 无错误返回通道）。
- FeatureKind：`src/lib/observability/events.ts` L113 封闭联合，加 `tool-input-repaired`/`tool-input-unrepairable`（**首个打 tag 的 phase 前置**，见 P3）。
- 依赖：`jsonrepair`（装最新稳定，记录实际版本回填 spec §2.3；纯 JS 无 node-gyp）。

## P0 — 依赖 + 配置 + FeatureKind（接线但 default-off，零行为）

- `bun add jsonrepair`（验 `find node_modules -name binding.gyp` 仍空；记版本号）。
- `schema.ts`：加 `tool_repair_malformed_input`（`z.enum(["tags","repair"]).or(z.literal(false))`，缺省 `false`）。`config.ts`/`state.ts`：`toolRepairMalformedInput`；`applyConfigToState` retain-on-absence 接线。
- **FeatureKind 前置**：`events.ts` L113 加 `tool-input-repaired`/`tool-input-unrepairable`（避免 P3/P4 调 `recordFeature` 时 typecheck 红）。
- **测试**：`config/config-hot-reload.it.test.ts` 矩阵加键（完整性守卫强制）；schema 三值校验 + 非法值拒绝。
- **commit invariant**：配置可读、默认 false、解码器尚未消费它、FeatureKind 多两个未用项 → 零行为、绿。
- commit：`feat(config): add tool_repair_malformed_input flag + repair feature kinds (inert)`

## P1 — Layer 1 结构感知剥 antml 标签（纯函数，隔离未接线）

- `tool-input-repair.ts` 导出 `stripAntmlTagsOutsideStrings(input: string): string`：轻量 JSON 词法扫描，剥**字符串字面量之外**的 `</invoke>`/`</parameter>`/`<invoke …>`/`<parameter …>`（处理 `\"` 转义判别字符串边界）。
- **测试**（`tests/anthropic/tool-input-repair.unit.test.ts`，先 RED）：1304 真实字节（落 `tests/fixtures/`）→ 剥后 `JSON.parse` 成功+语义等价；误伤反例（字符串值合法含 `"</parameter>"` 字面量不动）；中置 `{"a":1</parameter>,"b":2}`、单层对象 `{"a":1</parameter></invoke>}`、多块各自 bleed；happy-path 合法 input 逐字节不变。
- **commit invariant**：additive 纯函数 + 测试、无消费者、绿。
- commit：`feat(anthropic): structure-aware antml-tag stripper for tool input (unwired)`

## P2 — Layer 2 jsonrepair 包裹（纯函数，隔离）

- 导出 `tryJsonRepair(input: string): string | undefined`：**try/catch 包 `jsonrepair`**（实测对 antml-bleed throw `Colon expected`，必须吞）→ re-parse gate（仅 `JSON.parse` 通过才返回）。
- **测试**：965 真实字节 → 修复后 parse 成功**且含真实中文汉字、无字面 `\u` 残留**（语义保真，§7-C2 锁）；1304 → throw 被吞 → undefined；合法 input → 不变。
- **commit invariant**：纯函数 + 测试、未接线、绿。
- commit：`feat(anthropic): jsonrepair-backed tool input repair layer (unwired)`

## P3 — 分层编排 + 解码器集成（接线，gated；off 时逐字节同前，on 时合法块时序变化）

- 导出 `repairToolInput(raw, mode): {repaired}|{unrepairable}`（Layer1→revalidate→[repair]Layer2→revalidate）。
- `decode-tool-input.ts`：① 新增 repair 模式参数（经 `createToolInputStreamDecoder` 的 cfg/opts 传入）；repair 开时 content_block_start guard（L193-198）的缓冲集扩到**所有** `tool_use`（`server_tool_use` 仍排除 L194）；② `finalize` parse-失败分支调 `repairToolInput`：`repaired` → 修复对象走既有 decode/backfill + `buildInputJsonDelta` re-emit；`unrepairable` → **暂走既有 `report`/原样 replay**（本 phase 不接 fail，退化为现状）。
- `response-rewrite-adapters.ts`：**`appliesTo`（L192-193）加 `|| state.toolRepairMalformedInput !== false`**；`createState` 把 repair 模式传进 `createToolInputStreamDecoder`。
- **测试**（`.http`）：1304/965 真实帧序 fixture（tags/repair 各档）→ 转发 input 合法、history `sseEvents` 保原貌、**re-emit 帧过 `assertEventLineInvariant`**（合成 input_json_delta 须带正确 event 行，防 SDK 静默丢帧）；server_tool_use 不动；**`false` 下 golden 逐字节同前**。
- **on 时序说明**（非缺陷）：repair 开后，原先未缓冲的合法工具（如 TodoWrite）改为 stop 时整块到达（同 recover/decode 既有延迟）；`finalize` 对未变 input 原样 replay `rawDeltas`（L168）**不重打包**，内容仍 byte-identical。golden（拼串）锁内容、不锁时序——这是有意变化。
- **commit invariant**：可修的修好、不可修的同现状（client 拒）→ 无回归、绿。
- commit：`feat(anthropic): wire malformed tool-input repair into decoder (repairable path)`

## P4 — fail 信号通道（C1，不可修复 → handler fail，信号挂 ctx）

- `decode-tool-input.ts`：`DecodeFailureInfo.reason`（L41）加 `"input-unrepairable"`；`unrepairable` 分支 `report({tool, reason:"input-unrepairable", rawBytes})`。
- `response-rewrite-adapters.ts`：`createState` 的 `onDecodeFailure` 闭包（已 over `env.ctx`，L199）在收到 `input-unrepairable` 时置 **`env.ctx`** 标志（如 `ctx.sawUnrepairableToolInput`）。
- `handler-v4.ts`：complete-分支 **L949-984**（`acc.streamError` L960 / `!acc.sawMessageStop` L965 旁）增读 ctx 标志 → `env.ctx.fail(...)` + `sink.writeSynthetic(anthropicErrorFrame("invalid_request_error", …))`。**叠加定序**：unrepairable 判在 `acc.streamError` 之后；与 truncation（`!sawMessageStop`）同档时，二者 error 帧二选一，定 unrepairable 优先（更精确的根因）并注释理由。
- **测试**：构造 strip+jsonrepair 都修不了的 input → e2e 整条信道 → **测可观测行为**（fail + 合成 error 帧 + history 记失败 + 残缺投影），不锁内部字段名；**buffered-retry 信号不丢**（断言 `onAttemptReset` 重建 acc 后 ctx 标志仍在——若误挂 acc 此测 RED）；四象限 gate（`block_stop✓+message_stop✗`、`block_stop✓+stop_reason≠tool_use`）。
- **commit invariant**：完整 fail 行为上线。
- commit：`feat(anthropic): fail unrepairable tool input via decoder→ctx→handler signal`

## P5 — 非流式 transformWhole

- `response-rewrite-adapters.ts` decode `transformWhole`（L208-216）：对 `input` 为字符串且非法的 `tool_use` 块走 `repairToolInput`；`unrepairable` → `onDecodeFailure` 闭包置同一 `env.ctx` 标志。
- `handler-v4.ts`：`renderNonStreamingV4` 调 `runResponseWhole`（L681）后、`anthropicNonStreamingTruncation` gate（L695 区）旁增读 ctx 标志判 fail（`runResponseWhole` 无错误返回通道）。
- **测试**：非流式 fixture（合成 string-input 畸形）→ repair 成功改对象、不可修 → fail（可观测行为）。
- **commit invariant**：非流式平行覆盖。
- commit：`feat(anthropic): non-streaming malformed tool-input repair (transformWhole)`

## P6 — 观测（richest-data-flow）

- telemetry：经既有 `request-telemetry` registry 加计数（layer/tool/outcome）；ctx feature tag（用 P0 已加的 FeatureKind）；`[REWRITE] tool-input-repair` 日志（layer+tool+前后长度）。
- per-entry 审计 diff：确认"修前 sseEvents vs 修后 inboundResponse"两腿可派生 diff，**无需新列**。
- **测试**：feature tag 置位、telemetry counter 递增、日志格式。
- **commit invariant**：观测完整。
- commit：`feat(observability): telemetry + feature tags for tool-input repair`

## P7 — doc-sync（非代码，无需 verify）

- DESIGN.md「活的架构现状」表：tool-input 解码器行补"含畸形修复 + ctx-信号 fail"。
- DESIGN.md「运行时选项」配置表：加 `tool_repair_malformed_input` 行（三值 + 覆盖率诚实标注：`tags` 仅修 antml-bleed、结构类需 `repair`）。
- DESIGN.md 改写词汇 / 模块图：decode 解码器职责更新。
- 删本特性过时 pending 记忆、活文档回填；回填 jsonrepair 实际版本号到 spec §2.3。
- commit：`docs: sync DESIGN for malformed tool-input repair`

## 验收 / 测试矩阵

| Phase | 关键测试 | 验证命令 |
|---|---|---|
| P0 | hot-reload 矩阵 + schema 校验 + FeatureKind typecheck | `bun run test:backend` + `bun run typecheck` |
| P1 | 剥标签真值 + 误伤反例 | `bun run test:unit` |
| P2 | jsonrepair 965 语义保真 + 1304 throw 吞 | `bun run test:unit` |
| P3 | 流式 fixture 三档 + event-line 不变量 + golden off | `bun run test:http` + `bun run test:backend` |
| P4 | C1 信道 e2e（可观测行为）+ buffered-retry 信号不丢 + 四象限 | `bun run test:http` |
| P5 | 非流式 repair/fail | `bun run test:backend` |
| P6 | feature tag + telemetry | `bun run test:backend` |
| 收尾 | 全套件 + lint + subagent whole-domain audit | `bun run test:backend` + `bun run lint:all` |

## 纪律提示

- **并发会话**：共享 index。提交严格 `git add -- <精确路径>` + `git diff --cached --stat` 复核，**绝不** `git add -A`。lint-staged lint 全 index 暂存的 .ts → index 里有 peer 坏 WIP 会挡你 commit；非 .ts（doc/spec）可 `git commit --no-verify -- <pathspec>` 精确只提自己且不扰 peer（skill `git-commit-discipline:avoiding-shared-worktree-conflicts`）。
- **TDD**：每 phase 先 RED 再 GREEN 再重构。真实帧 fixture（1304/965 字节落 `tests/fixtures/`）优先于合成。
- **不启服务器**：`bun run test:backend` 等（非 `npm run`）。
- **off 即 byte-identical / on 是时序变化**：`false` 下逐字节同前（golden lock）；on 时合法块时序变（有意，同 recover/decode），内容仍 byte-identical。
