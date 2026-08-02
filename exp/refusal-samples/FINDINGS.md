# Refusal 历史样本取证

## ① 结论速览

- **Q1：已确认存在不带非空 `category` 的 refusal。** `req_1782214935133_68` 的原始模型响应 `stop_details` 为 `{"category":null,"explanation":"API integrators: you can reduce refusals for your users by configuring a fallback model — see https://platform.claude.com/docs/en/build-with-claude/refusals-and-fallback","type":"refusal"}`。严格说字段存在但值是 `null`；本次没有找到“字段本身缺失”的实测历史样本。当前可一手恢复的上游 refusal 共 3 个：该样本的 category 为 `null`，`req_1783947618475_731` 为 `"bio"`，`req_1785187727725_842` 为 `"cyber"`。因此已观测 category 取值为 `null`、`"bio"`、`"cyber"`。
- **Q2：两类上下文都出现过。** `req_1782214935133_68` 是主编码轮，历史终态按当时行为为 completed；`req_1783947618475_731` 是对抗审查 subagent 辅助请求，state=failed；`req_1785187727725_842` 是标题生成辅助请求，state=failed。未找到 refusal 形式的摘要或 quota 探测请求。
- **Q3：`req_1782214935133_68` 已不在当前 History REST、V3、V2 或冷归档中，但仍可从 Claude Code 原始客户端 transcript 找到完整最终模型消息。** 它的 `stop_details` category 是显式 `null`，不是 `"cyber"`，且 explanation 存在。

## ② 证据表

| id | 时间 | model | `stop_details` 原文 | content block 形态 | usage | state | 请求性质 |
|---|---|---|---|---|---|---|---|
| `req_1782214935133_68` | `2026-06-23T11:42:15.133Z` 请求；客户端最终消息 `2026-06-23T11:42:37.161Z` | `claude-opus-4-8` | `{"category":null,"explanation":"API integrators: you can reduce refusals for your users by configuring a fallback model — see https://platform.claude.com/docs/en/build-with-claude/refusals-and-fallback","type":"refusal"}` | 恰好 1 个 `thinking`；`thinking:""`，有效非空 signature（客户端 transcript 中 3112 个字符）；无 `text`、无 `tool_use` | 原始最终消息：`{"input_tokens":431840,"cache_creation_input_tokens":0,"cache_read_input_tokens":23850,"output_tokens":1097,"server_tool_use":{"web_search_requests":0,"web_fetch_requests":0},"service_tier":"standard","cache_creation":{"ephemeral_1h_input_tokens":0,"ephemeral_5m_input_tokens":0},"inference_geo":"global","iterations":[],"speed":"standard"}`。该时代响应没有 `output_tokens_details` 字段，故其原文状态为字段缺失。 | completed（历史文档明确记录当时代理逐字节透传并打 `[OK]`；原 History 行已退役删除，无法再用 REST 读取 state 字段） | 主编码轮。拒绝前同一客户端 session 正在读文件并继续修改；前一文本为 `cat -A 让中文不可读，但表格结构已清楚。用 Read 精确取这几行原文（确保 Edit 匹配），然后修。`，随后调用 `Read`。不是标题、摘要或 quota 探测。 |
| `req_1783947618475_731` | `2026-07-13T13:00:18.475Z` | `claude-opus-4-8` | `{"category":"bio","explanation":"API integrators: you can reduce refusals for your users by configuring a fallback model — see https://platform.claude.com/docs/en/build-with-claude/refusals-and-fallback","type":"refusal"}` | 恰好 1 个 `thinking`；start 为 `thinking:"", signature:""`，随后 1 个非空 `signature_delta`；无 `text`、无 `tool_use` | `{"cache_creation_input_tokens":4153,"cache_read_input_tokens":70116,"input_tokens":1,"output_tokens":25848,"output_tokens_details":{"thinking_tokens":25636}}` | failed | 辅助 subagent 请求：主会话收到的 task notification 原文为 `Agent "Adversarial review of retirement ADR/RFC" failed`；即对 ADR/RFC 的对抗审查，不是主编码轮、标题、摘要或 quota 探测。 |
| `req_1785187727725_842` | `2026-07-27T21:28:47.725Z` | `claude-opus-5` | `{"category":"cyber","explanation":"This request triggered restrictions on violative cyber content and was blocked under Anthropic's Usage Policy. To learn more, see https://platform.claude.com/docs/en/build-with-claude/refusals-and-fallback. API integrators: you can reduce refusals for your users by configuring a fallback model — see https://platform.claude.com/docs/en/build-with-claude/refusals-and-fallback","type":"refusal"}` | 上游 `message_start.content:[]`，随后直接 `message_delta`；无 `content_block_start`，所以无 thinking、无 text、无 tool_use | `{"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"input_tokens":2167,"output_tokens":1,"output_tokens_details":{"thinking_tokens":0}}` | failed | 标题生成辅助请求。client request system 明文要求 `Generate a concise, sentence-case title (3-7 words)`，user 内容是 `<session>…</session>`。不是主编码轮、摘要或 quota 探测。 |

