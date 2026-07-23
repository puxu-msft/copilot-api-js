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
