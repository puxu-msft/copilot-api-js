# continuation-shape 门簇结果（G3/G4/G5）

归属：`docs/plan/2026-07-22-continuation-retry-sequential-anchor/plan-G-gates.md`。真实 GHC 计费探针（cheap 模型 + 小 max_tokens），4141 代理 → GHC。裁决 = 实测（skill `empirical-verification`）。日期 2026-07-22。

## 结果汇总（全 PASS——高度利好，多个 spec fallback 分支被证伪为不需要）

| 门 | 请求形状 | 结果 | 影响 |
|---|---|---|---|
| **G3** Anthropic 完整 tool_use 块作 assistant 前缀 + user 续写轮 | `/v1/messages` haiku：assistant=[text, tool_use{完整}] + user "network issue..." | ✅ **PASS** | GHC 接受、返回正常 text+tool_use、无 400。续写覆盖 tool_use 前缀场景（不限 incident 的 text-only）。spec §4.3 Anthropic 行「已 commit 完整 tool_use 块作前缀未验证」→ **已验证接受** |
| **G4** CC 并行 tool_call 流式 index 到达序列 | `/v1/chat/completions` gpt-5.4-mini stream，tool_choice required，2 工具 | ✅ **PASS（严格串行）** | index 到达 = `0:name,0:arg → 1:name,1:arg`，单调不回跳。CC 块级「更高 index 出现=前块完成」边界判据成立。`stream-accumulator.ts` 的 Map-based 乱序容忍是防御，实测串行 |
| **G5a** CC assistant{tool_calls} 直接接 user（无 tool role） | `/v1/chat/completions` gpt-5.4-mini：assistant{tool_calls} + user | ✅ **PASS（GHC 不约束）** | 返回正常 completion 非 400。**OpenAI 标准的 tool_calls 尾随约束在 GHC 上不成立** → CC 续写不撞该 hazard，spec §4.3 CC 行的窄场景 partial-degrade fallback **不需要** |
| **G5b** Responses input 含 prior assistant output + user 续写轮 | `/v1/responses` gpt-5.4-mini：input=[user, assistant{output_text}, user] | ✅ **PASS** | 返回正常响应 output 126 tok 无 400。Responses（HTTP + WS 共用）续写形状可行 |

## 对计划的回填

- **spec §4.3 hazard 表大幅简化**：G3/G5a/G5b 三处「FAIL → partial-degrade」分支全部证伪为**上游接受**，无需 fallback。CC 续写（P5）、Responses 续写（P4/P6）、Anthropic tool_use 前缀（P3）均全覆盖。
- **G4 串行确认**：P5 CC 块边界重建用 index-跳变判据（plan-4-7 Task 5.1 的 G4-PASS 分支）。
- **剩余门**：G2（300s 死线重置，长跑真 CLI + mock 上游不计费）、G1（代理产出 oracle，离线，P1 红基线）。

## 复现

```bash
# 探针 JSON 在 /tmp/g{3,4,5a,5b}.json；重跑：
curl -s -XPOST http://127.0.0.1:4141/v1/messages -H 'content-type: application/json' -d @/tmp/g3.json   # G3
curl -s -N -XPOST http://127.0.0.1:4141/v1/chat/completions -d @/tmp/g4.json                             # G4 (stream)
curl -s -XPOST http://127.0.0.1:4141/v1/chat/completions -d @/tmp/g5a.json                               # G5a
curl -s -XPOST http://127.0.0.1:4141/v1/responses -d @/tmp/g5b.json                                      # G5b
```
（探针命中用户 4141 服务器 → 真 GHC；只读 POST，不 spawn、不 kill 4141。）

---

# `max_tokens` 续传门 A / D 结果

归属：`docs/plan/2026-07-22-max-tokens-continuation/plan-G-gates.md`。日期 2026-07-27。本轮只执行门 A 与门 D，未执行门 B/C/E。

## 结论汇总

| 门 | 结果 | 关键证据 | 对实现范围的影响 |
|---|---|---|---|
| **门 D** transparent / marker 客户端接受性 | **PASS** | 真 `@anthropic-ai/sdk@0.106.0` 接受单 `message_start`、连续 index、单 `message_stop` 的两种缝合 wire；请求 `max_tokens=64` 时最终 `output_tokens=88/89` 且 `stop_reason=end_turn`，不 throw。真 `claude` CLI 2.1.220 `num_turns=1`、不 stall | P1 的 transparent 默认与 marker 备选无需因客户端协议兼容性缩范围 |
| **门 A** max_tokens text-only 前缀续写 | **PASS** | 真 GHC `claude-haiku-4.5`：首轮 `max_tokens=64` 干净结束，`stop_reason=max_tokens`、`output_tokens=64`、整数 1～32；续写轮从 33 连续到 64，无重复、无跳号 | P1 的 A 类 text 续写主目标可继续实施，无需回退为 passthrough-only |

## 门 D：transparent / marker 缝合流被真实客户端接受

### 方法与判据

实验代码：`max-tokens-transparent-stitch.ts`。离线 mock 上游，不消耗 GHC 额度；本地 `Bun.serve({port:0})` 只向真实客户端提供最终 producer wire，不接触 4141。

producer 以两轮上游语义构造客户端可见流：首轮已有 text 块，但其 `message_delta{stop_reason:max_tokens}` 与 `message_stop` 被抑制；续写块从下一 index 开始；只保留续写轮真实 `message_delta{stop_reason:end_turn}` 与 `message_stop`。marker 变体在独立合法 text 块中插入 `[continued after max_tokens] `。

PASS 必须同时满足：

