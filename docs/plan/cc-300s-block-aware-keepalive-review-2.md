# 对抗性审查：CC 300s keepalive 修复 plan 的证据充分性

审查对象 plan：`/home/xp/.claude/plans/sorted-waddling-thimble.md`
实测报告：`exp/cc-idle-280s/REPORT.md` + `mock.ts` + `run-arm.sh` + `*.mock.log`/`*.cli.log`

## 裁决摘要

核心实测**属实且稳固**：三臂对照的数字全部核对无误，300s no-content 上限是真实的、复现了用户文案。plan 的核心决策（keepalive 改 content_delta、block-状态感知）方向正确、不被推翻。

但存在**若干被 plan 低估的缺口**，其中 1 个足以**削弱**（非推翻）核心决策的证据稳固性，2 个是 plan 未标注的实现复杂度/回归风险。逐条如下。

---

## G1 [核心决策不受影响] 实测数字复核：属实

直接读 CLI 日志（不信 REPORT 摘要）：

| 臂 | cli.log 实测 | REPORT 声称 | 一致 |
|---|---|---|---|
| armA-ping | `duration_ms:300169, is_error:true, result:"API Error: Stream idle timeout - no chunks received"` | 300169 ❌ | ✅ |
| armB-thinkdelta | `duration_ms:340389, is_error:false, result:"ok", stop_reason:"end_turn"` | 340389 ✅ | ✅ |
| armC-comment | `duration_ms:300187, is_error:true, result:"...no chunks received"` | 300187 ❌ | ✅ |

mock.log 交叉验证：armA/armC 在第 14 帧（+282s）后 client 于 +302/303s abort（300s 上限 + 建连余量）；armB 同样在第 14 帧（+283s）后**继续存活**到第 17 帧（+343s）并收 tail。**关键对照成立**：A/C/B 唯一变量是 keepalive 帧类型，B 在 A/C 断连的同一时点后继续存活 → 帧类型是断连的决定因素，非其他变量。**这一层证据充分，无缺口。**

---

## G2 [削弱核心决策稳固性 — 严重度 MEDIUM] prod-faithful 路径下 300s 上限未复测

**审查任务第 1 点。** harness 用 `_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL=1`（run-arm.sh:35），走 CC 的 **first-party watchdog** 路径；用户真实接线经代理是 **custom base URL + auth token**（`src/setup-claude-code.ts:69` `ANTHROPIC_BASE_URL: serverUrl`），**不设** first-party flag。

REPORT §5 已诚实标注此缺口（"300s 上限的 prod-faithful 复测未做（预期一致）"）——这是**已知局限的诚实标注**，不是隐瞒。但"预期一致"的依据需要审视：

- **支持"一致"的证据**：memory `reference-claude-code-timeout-and-sse-error-oracle` 明确记录 **60s byte-idle 层**在 first-party 与 prod-faithful 两路径**实证一致**（8 样本）。这是**独立于本次实测的既有旁证**。
- **但缺口真实**：60s byte-idle 一致 **不能自动推出** 300s no-content 层也一致。这是**两层不同的 watchdog**（REPORT §1 自己强调"两层，缺一不可"）。CC 完全可能对 first-party 应用更严的 no-content 上限、对第三方代理应用不同值（甚至不应用）。这是 **self-consistent 推断跨层外推**，不是独立证据。

**影响**：若 prod-faithful 路径下 300s 上限不存在或值不同，plan 的整个动机可能偏移。但 plan 的 §「验证」第 2 步**已包含 prod-faithful 端到端实测**（打真实代理而非 mock，对照 ping vs content_delta）——即 plan 把这个缺口的关闭放进了执行期验证。**结论**：这是**已被 plan 验证步骤覆盖的已知缺口**，不推翻决策，但**执行期那步实测是 GO/NO-GO 闸，不是走过场**——若 prod-faithful 下 ping 也能存活 >300s，则整个默认改动的前提消失。审查建议：把 plan §验证第 2 步升格为**决策确认闸**，明确"若 prod-faithful ping 存活 >300s 则回退 default=ping"。

---

## G3 [削弱 text 分支证据 — 严重度 MEDIUM] 空 text_delta 从未实测，且 mock 的 textdelta 臂是"谎言"

**审查任务第 2 点。** plan Part 2 依赖「text block → 空 `text_delta` 有效」的推断，但：

1. **只测了空 thinking_delta（armB），从未测空 text_delta。** REPORT §5 标注了。
2. **更严重**：mock.ts 的 `textdelta` 臂（:57-60）**根本不是 text_delta**——它发的是 `thinking_delta` with `thinking:" "`，注释自己承认 "switch is a bit of a lie for a thinking block"。所以：
   - REPORT §5 说"mock.ts 已有 `textdelta` 类型，扩展成 text block"——**这个"已有"是误导**。现有 `textdelta` 臂只是"非空 thinking_delta"，对 text block 场景零覆盖。要测空 text_delta 必须**新写** message shape（text content_block_start + 空 text_delta），不是"扩展"。
