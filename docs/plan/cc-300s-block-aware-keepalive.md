# 修复 Claude Code 流式 300s「no chunks received」断连 —— block-状态感知 keepalive

## Context（为什么做这个改动）

用户报告 Claude Code 在长 opus thinking 静默（pre-content 沉默几百秒）时约 280s 断连，报 `API Error: Stream idle timeout - no chunks received`，现有 `event: ping` keepalive **无法阻止**。

**已实测确证**（`exp/cc-idle-280s/REPORT.md`，真实 `claude` 2.1.201 + 受控 mock，first-party watchdog 路径，三臂数字直读 cli.log 属实）：CC 2.1.201 的 watchdog 有两层——① byte-idle ~60s（任意字节重置，现有 ping@20s 压住它）；② **no-real-content 精确 300s（只有真实 `content_block_delta` 重置；`event: ping` 与 SSE comment 都不算 chunk）**。三臂：`ping`❌300s断 / SSE `comment`❌300s断 / **空 `thinking_delta`（`thinking:""`）✅存活 340s 完整收尾**。

修复方向（不被审查推翻）：keepalive 从 ping 改为**随当前 open block 类型的空 content delta**。**决策已定**：默认 `content_delta`；探索 web_search 专门方案。

**但 3 视角对抗审查暴露：覆盖设计依赖尚未实测的假设**（空 text_delta / 空 input_json_delta / prod-faithful 路径 300s 是否一致），且 web_search 阻塞静默期无 open block、content_delta 不适用。故本 plan **以补实测为 Phase 0 前置闸**，覆盖矩阵由实测结果定，不靠推断。

## 根因约束（实现须遵守）

- keepalive 空 delta 的 **index + type 必须匹配当前 open block**，否则违反协议、破坏客户端块状态机。
- 只有**已转发给客户端的 block** 才能对其发空 delta（L2 buffered 未 commit 前 sink 没转发 content 帧 → openBlock 空 → fallback ping，天然正确）。
- keepalive 只进 **forwarded 轨**，绝不进上游 `sseEvents` 轨（已核对：`client-sink.ts:192` heartbeat 只 `sampleForwarded`，不经 `onUpstreamFrame`→accumulator）。

---

## Phase 0 — 前置实测 + web_search 探索（GO/NO-GO，定覆盖矩阵）

扩展 `exp/cc-idle-280s/` harness（复用 `mock.ts` 的 `idle:TYPE:N:M` + `run-arm.sh`），补齐 oracle 缺口。**这是实现前的硬闸**——结果决定后续覆盖设计，任一臂反常须停下重新设计。

1. **空 text_delta 臂**（修正现有「谎言」臂）：`mock.ts` 加真正的 text block 场景（content_block_start type=text → 每 20s 空 `text_delta{text:""}` → tail），跑真实 CC 2.1.201。裁决：CC 是否认空 text_delta 为 chunk（存活 vs 300s 断）。**text 是最常见响应场景，这是关键闸。**
2. **空 input_json_delta 臂**（tool_use 覆盖前提）：content_block_start type=tool_use → 每 20s 空 `input_json_delta{partial_json:""}` → tail。裁决：CC 是否认它为 chunk 且不破坏 tool_use JSON 累积。
3. **prod-faithful 300s 复测**：`run-arm.sh` 加 `CC_FIRST_PARTY=0` 变体（custom URL + token，用户真实接线），跑 ping 臂确认 300s 上限在代理路径下一致（不能从 60s 层跨层外推）。
4. **web_search 专门方案探索**（读码 + 实测）：读 `web-search-handler.ts` / `web-search-direct.ts` / `completeWebSearch` 全貌，评估阻塞静默期保活方案——候选：(a) `completeWebSearch` 前提前 flush 一个占位 thinking block（content_block_start + 空 thinking_delta keepalive，完成后 stop）；(b) 二次生成改流式 forward。用 harness 验证候选 (a) 的占位 block 对 CC 无害（不显示假思考/不破坏最终消息）。

**Phase 0 产出**：确定的**覆盖矩阵**（block type → keepalive delta 类型 / fallback）+ web_search 方案选定 + prod-faithful 确认。写入 `exp/cc-idle-280s/REPORT.md` 追加节。

## Phase 1 — sink block-状态机 + 帧 provider（`src/lib/pipeline/client-sink.ts`）

保持 sink format-agnostic：状态机读通用 JSON 字段、Anthropic 帧构造由注入 provider 负责。

- `SseSinkHeartbeat.pingFrame`: `ClientFrame` → `ClientFrame | ((openBlock?: {index:number;type:string}) => ClientFrame)`。
- 仅当 `pingFrame` 是函数时启用 openBlock 跟踪（ping 模式零开销、字节不变）：`write(frame)` 复用现有 `JSON.parse`（`frameType` 已解析）多读 `index`/`content_block.type`——`content_block_start`→记，`content_block_stop`(匹配 index)→清。注释标明通用 content-block 状态机、不 import Anthropic。
- `tick()`: `typeof pingFrame === "function" ? pingFrame(openBlock) : pingFrame`。由 `write` 驱动（非 writeSynthetic/tick），只反映真实转发帧。
- **[审查 S5 时序缺口]** 加测试覆盖：decode/recover/tool-input-repair 缓冲期，openBlock 与客户端实收的一致性（sink 观察的是 S5-rewrite 后帧，须验证缓冲不致 openBlock 错配）。

