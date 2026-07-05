# Prompts: 拦截清洗畸形 tool_use input —— 每 phase kickoff（接线修正后）

> **类型**：kick-off prompt —— 非独立 plan，实施状态见父 plan [anthropic-malformed-tool-input-repair-plan.md](anthropic-malformed-tool-input-repair-plan.md)。

> 配套 [anthropic-malformed-tool-input-repair-plan.md](./anthropic-malformed-tool-input-repair-plan.md) + [spec](../spec/anthropic-malformed-tool-input-repair.md)。每个 prompt 自含，可在新会话直接粘贴。实现前读 spec §2.0（折叠进 decode）、§2.4（fail 信号挂 **ctx 非 acc**）、§7+§7.1（实测核验 + 接线修正，尤其回调真名 `onDecodeFailure`、jsonrepair 真实行为）。

## 公共前置（每 phase 都适用）

copilot-api-js（Bun-first 代理）。读 `CLAUDE.md` + `docs/DESIGN.md`「活的架构现状」表。TDD：先写测试再实现。提交 `git add -- <精确路径>`、conventional commits 无署名、绝不 `git add -A`。不启服务器，验证用 `bun run test:backend`/`test:unit`/`test:http`/`typecheck`/`lint:all`（非 npm）。并发会话共享 index，提交前 `git diff --cached --stat` 复核；非 .ts 撞 lint-staged 可 `git commit --no-verify -- <pathspec>`。

## P0 — 依赖 + 配置 + FeatureKind

实现 plan P0。`bun add jsonrepair`（验 `find node_modules -name binding.gyp` 仍空、记版本）。`schema.ts`（~L294）加 `tool_repair_malformed_input`（`z.enum(["tags","repair"]).or(z.literal(false))`，缺省 false），config.ts/state.ts 加 `toolRepairMalformedInput`，`applyConfigToState` retain-on-absence。**`events.ts` L113 的 `FeatureKind` 前置加 `tool-input-repaired`/`tool-input-unrepairable`**（避免后续 phase recordFeature typecheck 红）。先写测试（RED）：`config/config-hot-reload.it.test.ts` 矩阵加键 + schema 三值校验。验收：默认 false、零行为。commit：`feat(config): add tool_repair_malformed_input flag + repair feature kinds (inert)`。

## P1 — Layer 1 结构感知剥标签（纯函数）

实现 plan P1。新建 `src/lib/anthropic/tool-input-repair.ts`，导出 `stripAntmlTagsOutsideStrings(input): string`——轻量 JSON 词法扫描，剥**字符串字面量之外**的 `</invoke>`/`</parameter>`/`<invoke …>`/`<parameter …>`（正确处理 `\"` 转义判别字符串边界）。**先写测试**（`tests/anthropic/tool-input-repair.unit.test.ts`，RED）：①`req_1782744516921_1304` 真实 TodoWrite input 字节落 `tests/fixtures/`，剥后 `JSON.parse` 成功+语义等价；②误伤反例——字符串值合法含 `"</parameter>"` 字面量**不动**；③中置 `{"a":1</parameter>,"b":2}`、单层对象 `{"a":1</parameter></invoke>}`、多块各自 bleed；④happy-path 合法 input 逐字节不变。未接线。commit：`feat(anthropic): structure-aware antml-tag stripper for tool input (unwired)`。

> 取真实字节：读 `~/.local/share/copilot-api/history.db`，entry `req_1782744516921_1304` 的 `sse_events` stage（zstd 解压、拼 idx2 的 input_json_delta）。

## P2 — Layer 2 jsonrepair 包裹（纯函数）

实现 plan P2。导出 `tryJsonRepair(input): string | undefined`：**try/catch 包 `jsonrepair`**（实测对 antml-bleed throw `Colon expected`，必须吞），成功后 re-parse gate（仅 `JSON.parse` 通过才返回）。**先写测试**：①`req_1782740067043_965` 真实字节 → 修复后 parse 成功**且含真实中文汉字、无字面 `\u` 残留**（spec §7-C2 锁）；②1304 真实字节 → throw 被吞 → undefined；③合法 input → 不变。commit：`feat(anthropic): jsonrepair-backed tool input repair layer (unwired)`。

## P3 — 分层编排 + 解码器集成

