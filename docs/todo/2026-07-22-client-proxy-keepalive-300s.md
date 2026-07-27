# 独立任务 kickoff：client↔proxy keepalive 对 CC 300s「无真实内容」死线失效（可能现网回归）

> 状态：**已定位并修复（2026-07-27）**。从续写重试特性（`docs/spec/2026-07-22-continuation-retry-and-sequential-anchor.md` §3.4）的 G2 门实测中剥离出的独立问题——它与续写正交，且确认是**代理活路径的既有吞帧回归**；真实现网是否已经触发取决于上游是否发送空 `text_delta`（当前默认 `ping` 模式的代理合成心跳不经过该改写器，不能据 G2 单独证明已有真实用户请求受害）。
> 日期：2026-07-22；根因裁决与修复：2026-07-27
>
> **最终裁决**：`Response stalled mid-stream` 是 Claude Code 自己在 300s event-idle watchdog 后对“已有部分输出”的友好报文，不是代理产生的错误；代理自己的 `streamIdleTimeout` 也没有触发。G2 的上游 hook 确实每 15s 产出空 `text_delta`，而 shipped config 中开启的 `anthropic.response_text_fix.invoke_in_text` 令 `recoverToolCallText` 响应改写器把短 text delta 放进 tool-call marker lookahead；空字符串永远无法推进窗口，因而被静默吞掉，下游实际只收到代理每 20s 合成的 `event: ping`。修复在 `src/lib/anthropic/recover-tool-call/stream.ts`：空 `text_delta` 不携带可恢复文本，直接逐帧透传，保留非空文本的 lookahead 语义。真 `curl -N` 证修前 gap 期 15 个 ping、0 个空 delta，修后 21 个 gap 空 delta、0 个 ping；真 Claude Code 2.1.220 修前 300.4s FAIL，修后连续两次 315.5s PASS，最终文本均仅 `IDLE_SURVIVED_MARKER`、无保活痕迹。

## 一句话

CC 有一个 **300s「无真实内容 chunk」idle 死线**（独立于 60s byte-idle）。2026-07-22 的 G2 历史实验在 302s 报 `Response stalled mid-stream`，当时误判为空 `text_delta` 载体无效；2026-07-27 逐层抓字节后确认，代理的 `recoverToolCallText` lookahead 把上游每 15s 产出的空 delta 全吞掉，CC 实际只收到 ping。修复后同一 >310s 实验连续两次通过。当前 shipped keepalive 默认仍是 `ping`（D2 用户决策），所以是否重新启用 `empty_text` 是独立产品决策，不在本 bugfix 中擅自翻转。

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

### ⚠ 2026-07-22 实测更新——裁决翻转：根因是「路径」不是「delta 类型」

两 arm 在 CC **2.1.217**、first-party 路径实跑结果：**thinkdelta 与 textdelta 都 PASS**（`is_error:false, duration_ms≈340476, result:"ok"`，`exp/cc-idle-280s/arm{B,D}*.cli.log`）。即 **first-party 路径上空 text_delta 也能重置 300s 死线**——上面两个候选根因（text_delta 特有 / CC 版本收紧）**均被证伪**。

而 G2（`exp/block-level-anchor-sequential/idle-300s.ts`，**经真代理**路径、空 text_delta）在 302s stall，报 **`Response stalled mid-stream. The response above may be incomplete.`**。

**新根因假设（待新会话定）：差异在「路径」——first-party watchdog vs 经代理（custom URL + token）。** 两条线索：
1. **可能不是 CC 的 300s 死线，而是代理自己的上游 stall 检测**：G2 报文 `Response stalled mid-stream` 与 CC 的 `no chunks received`（arm A/C 的 300s 死线报文）**不同**——很可能是**代理侧的 upstream-idle/stall 看门狗**在 ~300s 触发注入的 error，而非 claude 的死线。查 `src/lib/transport/`（上游 fetch/h2 idle）+ 上游 stall 检测代码：代理是否有自己的 ~300s 上游空闲判定、且只认「真实内容帧」不认空 delta / 只认上游轨。
2. **或代理没把空 text_delta 逐字节忠实转发**：G2 config 用 `stream_keepalive_mode: ping` + `protect_streaming_generation: false`（live 透传），但仍可能被某层改写/丢弃 gap 期空 delta。用 `curl -N` 直接看代理下行字节确认空 text_delta 是否真到客户端。

**新会话第一步改为**：复现 G2（经代理路径）+ 抓代理下行字节（curl -N）+ 定位 `Response stalled mid-stream` 报文的产生点（代理代码 grep 该字面量）——先确定是**代理 stall 检测**还是 **CC 死线**，再谈载体。first-party 两 arm 已证 delta 类型不是问题。

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
