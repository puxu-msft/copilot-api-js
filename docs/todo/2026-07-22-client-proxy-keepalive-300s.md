# 独立任务 kickoff：client↔proxy keepalive 对 CC 300s「无真实内容」死线失效（可能现网回归）

> 状态：待处理（新会话执行）。从续写重试特性（`docs/spec/2026-07-22-continuation-retry-and-sequential-anchor.md` §3.4）的 G2 门实测中剥离出的独立问题——它与续写正交，且可能是**既有生产回归**，故单列。
> 日期：2026-07-22

## 一句话

CC 有一个 **300s「无真实内容 chunk」idle 死线**（独立于 60s byte-idle）。实测（2026-07-22，真 claude **2.1.217**）：**空 `text_delta` 每 15s 保活并不能重置它**——>310s 上游静默的流在 302s 被 CC 报 `Response stalled mid-stream` 掐断。而当前生产的 `stream_keepalive_mode: empty_text` 发的正是空 `text_delta`，故**现网对 >300s 文本块静默的保活很可能已失效**（正中「opus 长 pre-content thinking 沉默几百秒」的真实场景）。

## 证据 + 待裁决的根因

### 已有取证（`exp/cc-idle-280s/REPORT.md`，2026-07-04，CC **2.1.201**）
- 确立 300s no-real-content 死线：`event: ping` / SSE comment 不重置；**空 `thinking_delta`（content_block_delta）能重置**（arm B 存活 340s）。
- **关键盲区**：空 **`text_delta`** 从没单测过，报告只写「预期同样有效，实现时应补测」。

### 新证据（2026-07-22，CC **2.1.217**）
- `exp/block-level-anchor-sequential/idle-300s.ts`（顺序 anchor + >310s gap + 每 15s 空 `text_delta`）→ **FAIL**，302s stall。这是空 text_delta 的**首次实测**，且在更新的 CC 版本上。

### 根因二选一——新会话第一步用两 arm 裁决（可能已有结果）
在 CC 2.1.217 上并行跑（`exp/cc-idle-280s/run-arm.sh` 已支持 `thinkdelta` / `textdelta` 两 TYPE）：
```bash
cd exp/cc-idle-280s
INTERVAL=20 WINDOW=340 CC_CEIL=400 bash run-arm.sh armB-thinkdelta thinkdelta 8891
INTERVAL=20 WINDOW=340 CC_CEIL=400 bash run-arm.sh armD-textdelta  textdelta  8892
```
（2026-07-22 本会话已后台启动一次，日志可能在 `/tmp/g2b_think.log` / `/tmp/g2d_text.log`；不确定则重跑。）

判读：
- **thinkdelta PASS + textdelta FAIL** → 根因 = **text_delta 特有**（空 text_delta 从不算真实内容，只有 thinking_delta 算）。修法：文本块场景的保活载体不能用空 text_delta。
- **两者都 FAIL** → 根因 = **CC 2.1.217 收紧了 watchdog**（任何空 delta 不再算）。修法：保活必须带非空内容。

## 范围界定（勿夸大）
- **< 300s 的静默不受影响**——包括续写 incident req_162 的 142.9s。续写特性**不被此问题阻断**（续写救的是首块后 tool_use RST，非静默）。
- 仅 **>300s 上游静默**受影响（长 thinking / 大 payload 慢首字节）。

## 修复方向（据根因定）
1. **非空但客户端无害的载体**：如零宽字符 `​` 的 text_delta，或可辨识的合成 marker text。风险：污染客户端渲染 + 累积进最终文本 → 须验证 SDK/CLI 累积不显形、且能重置死线。
2. **thinking_delta 载体**（若 thinkdelta 仍有效）：文本块场景切到空 thinking_delta 保活——但要处理 thinking 块的 signature 契约 + 块状态感知（不能在 text 块 open 时发 thinking_delta，违反协议）。
3. **保守 cadence**：死线值可能随 CC 版本变动，keepalive 间隔应留余量（如 ≤200s）。
4. 合成保活帧**只进 forwarded 轨**（`clientResponse.sseEvents`）、打 `synthetic:"keepalive"` 标记、**绝不进上游原始轨**（richest-data-flow ADR）。

## 相关文件
- keepalive 帧构建：`src/lib/anthropic/keepalive-frame.ts`、`keepalive-anchor.ts`（`stream_keepalive_mode` = ping/enveloped_ping/empty_text）。
- 消费/接线：`src/routes/messages/handler-v4.ts`（anchor hooks + sink）。
- 探针 harness：`exp/cc-idle-280s/`（run-arm.sh + mock.ts，first-party watchdog 路径）。
- 客户端连接死线背景：skill `debugging-claude-client-connection`（60s byte-idle + 300s no-real-content 两层）。

## 验收
- 用 `exp/cc-idle-280s` 复现：修复后的 keepalive 载体让 >300s（如 340s）静默的真 claude **不 stall、完整收尾**、且最终客户端文本**不含保活痕迹**。
- 连跑多次证确定性；prod-faithful 路径（经代理 custom URL，非仅 first-party）复测一次。

---

### 复制给新会话的提示词

> 处理一个可能的现网 keepalive 回归。先读 `docs/todo/2026-07-22-client-proxy-keepalive-300s.md`（完整背景 + 证据 + 根因二选一 + 修复方向）。第一步：在当前 CC 2.1.217 上用 `exp/cc-idle-280s/run-arm.sh` 跑 thinkdelta / textdelta 两 arm 裁决根因（空 text_delta 是否重置 300s no-real-content 死线；日志可能已在 /tmp/g2b_think.log、/tmp/g2d_text.log）。据裁决选修复载体（非空不可见 text / thinking_delta / 保守 cadence），合成帧只进 forwarded 轨打 synthetic 标记、不污染上游轨。用 exp/cc-idle-280s 验收 >300s 静默不 stall 且客户端文本无保活痕迹，连跑多次证确定性。裁决实测 > 文档 > 声称（skill empirical-verification）。范围仅 >300s，<300s（含续写 incident）不受影响、不要牵扯续写特性。