3. **是否 self-consistent 推断**：plan 假设"同为 `content_block_delta` → CC 反应相同"。这是**结构推断**，非独立证据。CC 的 watchdog 是否只看外层 `content_block_delta` type、还是 peek 内层 delta.type（thinking_delta vs text_delta）区分——**没有实测裁决**。armB 证明的是"空 thinking_delta 算 content chunk"，**不能自动外推**"空 text_delta 也算"。

**独立证据存在吗**：无。这是纯 self-consistent 推断（违 empirical-verification 的"自洽需独立 oracle"）。

**影响**：若 CC 对空 text_delta 反应不同（例如把零长度 text_delta 当无内容不重置 watchdog），则 text block 场景下修复**失效**——而 text block 是**最常见**的响应场景（大多数回答是 text 而非纯 thinking）。这比 thinking 场景影响面更大。

**是否推翻决策**：不推翻（thinking 场景已验证，且 plan §测试第 4 点已列"补测空 text_delta"）。但 **plan 低估了这个缺口的分量**——它被降级为一个测试 TODO，实际应是**执行期必须实测裁决的 open question**（且 plan 说"http 测试断言 CC-兼容"——但 http 测试用的是代理自己的 SSE 解析/或 mock，**不是真 CC oracle**；要真裁决必须像 armB 一样用真 `claude` CLI 跑一臂空 text_delta）。审查建议：把"空 text_delta 真 CC 实测"从测试 TODO 升为 blocking open question。

---

## G4 [回归风险被 plan 完全遗漏 — 严重度 MEDIUM-HIGH] forwarded 轨 ping→content_block_delta 有下游消费者

**审查任务第 4 点（history 下游消费者）。** plan §根因约束第 3 条把标签变更轻描淡写为"预期，忠实记录客户端实收"——**但 plan 未核实是否有消费者依赖 `type:"ping"` 标签**。subagent 独立复核（读 ui/ + tests/）发现**确实有**：

- **UI SSE-frame diff 按 `type` 对齐**：`ui/src/utils/block-diff.ts:196-198,205-211` 用 `f.type` 作对齐 key。forwarded ping 现标 `"ping"`（无上游对应 → 显示为 `added` 合成帧）；改成 `content_block_delta` 后 aligner 会试图把它和真上游 `content_block_delta` 配对 → 产生**虚假 modified/rewritten diff 行**（`SseFrameDiff.vue`）。非崩溃，但诊断保真度回归。
- **UI 事件展示**：`SseEventsSection.vue:20-114` 的 `eventSummary`/`eventColor` switch on `type`。`"ping"` 现走 default；改标后 ping 被路由进 `content_block_delta` 分支，试图读 `{type:"ping"}` 上不存在的 `d.delta` → `index=undefined` 噪声（非崩溃）。
- **≥5 个测试文件断言 `type:"ping"`**：`tests/pipeline/client-sink.unit.test.ts:131,142,202`、`owns-sink-two-racer.unit.test.ts:106,115`、`tests/anthropic/fake-sse-heartbeat.unit.test.ts:84,85,111,177`、`streaming-l2-buffered.http.test.ts:408`、`tests/streaming/stream-shutdown-race.it.test.ts:382`。改标签会**红一批测试**。

**影响**：plan 的"标签变更无害"假设**不成立**。这不推翻决策（都非硬崩溃、都可修），但 plan **完全没提**要改 UI diff keying + 更新这批测试断言。执行时会撞一堆红测试 + UI 诊断退化，属**被低估的范围**。审查建议：plan §测试/§Part 应显式加"更新 ping-label 断言 + 修 UI type-keyed diff/summary 对 content_block_delta-shaped ping 的处理"。

**注**：subagent 确认 **history sink / observability / SQLite 无 ping 特判**（`streaming-pump.ts:133-141` verbatim 记录，无 filter）——所以**后端持久化侧安全**，风险纯在 **UI 展示 + 测试断言**两处。

---

## G5 [非-CC Anthropic 客户端未测 — 严重度 MEDIUM] 默认改动波及所有 Anthropic 流

**审查任务第 4 点（非 Claude-Code 客户端）。** plan 默认 `content_delta` 改的是**所有 Anthropic 流的 keepalive**，不止 CC。但实测 oracle **只有 CC 2.1.201**。空 delta 对其他 Anthropic 消费者（`@anthropic-ai/sdk` 直连、其他 Agent SDK、自研客户端）**零实测**。

风险面：
- 空 `thinking_delta`/`text_delta`（零长度内容）是**合法 Anthropic 协议帧**（armB 证明 CC 接受且不破坏 block 完整性）。标准 SDK **理应**忽略零长度 delta。**但这仍是推断**（无独立 oracle）。
- 更微妙：某些客户端可能对 delta **计数/累加**（如统计 delta 帧数、或把空 delta 当"流已开始产出内容"的信号触发 UI 状态迁移）。ping 是带外信号、空 delta 是带内信号——语义不同。
- plan §根因约束第 1 条已正确要求 index+type 匹配 open block（避免协议违规），这**降低**了破坏标准 SDK block 状态机的风险，但不消除计数/信号类副作用。

