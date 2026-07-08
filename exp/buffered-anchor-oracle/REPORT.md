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
| mock | `MOCK_SILENCE_SEC=320` · `MOCK_ANCHOR_SILENCE_SEC=25` · `MOCK_MODEL=claude-opus-4-8` |

## 三臂结果

| 链 | mode | CC `is_error` | CC `duration_ms` | CC `num_turns` | mock 计数器 | 判据 | GO/NG |
|---|---|---|---|---|---|---|---|
| **1 保活** | `stream_keepalive_mode=empty_text` | （待填） | （待填，期望 >300000） | — | `messagesSeen` / `validationRejections` | `is_error=false` 且 `duration_ms>300000` | （待填） |
| **1 对照** | `stream_keepalive_mode=content_delta` | （待填，期望 true） | （待填，期望 ≈300000） | — | — | 预期 NG：≈300s 断 `no chunks received` | （待填） |
| **2 thinking-首块** | `empty_text` | （待填，期望 false） | （待填） | （待填，期望 ≥2） | `validationRejections`（期望 **0**） | `is_error=false` 且 mock `validationRejections==0` | （待填） |
| **3 retry 透明** | `empty_text` | （待填，期望 false） | （待填） | （待填） | `messagesSeen`（期望 **2**） | 单条完整生成、`message_start` 恰 1 次、index 连续 | （待填） |

## 关键 wire 观测（History API / forwarded 轨）

- **链 1**（期望）：forwarded 轨含 `content_block_start{text}`（`synthetic:"anchor"`）+ 空 `text_delta`（`synthetic:"keepalive"`）×N + commit 时 `content_block_stop@0` + 真实 thinking 块在 index 1。粘贴实测：（待填）
- **链 2**（期望）：turn-1 forwarded 轨 = `[message_start, anchor start@0, anchor delta, …, anchor stop@0, thinking@1, tool_use@2]`；turn-2 上游请求体经 `filterEmptyAnthropicTextBlocks` 剥空 text，thinking 复位首块 → mock 200（无 400）。粘贴实测：（待填）
- **链 3**（期望）：forwarded 轨 `message_start` 恰 1 次、真实块 index 连续、无双 message_start、无中途 error 帧。粘贴实测：（待填）

## CC json 摘录

```
# 链 1（keepalive.cli.log）
（待填）

# 链 1 对照（keepalive-content_delta.cli.log）
（待填）

# 链 2（thinking.cli.log）
（待填）

# 链 3（retry.cli.log）
（待填）
```

## mock 日志摘录（关键相位 + 400/RST）

```
（待填：keepalive 静默相位 + tail；thinking turn1 anchor 静默 + tool_use tail + turn2 200；retry attempt1 RST + attempt2 clean；validationRejections）
```

## 门控结论

（待 agent 填写：三臂全符合预期 → 门控通过；任一 NG 尤其链 2 400 → 阻断，回 spec §3.6 调收口形状并记录。）