实现 plan P3。导出 `repairToolInput(raw, mode): {repaired}|{unrepairable}`（Layer1→revalidate→[repair 档]Layer2→revalidate）。改 `decode-tool-input.ts`：新增 repair 模式参数（经 `createToolInputStreamDecoder` cfg/opts 传入），repair 开时 content_block_start guard（L193-198）缓冲集扩到所有 `tool_use`（`server_tool_use` 仍排除 L194）；`finalize`（L159-168）parse-失败分支调 `repairToolInput`，`repaired`→修复对象走既有 decode/backfill + `buildInputJsonDelta` re-emit，`unrepairable`→**暂走既有 `report`/原样 replay**（本 phase 不接 fail）。**改 `response-rewrite-adapters.ts`：`appliesTo`（L192-193）加 `|| state.toolRepairMalformedInput !== false`**，`createState` 把 repair 模式传进解码器。**先写测试**（`.http`）：1304/965 真实帧序 fixture（tags/repair 各档）转发 input 合法、history 保原貌、**re-emit 帧过 `assertEventLineInvariant`**；happy-path 内容零改（注意 on 时合法块时序变为 stop 时整块到达，是有意变化、非缺陷，`finalize` 对未变 input 原样 replay rawDeltas 不重打包）；server_tool_use 不动；**`false` 下 golden 逐字节同前**。commit：`feat(anthropic): wire malformed tool-input repair into decoder (repairable path)`。

## P4 — fail 信号通道（C1，信号挂 ctx）

实现 plan P4。`decode-tool-input.ts`：`DecodeFailureInfo.reason`（L41）加 `"input-unrepairable"`，`unrepairable` 分支 `report` 它（携 tool 名 + 原始字节）。`response-rewrite-adapters.ts`：`createState` 的 `onDecodeFailure` 闭包（已 over `env.ctx`，L199）收到 `input-unrepairable` 时置 **`env.ctx`** 标志（**非 acc**——acc 在 buffered-retry `onAttemptReset` L863 被重建会清掉）。`handler-v4.ts`：complete-分支 **L949-984**（`acc.streamError` L960 / `!acc.sawMessageStop` L965 旁）增读 ctx 标志 → `env.ctx.fail` + `sink.writeSynthetic(anthropicErrorFrame("invalid_request_error", …))`；与 truncation 同档时 unrepairable 优先（更精确根因，注释理由）。**先写测试**：构造 strip+jsonrepair 都修不了的 input → e2e 信道 → **测可观测行为**（fail + 合成 error 帧 + history 失败 + 残缺投影），不锁内部字段名；**buffered-retry 信号不丢**（`onAttemptReset` 重建 acc 后 ctx 标志仍在）；四象限 gate。commit：`feat(anthropic): fail unrepairable tool input via decoder→ctx→handler signal`。

## P5 — 非流式 transformWhole

实现 plan P5。`response-rewrite-adapters.ts` decode `transformWhole`（L208-216）：对 `input` 为字符串且非法的 `tool_use` 块走 `repairToolInput`，`unrepairable`→`onDecodeFailure` 闭包置同一 `env.ctx` 标志。`handler-v4.ts`：`renderNonStreamingV4` 调 `runResponseWhole`（L681）后、`anthropicNonStreamingTruncation` gate（L695 区）旁读 ctx 标志判 fail（`runResponseWhole` 无错误返回）。先写非流式 fixture 测试（可观测行为）。commit：`feat(anthropic): non-streaming malformed tool-input repair (transformWhole)`。

## P6 — 观测

实现 plan P6。telemetry 计数（layer/tool/outcome，经既有 `request-telemetry` registry）+ ctx feature tag（用 P0 已加的 FeatureKind）+ `[REWRITE] tool-input-repair` 日志。确认修前/修后 diff 经 sseEvents/inboundResponse 两腿可派生、无需新列。测试 feature tag + counter。commit：`feat(observability): telemetry + feature tags for tool-input repair`。

## 收尾（全 phase 后）

doc-sync（plan P7）：DESIGN.md「活的架构现状」表 +「运行时选项」配置表（三值 + 覆盖率诚实标注）+ 改写词汇/模块图；删过时 pending 记忆、活文档回填、jsonrepair 实际版本回填 spec §2.3。跑 `bun run test:backend` 全绿 + `bun run lint:all`。派 subagent 做 whole-domain audit（按"长远正确+完整"轴，重点 C1 ctx-信号正确性 + buffered-retry 不丢、Layer 1 误伤面、golden off byte-identical）。commit：`docs: sync DESIGN for malformed tool-input repair`。