## Phase 2 — handler provider + config（`handler-v4.ts` + config 全链）

- `makeAnthropicKeepaliveFrame(openBlock, mode) => ClientFrame`（`ANTHROPIC_PING`:799 旁，导出为共享 helper 供 web_search 复用）：按 Phase 0 覆盖矩阵——thinking→空 thinking_delta；text→空 text_delta（若 Phase 0 GO）；tool_use→空 input_json_delta（若 Phase 0 GO）否则 fallback ping；无 block/redacted/未知→ANTHROPIC_PING。
- sink 构造点（handler-v4.ts:429/492）：`mode==="content_delta" ? (ob)=>makeAnthropicKeepaliveFrame(ob,mode) : ANTHROPIC_PING`。cold-start first ping(:506) 保持 ANTHROPIC_PING（commit 瞬间无 open block）。
- **config `anthropic.stream_keepalive_mode`**（`nullableEnum(["ping","content_delta"])`，默认 `content_delta`），按 `refusal_sse_rewrite` 全链模板（执行时按该键**重新定位**行号，勿写死）：`schema.ts`、`state.ts`（type + CONFIG_MANAGED_DEFAULTS + init + reset + `setAnthropicBehavior` Pick）、`config.ts` apply、`config.yaml`（keepalive 簇 + EN/ZH 注释）、`tests/config/config-hot-reload.it.test.ts` FIELDS 行（**完整性守卫 :904-910 强制**）。无需 compat。

## Phase 3 — web_search 专门方案（据 Phase 0 选定）

实现 Phase 0 选定的 web_search 保活方案（预期候选 a：`completeWebSearch` 前 flush 占位 thinking block + 空 thinking_delta keepalive）。文件：`web-search-handler.ts`（:161-205 heartbeat 段）、`web-search-direct.ts`（:393 构造）、`streaming-pump.ts`（`startForwardedSseHeartbeat` :360-419，加 forwarded-side openBlock 或占位 block 逻辑，复用 Phase 2 helper）。

## Phase 4 — G4 回归修复 + doc-sync

- **[G4]** keepalive forwarded 标签 ping→content_block_delta 的下游消费者：`ui/src/utils/block-diff.ts:196-207`（按 type 对齐）、`ui/src/components/.../SseEventsSection.vue`、**≥5 个测试断言 `type:"ping"`**。方案二选一（实现时定）：忠实记 content_block_delta + 更新 UI diff/测试识别合成 keepalive；或给 keepalive forwarded record 打合成标记让消费者跳过。前者更 richest-data-flow。
- **doc-sync**：`docs/DESIGN.md` 运行时选项表加 `streamKeepaliveMode` 行 + 「活的架构现状」表 sink heartbeat 行 + web_search bypass 行；`docs/spec/pre-response-abort-handling.md` keepalive 语义（ping vs content_delta、300s no-content 层）；memory 更新 `reference-claude-code-timeout-and-sse-error-oracle`（CC 2.1.201 新增 300s no-content 上限、ping/comment 不算 chunk、空 content_delta 算、exp/cc-idle-280s 实测）。

## 测试（TDD，本项目隔离约定）

- **unit**：sink openBlock 状态机（喂 start/delta/stop 序列断言选帧）+ `makeAnthropicKeepaliveFrame` 各分支 + S5 缓冲期一致性。
- **golden/http**（`tests/anthropic/*.http.test.ts`）：ping 模式逐字节同现状（回归锁）；content_delta 模式 keepalive 帧类型正确、只进 forwarded 轨。
- G4 消费者测试更新（UI diff + ≥5 处 ping 断言）。
- config：hot-reload 完整性守卫 + strict-parse 全绿。

## 验证（端到端）

1. `bun run typecheck` + `bun run test:backend` + `bun run test:ui`（改了 UI）。
2. **实测复现修复**：真实 CC 2.1.201 经**真实代理**发 >300s pre-content thinking 静默 opus 请求，`content_delta` 下存活（对照 `ping` 下 300s 断）。
3. `bun run lint`（eslint --fix）。

## 提交切分（fine-grained，每 commit 自洽）

0. Phase 0 实测扩展：`test(exp): cc keepalive text/input_json/prod-faithful arms + web_search probe`。
1. `feat: sink block-state machine + dynamic keepalive frame provider`（ping 模式行为不变）。
2. `feat: anthropic content-delta keepalive + stream_keepalive_mode config`（默认 content_delta）。
3. `feat: content-delta keepalive for web_search bypass`（Phase 3）。
4. `fix: update forwarded-track ping-label consumers (ui diff + tests)`（G4）。
5. `docs: keepalive mode + CC 300s no-content idle`。

---
> 审查发现全文见本文件下方历史节（已亲自核对 file:line）；Phase 0 前置闸即为吸收 oracle 缺口的机制。