1. producer oracle 看到恰好一个 `message_start`、一个 `message_stop`、连续 block index、唯一 `end_turn`，且无客户端可见 `max_tokens`。
2. usage 序列单调，最终 `output_tokens > 请求 max_tokens`。
3. `@anthropic-ai/sdk` `.finalMessage()` 不抛错，内容无重复，最终 `stop_reason=end_turn`。
4. marker 变体的最终内容含 marker。
5. 可行时真 `claude` CLI 不 stall，即 `num_turns=1`、`is_error=false`。

### 实测输出

运行：

```bash
bun run exp/continuation-shape/max-tokens-transparent-stitch.ts
```

输出要点：

```text
{"positiveControls":[{"variant":"bad-colliding-index","verdict":"EXPECTED_FAIL","reason":"expected contiguous block indices [0,1], got [0,0]"},{"variant":"bad-leaked-terminal","verdict":"EXPECTED_FAIL","reason":"expected one message_stop, got 2"}]}
{"variant":"transparent","verdict":"PASS","text":"Alpha beta gamma delta.","blocks":2,"stopReason":"end_turn","requestedMaxTokens":64,"finalOutputTokens":88,"wire":{"messageStarts":1,"messageStops":1,"blockStartIndices":[0,1],"stopReasons":["end_turn"],"outputTokens":[88]}}
{"variant":"marker","verdict":"PASS","text":"Alpha beta [continued after max_tokens] gamma delta.","blocks":3,"stopReason":"end_turn","requestedMaxTokens":64,"finalOutputTokens":89,"wire":{"messageStarts":1,"messageStops":1,"blockStartIndices":[0,1,2],"stopReasons":["end_turn"],"outputTokens":[89]}}
{"variant":"transparent-claude-cli","label":"stitched","verdict":"PASS","result":"gamma delta.","numTurns":1,"stopReason":"end_turn","exitCode":0}
{"variant":"single-block-claude-cli-control","label":"single-block-control","verdict":"PASS","result":"gamma delta.","numTurns":1,"stopReason":"end_turn","exitCode":0}
```

### 正样本对照

正样本对照确实咬住目标机制：

- 把续写块故意重开为 index 0，oracle 以 `[0,0] != [0,1]` 失败。
- 故意泄漏首轮 `message_stop` 后再发最终终止符，oracle 以 `messageStops=2` 失败。

这两例排除了“SDK 宽容导致错误 wire 也绿”的假绿。SDK 对 index 冲突可能静默合并块，故门 D 的结论依赖独立 producer oracle 与真实 SDK 两条腿，而非只看 `.finalMessage()` 不 throw。

### Claude CLI 边界

CLI 对缝合流与单块对照流都只把最后一个 text block 渲染为 `result:"gamma delta."`；两者均 `num_turns=1`、`stop_reason=end_turn`。因此本门可确认“不 stall、不进入继续循环、协议被接受”，但不能声称 CLI 的 `result` 会连接多个 text block。SDK `.finalMessage()` 才是完整多块累积内容的 oracle。

## 门 A：真实 max_tokens text-only 前缀续写

### 方法与判据

实验代码：`max-tokens-text-prefix.ts`。经用户现有 4141 代理向真实 GHC 发两次靶向小额请求，不启动、停止或重启 4141，不清理 History。模型先从 `/v1/models` 实测确认可用，再选择便宜档 `claude-haiku-4.5`；两轮均 `max_tokens=64`。

首轮 prompt 要求只输出整数 1～500。续写请求形状为 `[原始 user] + [assistant=首轮已提交 text] + [user=从下一整数继续且不要重复]`。PASS 判据不放宽：

1. 首轮必须 `stop_reason=max_tokens` 且 `output_tokens=64`。
2. 首轮必须同时收到 `message_delta` 与 `message_stop`，证明是干净预算终止而非 RST/EOF。
3. 首轮整数严格逐一递增。
4. 续写首项必须恰为首轮末项加一，续写内部亦严格逐一递增。

### 实测输出

运行：

```bash
COPILOT_API_BASE_URL=http://127.0.0.1:4141 MODEL=claude-haiku-4.5 bun run exp/continuation-shape/max-tokens-text-prefix.ts
```

输出：

```text
{"verdict":"PASS","model":"claude-haiku-4.5","first":{"maxTokens":64,"stopReason":"max_tokens","outputTokens":64,"sawMessageDelta":true,"sawMessageStop":true,"firstInteger":1,"lastInteger":32,"sample":"1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32"},"continuation":{"maxTokens":64,"stopReason":"max_tokens","outputTokens":64,"firstInteger":33,"lastInteger":64,"sample":",33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51,52,53,54,55,56,57,58,59,60,61,62,63,64"}}
```

首轮从 1 连续到 32；续写从 33 连续到 64。续写开头带格式性的逗号，但没有重复、跳号或语义发散。第二轮也再次撞 `max_tokens`，不影响本门要验证的“上游接受 max_tokens text-only 前缀并从准确边界续写”；多轮预算耗尽后的最终 transparent fallback 属实现阶段 `max_rounds` 语义，不属于本门。

## 未验证范围

- 门 B/C/E 未执行，也未据门 A/D 外推。
- 门 D 没有验证尚未实现的 P1 生产 driver 接线或 History 忠实记录；本门只验证目标 producer wire 的真实客户端接受性。正式实现仍须用 production-path e2e 与后端独立 oracle 锁接线。
- 门 A 为 `claude-haiku-4.5` 单次确定性样本；它足以回答“该真实 max_tokens 请求形状是否被上游接受并能干净续写”，不代表所有模型在开放式自然语言续写上的逐字保真率。