### 三个样本的原始承重字节

`req_1783947618475_731` 的上游原始 `message_delta.raw`：

```json
{"context_management":{"applied_edits":[]},"copilot_usage":{"token_details":[{"batch_size":1000000,"cost_per_batch":500000000000,"token_count":1,"token_type":"input"},{"batch_size":1000000,"cost_per_batch":50000000000,"token_count":70116,"token_type":"cache_read"},{"batch_size":1000000,"cost_per_batch":625000000000,"token_count":4153,"token_type":"cache_write"},{"batch_size":1000000,"cost_per_batch":2500000000000,"token_count":25848,"token_type":"output"}],"total_nano_aiu":70721925000},"delta":{"stop_details":{"category":"bio","explanation":"API integrators: you can reduce refusals for your users by configuring a fallback model — see https://platform.claude.com/docs/en/build-with-claude/refusals-and-fallback","type":"refusal"},"stop_reason":"refusal","stop_sequence":null},"type":"message_delta","usage":{"cache_creation_input_tokens":4153,"cache_read_input_tokens":70116,"input_tokens":1,"output_tokens":25848,"output_tokens_details":{"thinking_tokens":25636}}}
```

`req_1785187727725_842` 的上游原始 `message_delta.raw`：

```json
{"context_management":{"applied_edits":[]},"copilot_usage":{"token_details":[{"batch_size":1000000,"cost_per_batch":500000000000,"token_count":2167,"token_type":"input"},{"batch_size":1000000,"cost_per_batch":50000000000,"token_count":0,"token_type":"cache_read"},{"batch_size":1000000,"cost_per_batch":625000000000,"token_count":0,"token_type":"cache_write"},{"batch_size":1000000,"cost_per_batch":2500000000000,"token_count":1,"token_type":"output"}],"total_nano_aiu":1086000000},"delta":{"stop_details":{"category":"cyber","explanation":"This request triggered restrictions on violative cyber content and was blocked under Anthropic's Usage Policy. To learn more, see https://platform.claude.com/docs/en/build-with-claude/refusals-and-fallback. API integrators: you can reduce refusals for your users by configuring a fallback model — see https://platform.claude.com/docs/en/build-with-claude/refusals-and-fallback","type":"refusal"},"stop_reason":"refusal","stop_sequence":null},"type":"message_delta","usage":{"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"input_tokens":2167,"output_tokens":1,"output_tokens_details":{"thinking_tokens":0}}}
```

`req_1782214935133_68` 的客户端 transcript 保存的是 SDK 累积后的原始最终模型消息，而不是逐帧 SSE。除 signature 太长而在表中只记长度外，承重字段原文如下：

```json
{"content":[{"thinking":"","type":"thinking","signature":"<3112 个字符的非空原值，仍逐字保存在 transcript>"}],"id":"msg_016TUcaKiZeDUHTDMMQRhpTz","model":"claude-opus-4-8","role":"assistant","stop_details":{"category":null,"explanation":"API integrators: you can reduce refusals for your users by configuring a fallback model — see https://platform.claude.com/docs/en/build-with-claude/refusals-and-fallback","type":"refusal"},"stop_reason":"refusal","stop_sequence":null,"type":"message","usage":{"input_tokens":431840,"cache_creation_input_tokens":0,"cache_read_input_tokens":23850,"output_tokens":1097,"server_tool_use":{"web_search_requests":0,"web_fetch_requests":0},"service_tier":"standard","cache_creation":{"ephemeral_1h_input_tokens":0,"ephemeral_5m_input_tokens":0},"inference_geo":"global","iterations":[],"speed":"standard"}}
```

注意：文档此前写“1058 token”，但原始客户端最终消息一手数据是 `output_tokens:1097`。本报告采用 1097；1058 只能视为旧文档中的过时或不同口径数字。

## ③ 检索方法与正样本对照记录

### A．当前 V3：全量解析所有压缩 frame，而非只查摘要

只读库：`file:/home/xp/.local/share/copilot-api/history-v3.db?mode=ro`。库中本次扫描时有约 3.28 万 operations、约 563 万个去重 frame 对象。

