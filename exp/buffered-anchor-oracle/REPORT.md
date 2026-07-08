# buffered `empty_text` 合成锚点 —— 真实 CC oracle 结果（门控）

**日期：** （待填，运行日）
**性质：** 实测（受控 mock GHC 上游 + 真实 `claude` CLI 2.1.20x 作 oracle，夹在 copilot-api 代理背后）。
**运行者：** 用户（`no-auto-server` —— agent 不启动服务器）。
**门控判定：** （待 agent 据下方结果填写：PASS / NG + 后续动作）

复现与判据见 [`README.md`](README.md)。以下表格由运行结果填充。

---

## 环境

| 项 | 值 |
|---|---|
| `claude --version` | （待填） |
| 代理 commit / 分支 | `feat/empty-text-anchor` @（待填 short hash） |
| 代理配置 | `ghc_api_base_url=http://localhost:8890` · `protect_streaming_generation=tool_use_only` · `stream_commit_after_sec=20` · `stream_keepalive_ping_sec=20` |
| mock | `MOCK_SILENCE_SEC=320` · `MOCK_ANCHOR_SILENCE_SEC=25` · `MOCK_MODEL=claude-opus-4-8` · `MOCK_AUX_MODEL=claude-mock-haiku`（aux 隔离） |

## 结果

| 链 | mode | CC `is_error` | CC `duration_ms` | CC `num_turns` | mock 计数器 | 判据 | GO/NG |
|---|---|---|---|---|---|---|---|
| **1 保活** | `stream_keepalive_mode=empty_text` | （待填） | （待填，期望 >300000） | — | `messagesSeen` / `validationRejections` | `is_error=false` 且 `duration_ms>300000` | （待填） |
| **1 对照** | `stream_keepalive_mode=content_delta` | （待填，期望 true） | （待填，期望 ≈300000） | — | — | 预期 NG：≈300s 断 `no chunks received` | （待填） |
| **2 thinking-首块（端到端）** | `empty_text` | （待填，期望 false） | （待填） | （待填，期望 ≥2） | `validationRejections`（期望 **0**）· `auxRequestsSeen`（观测） | `is_error=false` 且 mock `validationRejections==0`（**端到端不 400 = 生产安全**） | （待填） |
| **2 正样本对照（`replay-turn2.sh`，门控必需）** | `empty_text` | — | — | — | `messagesSeen≥1` 且 `validationRejections`（期望 **0**） | 脚本 **PASS**（严格归因：代理 `filterEmptyAnthropicTextBlocks` 在剥，非 CC） | （待填） |
| **3 retry 透明** | `empty_text` | （待填，期望 false） | （待填） | （待填） | `messagesSeen`（期望 **2**） | 单条完整生成 + **History `clientResponse.sseEvents` 上 `message_start` 恰 1 次 + index 连续（门控必需）** | （待填） |

## 关键 wire 观测（History API / forwarded 轨）

- **链 1**（期望）：forwarded 轨含 `content_block_start{text}`（`synthetic:"anchor"`）+ 空 `text_delta`（`synthetic:"keepalive"`）×N + commit 时 `content_block_stop@0` + 真实 thinking 块在 index 1。粘贴实测：（待填）
- **链 2 正样本对照**（`replay-turn2.sh`）：粘贴脚本 VERDICT + mock 计数器（`messagesSeen` / `validationRejections`）+（可选）History inbound(`clientRequest`) vs outbound(`attempts[].upstreamRequest`) 轨之差（前导空 text 在入站有、出站被剥）：（待填）
- **链 3**（**门控必需**）：从 History `GET /history/api/entries/:id` 取 `clientResponse.sseEvents`，粘贴证明 `message_start` 恰 1 次、真实块 index 连续、无双 message_start、无中途 error 帧；并粘贴 `attempts[]` 证明恰 2 个 attempt（attempt1 截断 + attempt2 成功）：（待填）

## CC json 摘录

```
# 链 1（keepalive.cli.log）
（待填）

# 链 1 对照（keepalive-content_delta.cli.log）
（待填）

# 链 2（thinking.cli.log）
（待填）

# 链 2 正样本对照（replay-turn2.response.log + 脚本 VERDICT）
（待填）

# 链 3（retry.cli.log）
（待填）
```

## mock 日志摘录（关键相位 + 400/RST）

```
（待填：keepalive 静默相位 + tail；thinking turn1 anchor 静默 + tool_use tail + turn2 200；replay-turn2 主模型 inbound + validationRejections；retry attempt1 RST + attempt2 clean；任何 AUX-model 行应标 `AUX model=…`）
```

## 门控结论

（待 agent 填写：三臂 + 链 2 正样本对照 + 链 3 wire 检查全符合预期 → 门控通过；任一 NG 尤其链 2 400 / 正样本对照 NG / 链 3 wire 非单 message_start → 阻断，回 spec §3.6 调收口形状并记录。）