**影响**：不推翻（默认改动是用户已确认的决策 + 协议合法），但**权衡未充分呈现给用户**。plan 说"决策（已与用户确认）① 默认 content_delta"——用户选了，但 plan **没把"ping vs content_delta 对非 CC 客户端的未测风险"明确摆给用户**。按项目 give-user-decision-data 原则，默认改全局行为应标注："此改动影响所有 Anthropic 客户端，仅 CC 2.1.201 实测，其他客户端为协议合法性推断"。审查建议：文档/plan 诚实标注该权衡；考虑是否 default 保守为 ping、CC 场景 opt-in content_delta（但这与用户已确认决策冲突，仅作为风险提示，不擅自改）。

---

## G6 [已诚实标注的已知局限 — 严重度 LOW] 300s 是 CC 版本特定值

**审查任务第 3 点。** 300s 是 2.1.201 特定值，REPORT §5 已标注"可能随版本变动，cadence 应保守（≤200s）"。plan cadence 默认 20s（继承 `stream_keepalive_ping_sec` 默认，subagent 确认 state.ts:1108=20 + `clampKeepaliveCadence` ≤~40s 上限）。

**评估**：20s cadence 对 300s 上限有 **15× 余量**，即使 CC 未来把上限砍到 60s 仍安全（20s < 60s）。**这个缺口余量充足、且已标注**——LOW，不影响决策。唯一提示：`clampKeepaliveCadence` 的 ~40s 上限（config.ts:149，subagent 证实 plan 未提及此 clamp）意味着即使用户配大 cadence 也被钳到 40s，天然保守，反而是保护。

---

## 附：plan file:line 锚点复核（subagent 独立核）

plan 声称"Explore C 已核 file:line"，独立复核结果：**Part 2/3 锚点全部精确**（`ANTHROPIC_PING:799`、sink `:429/:492`、first ping `:506`、config 簇 `:394/:241/:903/:1108/:1200/:1319/:501` 全中）。**未标注的实现复杂度**：
- Part 1：`write()` 本身不 parse（parse 在 `frameType`/`sampleForwarded` 里且结果被丢弃），openBlock+index 是**全新状态**；`makeWsSink` 无独立 write 路径（WS 场景状态机不适用，需确认 WS keepalive 是否也要改）。
- Part 4：web_search 的 `startForwardedSseHeartbeat` 与 v4 driver 的 `makeSseSink` 是**两套完全独立实现**，各有独立 ping literal 和 block-state 模型；`currentBlockType` 是**上游侧、type-only 无 index、纯诊断用**——不能直接驱动 forwarded 侧"客户端哪个 block 开着"，需新增 forwarded-side 跟踪（plan :58 已标"实现时定夺"，但**低估了它需要全新状态而非复用**）。

---

## 总裁决

| 缺口 | 严重度 | 是否推翻/削弱核心决策 | 性质 |
|---|---|---|---|
| G1 实测数字 | — | 证据充分 | 已核实属实 |
| G2 prod-faithful 300s 未复测 | MEDIUM | 削弱（已被 plan 验证步骤覆盖，但那步是真 GO/NO-GO 闸） | 已诚实标注 + plan 有验证计划 |
| G3 空 text_delta 未测 + mock textdelta 是谎言 | MEDIUM | 削弱 text 分支（最常见场景）；纯 self-consistent 推断无 oracle | plan 低估为测试 TODO，应升为 blocking 实测 |
| G4 forwarded ping→delta 有 UI/测试消费者 | MEDIUM-HIGH | 不推翻但被 plan 完全遗漏 | 真回归风险（UI diff/summary + ≥5 测试） |
| G5 非-CC Anthropic 客户端未测 | MEDIUM | 不推翻（合法协议+已确认决策）但权衡未呈现 | 全局默认改动的未测面 |
| G6 300s 版本特定 | LOW | 不影响（20s cadence 15× 余量 + clamp 保护） | 已诚实标注 |

**核心决策稳固**（keepalive 改 content_delta 方向由 armB 硬实测支撑，不被推翻）。**两个实证缺口需在执行期用真 CC oracle 关闭**（G2 prod-faithful 路径 + G3 空 text_delta），plan 都提了但**分量低估**——应从"测试 TODO/预期一致"升为 blocking open question。**一个真回归风险被完全遗漏**（G4 UI/测试的 ping-label 消费者）。**一个权衡未诚实呈现**（G5 非-CC 客户端）。

无一为"为挑刺而挑刺"：G2/G3 是 empirical-verification 的"自洽需独立 oracle / 跨层外推非证据"直接命中，G4 是 subagent 读代码实证的下游耦合，均有 file:line 支撑。