先对 `v3_objects(kind='frame')` 的 `canonical_gz` 做 zstd 解压，解析外层 canonical frame；若 `outer.data` 是字符串，再 JSON 解析内层原始 SSE payload，匹配：

```text
parsedData.delta.stop_reason === "refusal"
|| parsedData.stop_reason === "refusal"
|| parsedData.message.stop_reason === "refusal"
```

结果：全量扫描命中 2 个 frame hash，二者是同一原始 `message_delta` 在不同轨上的 canonical 变体；继续解压扫描全部 `v3_operations.manifest_gz`，两者都只映射到 `req_1785187727725_842`。这构成正样本对照：检索式确实命中了用户指定的已知正样本，且取回了 category=`cyber` 的原始字节。因此在**当前 V3 覆盖的时间窗**内，可以下结论：只有这一个 refusal operation，没有无 category 的另一个 V3 refusal。

辅助交叉验证：

```sql
SELECT operation_id, created_at, summary_json
FROM v3_operations
WHERE json_extract(summary_json,'$.responseError')='upstream thinking-only refusal'
   OR json_extract(summary_json,'$.stopReason')='refusal';
```

仅命中 `req_1785187727725_842`。History REST `GET /history/api/entries?limit=10000` 同样只返回该 refusal summary；`GET /history/api/entries/req_1785187727725_842` 提供全量原始 SSE。

### B．Claude Code 客户端 transcript：独立恢复旧样本并做全量正向搜索

扫描范围：`/home/xp/.claude/projects/-home-xp-src-copilot-api-js/*.jsonl`，逐行 JSON 解析，筛选 `type=="assistant" && message.stop_reason=="refusal"`。

结果只有 2 行：

1. 一条真实模型消息：`/home/xp/.claude/projects/-home-xp-src-copilot-api-js/aef7321a-543b-4e1e-bbb8-762455cee92b.jsonl:2435`，即 `req_1782214935133_68` 对应的 Opus 4.8 原始最终消息；
2. 紧随其后的 Claude Code `<synthetic>` API Error 包装：同文件 `:2436`，不是第二次上游 refusal，故不计入样本分布。

该检索以真实 `stop_reason:"refusal"` 为正样本，直接恢复了 category=`null`、explanation、content 与完整 usage。请求上下文来自同文件 `:2420-2439`。

### C．退役 V2 与冷归档

只读查询了：

- `/home/xp/.local/share/copilot-api/history.db`：`entries_v2` 当前 0 行；
- `/home/xp/.local/share/copilot-api/archive.db`：`entries_v2` 10 行，`tier1_locator` 0 行，`tier2_manifest` 0 行；按 `id='req_1782214935133_68' OR stop_reason='refusal'` 无命中；
- 四组冷归档目录：`archive/`、`archive-merged-2026-07-18/`、`archive-v2-2026-07-18/`、`archive-new/`。逐库查 `manifest_entry` 的 id 与时间范围；这些保留数据最早约为 2026-07-12，而旧样本是 2026-06-23，不在覆盖范围。随后实现只读 MessagePack/object-dictionary decoder，对 159 个可读冷归档数据库的 71,296 条 `upstream_response` locator、8,884,937 个 frame 做结构化全量扫描，正向命中 `req_1783947618475_731`（两个 archive 快照中的同一 operation），恢复出 category=`bio` 的原始 `message_delta.raw`。

冷归档的 packed SSE 使用 MessagePack/object dictionary 编码，不能靠明文 JSON 搜索来证明不存在；本次按 `sse_locator → MessagePack event tuples → object_index/object_block` 完整解码后再判断 `message_delta.delta.stop_reason==="refusal"`。该扫描既命中已知 2026-07-13 `[REFUSAL]` 日志正样本，也表明冷归档覆盖窗内只有这一条唯一 operation。V3 与冷归档的否定结论均来自完整结构化 frame 解析，旧样本则由客户端 transcript 正向命中。

### D．日志

扫描 `/home/xp/.local/share/copilot-api/copilot-api.log*`，关键词：`[REFUSAL]`、`upstream thinking-only refusal`、`stop_reason`、`stop_details`。当前保留日志覆盖 2026-07-10 至 2026-07-18，只命中 2026-07-13 13:05:12 一条 `[REFUSAL] upstream thinking-only refusal for claude-opus-4-8 -> recorded as error`。结构化冷归档扫描把它绑定到 `req_1783947618475_731`：请求 `13:00:18.475Z` 开始，`13:05:12.265Z` 结束，日志同秒记录失败。日志本身不含 request id 或 `stop_details`，category=`bio` 仍以冷归档原始 frame 为证。日志不覆盖 2026-06-23 与 2026-07-27。

### E．仓库文档与 Git 历史，仅作来源佐证

- `/home/xp/src/copilot-api-js/.worktrees/refusal-diagnostics/docs/refusal-recovery.md:7` 记录旧 id、主编码轮和 thinking-only 形态；
- 原始实现 commit `969ba4ec` 的说明也明确说当时逐字节透传并打 `[OK]`；
- 这些不是 category/usage 的一手来源；category、explanation 与 usage 以客户端 transcript 的模型消息为准。

## ④ 无法下定论的部分及原因

1. **无法证明用户机器生命周期内绝对只发生过这三次 refusal。** 当前 V3 只从约 2026-07-17 开始；冷归档最早约 2026-07-12；保留日志只覆盖 2026-07-10 至 2026-07-18。更早的 History 原始行已经退役删除。客户端 transcript 全量搜索补回了 2026-06-23 的已知旧样本，但如果某次 refusal 来自非 Claude Code 客户端、对应客户端 transcript 已删除、且 History/日志也已过保留期，就无法恢复。
2. **没有找到 `category` key 完全缺失的真实样本。** 已确认的是更承重的兼容形态：`category` key 存在但值为 `null`。因此不能把结论写成“字段缺失”；准确表述是“存在没有非空 category 的 refusal”。
3. **`req_1782214935133_68` 的逐帧原始 SSE 已不可恢复。** 当前可恢复的是 Claude Code transcript 中 SDK 累积后的完整最终模型消息，足以确认 `stop_details`、content blocks 与 usage，但无法逐字列出该请求的每个 SSE frame；旧文档中的帧序只作二手佐证。相比之下，2026-07-13 与 2026-07-27 两条样本都有原始 SSE frame。
4. **`req_1782214935133_68` 没有 `output_tokens_details`。** 原始最终消息该字段缺失，不能把它推断成 `{thinking_tokens:1097}` 或其他值。可确认的只有 `output_tokens:1097` 和唯一 content block 是 thinking。
5. **样本总量仍受数据保留范围限制。** 2026-07-13 日志 refusal 已通过自建只读 decoder 绑定到 `req_1783947618475_731` 并恢复原始 `stop_details`；但 2026-06-23 之前或其它已过保留期、且无客户端 transcript 的请求仍无法恢复。

## 实际执行的核心检索命令

```bash
# 正样本详情（先证检索目标确实存在）
curl -fsS --max-time 120 http://localhost:4141/history/api/entries/req_1785187727725_842

# 旧样本是否仍在当前 History REST
curl -sS --max-time 120 http://localhost:4141/history/api/entries/req_1782214935133_68

# V3 summary 候选，只作交叉验证
sqlite3 -readonly 'file:/home/xp/.local/share/copilot-api/history-v3.db?mode=ro' \
  "SELECT operation_id,created_at,summary_json FROM v3_operations WHERE json_extract(summary_json,'$.responseError')='upstream thinking-only refusal' OR json_extract(summary_json,'$.stopReason')='refusal';"

# V2 退役库与归档索引
sqlite3 -readonly 'file:/home/xp/.local/share/copilot-api/history.db?mode=ro' \
  "SELECT id,started_at,model,status,stop_reason FROM entries_v2 WHERE id='req_1782214935133_68' OR stop_reason='refusal';"
sqlite3 -readonly 'file:/home/xp/.local/share/copilot-api/archive.db?mode=ro' \
  "SELECT id,started_at,model,status,stop_reason FROM entries_v2 WHERE id='req_1782214935133_68' OR stop_reason='refusal';"

# 日志与客户端 transcript
rg -n -a '\[REFUSAL\]|upstream thinking-only refusal|stop_reason|stop_details' /home/xp/.local/share/copilot-api/copilot-api.log*
rg -l -a 'req_1782214935133_68' /home/xp/.claude/projects/-home-xp-src-copilot-api-js/*.jsonl
```

另执行了两个只读 inline Bun 解码器：① zstd 解压并 JSON 解析 V3 的全部 `v3_objects(kind='frame')`，再用全部 `v3_operations.manifest_gz` 把命中 hash 映射回 operation；② zstd + MessagePack 解码全部冷归档 `sse_locator/object_index`，扫描 159 库、71,296 条 upstream-response locator、8,884,937 frame。两者的统一判据均为 `delta.stop_reason === "refusal"`（同时兼容 whole-message 的 `stop_reason` 与 `message.stop_reason`）。
