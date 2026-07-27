# 客户端心跳（keepalive）方案穷举与推荐

调研对象：`/home/xp/src/copilot-api-js`，下游客户端 Claude Code（参照源码 `~/.claude/refs/claude-code-2.1.207/app.pretty.js`，本机实际安装 **2.1.220**）。
日期：2026-07-27。性质：**源码读证 + 生产 History 只读探针**（未跑真实客户端 e2e，未改任何生产代码）。

---

## 0. 结论摘要（先看这个）

1. **前提被推翻两处**（详见 §1）：
   - 现网 keepalive 发的是**裸 `ping`**（`stream_keepalive_mode: ping`，ADR 2026-07-22 D2 已把 `empty_text` 退役为休眠）。**空 text 锚块不是现网行为**，用户看到的回流空 text block 来自**上游 GHC**，不是我方注入。
   - **不存在「成功的 314s 请求」**。405 条唯一 entry 中 >240s 的 7 条里，**唯一 completed 的是 292.7s（<300s）**；314.7s 那条 `state=failed`。
2. **「只有真实 `content_block_delta` 能重置 300s」这条表述不准确**。CC 源码的真实判据是：**SDK 吐给 CC 的任何 `data.type !== "ping"` 的 SSE 事件都重置**（`content_block_start` / `content_block_stop` / `message_delta` 全部算）。而 `event: ping` 帧被 **SDK 在到达 CC 之前就丢弃**，所以 ping 永远不可能重置。
3. **现网确实在 300s 墙上持续死亡**，5 个生产样本逐毫秒吻合（§2.3）。这是**当前活跃的生产缺陷**，不是历史遗留。
4. 共给出 **12 个方案**（§4），推荐**分层组合**（§5）：Tier-1「真实开块上的空 delta」是零污染、零代价、必做；Tier-2「pre-content 无开块窗口」才是真正的取舍点，推荐 `message_delta` 心跳为主、推迟 commit 为辅。

---

## 1. 前提核实（哪些我实测/读证了，哪些被推翻）

### 1.1 现网 keepalive 形态 —— 【实测，推翻原始问题陈述】

`config.yaml:765` = `stream_keepalive_mode: ping`；默认值 `src/lib/state-defaults.ts:76` 也是 `"ping"`，注释写明：

> `ADR 2026-07-22 D2: empty_text retired as default (wrong-shaped, G2-ineffective); kept selectable/dormant for research`

生产 History 抽样（4141 只读）中所有 keepalive 帧都是：

```json
{"offsetMs": 20011, "offsetSource": "observed", "type": "ping", "raw": "{\"type\":\"ping\"}", "synthetic": "keepalive"}
```

**结论**：`anchorStartFrame()` / `anchorDeltaFrame()` 这条空-text 锚路径当前**不在生产活路径上**。原始问题陈述里「注入合成空 text 块 → 被客户端 baked → 回流 → sanitize 删出 thinking 相邻」的因果链，**第一环不成立**。

### 1.2 回流的空 text block 来自上游 —— 【实测确认】

生产 entry `req_1785179546269_3` 的 `clientRequest` 里确实有 assistant 消息 `content = [text, text(empty), tool_use]`。但它的来源是上游 GHC 自己发的空 text 块（我方 forwarded 轨里这类 `content_block_start {text:""}` 帧 `synthetic` 为 `None` = 未标记 = 真实上游帧）。

**这意味着「删空 text 块 → 删出两个 thinking 相邻」的问题依然真实存在，但它是上游行为的下游后果，不是 keepalive 的锅。**修 keepalive 不解决它；反过来，keepalive 若再注入空 text 块，会**叠加**放大这个已存在的问题。这一点对方案取舍很关键（见 §4.1）。

### 1.3 CC 的 watchdog 真实机制 —— 【源码读证，修正既有文档】

`app.pretty.js:298199-298206`（流式消费主循环）：

```js
for await (let ar of v1y(Ae, vo)) {
  if (ar.type === "ping") {
    yield { type: "stream_event", event: ar };
    continue;            // ← 不调 he()，不重置
  }
  he();                  // ← 任何非-ping 事件都重置两个计时器
  ...
```

`he()`（`:298086-298093`）清掉并重新武装两个定时器：`qi = ll/2` 的 warn 和 `ll` 的 abort。

- `ll = x0i()`（`:88228`）= `Math.max(Number(process.env.CLAUDE_STREAM_IDLE_TIMEOUT_MS) || 0, 3e5)` → **300s 是地板，只能调高不能调低**。
- 触发时（`:298092`）设 `wn = true` 并 abort 流；随后按已产出块数分叉文案（`:298366` / `:298411`）：
  - 零块 → `Stream idle timeout - no chunks received`
  - 已有块 → `Response stalled mid-stream. The response above may be incomplete.`（`:298433`）

**SDK 层**（bundled `@anthropic-ai/sdk`，`app.pretty.js:10013-10017`）：

```js
if (a.event === "message_start" || a.event === "message_delta" || a.event === "message_stop"
 || a.event === "content_block_start" || a.event === "content_block_delta" || a.event === "content_block_stop"
 || a.event === "message" || ...) try { yield JSON.parse(a.data); } catch (l) { throw ... }
if (a.event === "ping") continue;      // ← ping 帧被 SDK 吞掉，CC 永远看不到
if (a.event === "error") { throw new li(...) }
```

**由此得到精确判据（取代 skill 里"只有真实 content_block_delta 能重置"的说法）**：

> 一帧能重置 CC 的 300s 死线，当且仅当：① `event:` 名 ∈ SDK accept-set（`message_start` / `message_delta` / `message_stop` / `content_block_start` / `content_block_delta` / `content_block_stop` 等）**且** ② `data` 能 JSON.parse **且** ③ `data.type !== "ping"`。
>
> 推论：`content_block_start`、`content_block_stop`、`message_delta` **都能重置**——不必是 content delta。`event: ping` 帧**永远不能**（被 SDK 丢弃）。无 `event:` 行的帧也不能（不在 accept-set → 静默丢弃，既有 skill 这条正确）。

CC 的 switch（`:298244-298351`）只有 `message_start` / `content_block_start` / `content_block_delta` / `content_block_stop` / `message_delta` / `message_stop` 六个 case，**没有 default 分支**——未知 `type` 走完 `he()` 后无任何副作用，只被 `yield {type:"stream_event", event: ar}` 透出。这是 §4.8 方案的基础。

### 1.4 60s byte-idle 层 —— 【源码读证，与既有文档不符，需重测】

字节级 watchdog 是 `v_h()`（`:88241`），但它的**安装是有条件的**（`:88358`）：

```js
let u = await r(i, c), d = u.headers.get("content-type"),
    p = o2 && d?.includes("text/event-stream");   // o2 = Kgc(n3)
if ((p || f) && u.body && zgc()) { ...安装 v_h... }
```

`Kgc(e2)`（`:88334`）= `e2 === "firstParty" && qd()`；`qd()`（`:57332`）→ `gLn()`（`:57336`）：`ANTHROPIC_BASE_URL` 已设 → 返回 `hIe(url)`（是否官方 Anthropic 域名）。**我方代理是 localhost → false → 字节级 watchdog 在经代理路径上根本不安装。**

且其超时值 `k0i()`（`:88231`）= firstParty 180s / 其他 300s，clamp 到 `[1e4, 18e5]`——**2.1.207 里没有 60s 这个数**。

**判定**：skill `debugging-claude-client-connection` 里「60s byte-idle、任意字节重置、≥6× 60s-spaced 自动重试」这条，在 2.1.207 源码里找不到对应实现；它很可能来自 2.1.185/2.1.201 的旧行为，或另有机制（如 OS/h2 层）。**这是"推断被当成实测"的一处**，标记为待重测。
**实务影响：无。**我方 `stream_keepalive_ping_sec: 20` 无论如何都远低于任何候选阈值，保守保留即可。

### 1.5 pre-commit（响应头到达前）CC 等多久 —— 【源码读证，本轮新增】

**关键结构性事实：300s watchdog 的第一次武装（`he()`，`:298185`）发生在 `do { yi = await lo.next() } while(!yi.done)` 之后——即响应头已到、Stream 对象已拿到之后。** 头没到之前，300s 时钟根本没起跑。

头到达之前由 SDK 的 client-level `timeout` 管（`:88111`）：

```js
b = { defaultHeaders: p, maxRetries: t2,
      timeout: parseInt(process.env.API_TIMEOUT_MS || String(6e5), 10), ... }
```

→ **默认 600s**。超时抛 SDK 的 `Yg`，CC 在 `:298409` 转成 `new vde({message:"Request timed out"})`。
（另有 `f1y()`（`:297651`）= `API_TIMEOUT_MS || (CLAUDE_CODE_REMOTE ? 120s : 300s)`，但用在 `:297665` 的另一条查询路径，非 `/v1/messages` 主流式路径。）

**这直接回答了"静默期能不能什么都不发"**：

> 能——**在响应头发出之前**，预算约 **300s**（**2026-07-27 实测订正**：原写「~600s（`API_TIMEOUT_MS`）」是错的，那个 600s 计时器永远轮不到触发，实际由更低层的 undici 默认 `headersTimeout` 在 ~300s 中止；见 `exp/silence-recovery-gates/FINDINGS.md` §「Q1 续测」），且**期间一帧都不用发**。一旦我方 commit（发 200 + headers），CC 的 300s idle watchdog 起跑。
>
> 我方当前 `stream_commit_after_sec: 20` **主动在第 20 秒开跑 idle watchdog**。~~若把 commit 推迟到 T 秒，总预算变成 T + 300s。~~ **该加法已作废（2026-07-27）**：commit 后那个 300s 是**可重置的 idle watchdog**（非-ping 事件即重置，且我方 `streamKeepaliveEscalateSec` 默认 200s 主动重置它），不是从 commit 起只跑一次的总时限。**commit 时机仍是一个杠杆**（§4.9），但它买到的是「上游报错时还能返回真 HTTP 状态码」这项能力，不是一段可加总的预算。

---

## 2. 现网损伤的量化证据（只读 History，独立 oracle）

### 2.1 抽样

`GET localhost:4141/history/api/entries?limit=200` 翻页共取到 **405 条唯一 entry**。>240s 的全部 7 条：

| durationMs | state | endpoint | model |
|---|---|---|---|
| 338.1s | **aborted** | anthropic-messages | claude-opus-5 |
| 320.0s | **aborted** | anthropic-messages | claude-opus-5 |
| 314.7s | **failed** | anthropic-messages | claude-opus-5 |
| 309.0s | **aborted** | anthropic-messages | claude-opus-5 |
| **292.7s** | **completed** | anthropic-messages | claude-opus-5 |
| 281.6s | failed | anthropic-messages | gpt |
| 271.4s | failed | anthropic-messages | claude-opus-5 |

**没有任何 completed 的请求超过 300s。**「成功的 314s 请求」= `req_1785179198417_5582`，`state: failed`（上游连续三次 529）。

### 2.2 阳性对照（唯一的长时间成功请求）

`req_1785180629203_212`，292.7s，completed，2833 帧客户端事件。
**非-ping（= 可重置）帧之间的最大间隔 = 257.4s < 300s。** 它活下来了。

### 2.3 阴性样本逐毫秒吻合

| entry | 最后一次"可重置"帧 | 死亡时刻 | 差值 | state / error |
|---|---|---|---|---|
| `req_1785177552554_5463` | 无（commit@+20s 后只有 ping） | 320.024s | **300.0s** | aborted |
| `req_1785177872790_5500` | commit-rel +6ms（≈ +9.0s 绝对） | 309.014s | **300.0s** | aborted，`"client disconnected"` |
| `req_1785176396642_5257` | commit-rel +0ms（≈ +6.6s 绝对） | 306.678s | **300.0s** | aborted |

`req_1785177872790_5500` 的完整客户端轨（offsetMs 为 commit-relative）：

```
     3ms  message_start
     4ms  content_block_start  thinking@0
     5ms  content_block_delta  signature_delta
     6ms  content_block_stop   @0
     6ms  content_block_start  tool_use@1  {"name":"Write"}     ← 最后一帧能重置的
 20011ms  ping (keepalive)
   ...    ping × 13，每 20s
280720ms  ping (keepalive)
300045ms  content_block_delta  input_json_delta {"partial_json":""}   ← 上游终于恢复
300045ms  content_block_delta  input_json_delta {"partial_json":"{\"fi"}
300045ms  ...（tool 输入 JSON 继续流）
```

**上游在一个 `tool_use` 块的输入 JSON 中途静默了整整 300s**，我方每 20s 发 ping，CC 在 `content_block_start@1` 之后的第 300.0 秒精确掐断。上游恢复得晚了 45 毫秒。

**这三条阴性 + 一条阳性构成完整判据链：ping 不重置 300s 死线，且现网正在因此持续丢请求。**

### 2.4 一个副产品观察（值得单独立项，非本轮范围）

`5500` / `5257` 两条的上游静默都**恰好在 300.0s 结束**。同时 `attempts[].upstreamResponse.sseEvents` 的 offsetMs 显示上游 10 帧全在 1-6ms 内，与客户端轨 300s 的落差矛盾——**上游轨与客户端轨的时间基或采样点至少有一处不忠实**。这与记忆库 `project-upstream-silence-commit-timing-spec` 是同一片地。建议单独探针，不在本报告方案面内。

### 2.5 失败形态的分布（决定方案分层）

4 条 ≥300s 的死亡样本里：

- **2 条（5463 / 5582）**：上游 0 帧，纯 pre-response 静默 → 客户端侧**没有任何开块**。
- **2 条（5500 / 5257）**：上游已开块（`tool_use` / `text`）后 mid-stream 静默 → 客户端侧**有一个真实开块**。

**这个 50/50 分布决定了方案必须分两层**：有开块的情形有一个零成本解，无开块的情形才是真正的设计取舍。

---

## 3. G2「空 text_delta 无效」这条裁决站不住（D2 的前提需要重审）

ADR 2026-07-22 D2 把 `empty_text` 退役，判据是两条：①「空-text block 是错误形状」②「**G2 实证不能重置 CC 300s 死线**」。第 ② 条我认为**被证伪或至少有未排除的混淆变量**：

### 3.1 与源码矛盾
`content_block_delta` 的 `event:` 名在 SDK accept-set 内，`data.type = "content_block_delta"` ≠ `"ping"` → CC 必然执行 `he()`。**空不空与重置无关**——CC 根本不看 delta 内容（`:298199-298206` 的判据只有 `ar.type === "ping"`）。

### 3.2 与其余全部实测矛盾
`exp/cc-idle-280s/REPORT.md` 的四臂 + 2026-07-22 的两臂，共 6 个 arm 说空 delta 有效，覆盖了 CC 2.1.201 与 **2.1.217**、first-party 与 **prod-faithful** 两条接线：

| arm | 载体 | 接线 | 结果 |
|---|---|---|---|
| armB | 空 `thinking_delta` | first-party | ✅ 340s |
| armT | 空 `text_delta` | first-party | ✅ 340s |
| armJ | 空 `input_json_delta` | first-party | ✅ 340s |
| armPT | 空 `thinking_delta` | **prod-faithful** | ✅ 340.4s |
| armLive-empty_text | 代理合成前奏 + 空 `text_delta` | **真代理端到端** | ✅ 330.5s completed |
| armB/armD 复跑 | 空 thinking / 空 text | first-party，**CC 2.1.217** | ✅ 两者皆 PASS |

对照臂 armA/armC/armP/armLive-ping（ping 与 SSE 注释）全部 ❌ 300s——与我 §1.3 的源码判据完全一致。

**唯一的反例只有 G2 一个。**

### 3.3 G2 的混淆变量没有被排除
`docs/todo/2026-07-22-client-proxy-keepalive-300s.md` 提出的主假设是「掐断源可能是**代理自己**的 stall 检测」。**这个假设可以直接排除**：`Response stalled mid-stream. The response above may be incomplete.` 是 **CC 自己的字面量**，在 `app.pretty.js:298433`，由 `Ws = wn`（= CC 的 300s watchdog 已开火）分支产出。代理源码里 grep 不到该字符串。所以 G2 确实是 CC 的 300s 死线开的火。

但这恰恰把问题推向另一边：**CC 开火 ⇒ 它 300s 内一帧可重置的都没收到 ⇒ G2 的 21 个空 `text_delta` 没有一个到达 CC 的 SDK。** 时间也吻合：G2 在 **302s** 失败，而它的最后一帧真实事件（`content_block_start@2`）在 t≈1-2s —— 正好 300s。

`exp/block-level-anchor-sequential/idle-hook.ts` 本身是**带 `event:` 行的**（`yield { event: "content_block_delta", data: atob(GAP_KEEPALIVE) }`），所以不是 SDK 丢帧那个经典坑。丢失点在**上游 hook → 代理下行字节**之间，尚未定位。候选：hook exchange 帧的消费/缓冲、块级递送对未闭合块的扣留、post-render 改写。

### 3.4 判定
> **D2 的第 ② 条判据（"G2 实证空 text_delta 不能重置"）在证据权重上被 1 份源码 + 6 个对照臂压倒，应视为一次带混淆变量的假阴性，而不是关于 CC 行为的事实。**
> D2 的第 ① 条判据（"空-text block 是错误形状、会被 baked 进历史"）**依然成立**（§4.1 会给出 CC 源码级证明），并且足以单独支撑"不要用空 text 锚块"这个结论。
> **所以：D2 的结论（退役 empty_text 锚块）方向对，理由半错。** 半错的那一半正在造成实际损害——因为它同时把"在真实开块上打空 delta"这个**完全无害、零污染**的机制一起关掉了（§4.3）。这是当前生产 300s 死亡的直接原因。

**证伪实验（低成本，应优先做）**：在非 4141 端口起测试代理 + G2 hook（gap 缩短到 40s），`curl -N` 直接抓代理下行字节，数经过 wire 的空 `text_delta` 帧数。到达数 = 0 → 代理丢帧（定位丢失层）；到达数 = 预期 → G2 的 harness/CLI 侧另有问题。这一发探针即可关闭 D2 遗留的全部不确定性。

---

## 4. 方案面穷举（12 个）

统一评估轴：
- **两层超时**：能否同时压住字节层与 300s 事件层。
- **是否被 baked**：客户端是否把它写进对话历史并在下一轮回流。
- **需客户端配合**：是否要改 CC 的配置/环境。
- **腿适用性**：仅 Anthropic 腿，还是通用。

先给一条贯穿所有方案的 CC 源码事实（后面反复用到）：

> **CC 只在 `content_block_stop` 时把块物化成 assistant 消息**（`app.pretty.js:298301-298312`：`_r.push(Kn), la.set(index, Kn), yield Kn`）。这是全流程**唯一**的内容物化点。
> 且 `eJr()` 的 `case "text"`（`:368803`）对空文本**只打一条遥测 `tengu_model_whitespace_response`，原样返回、不过滤**。
> ⇒ **闭合过的空 text 块必然进历史；从未闭合的块永远不进历史。**

### 4.1 现状 A：空 text 锚块（`empty_text`，当前休眠）

- 机制：无开块时合成 `message_start` + `content_block_start{type:"text",text:""}` + 周期空 `text_delta`，commit/终止时 `content_block_stop`。
- 两层超时：**都能压住**（§3.2 六臂实证 + 源码）。
- **被 baked：会。** 由上面的源码事实直接判定——锚块被 `anchorStopFrame()` 闭合了，CC 必然物化成一条 assistant 消息并写入 transcript。下一轮回流 → 我方 `filterEmptyAnthropicTextBlocks`（`src/lib/anthropic/sanitize/content-blocks.ts:13`）删掉 → 可能删出两个 thinking 相邻 → 违反上游 C1 → 布局矫正腿被迫插非空合成分隔符。**这条因果链是真的，只是当前由上游的空块触发、不由我方触发。**
- 需客户端配合：否。实现成本：**0（代码已在，改一个 config 值）**。
- 风险：确定性地放大 §1.2 那条已存在的污染链；且 coexist 形态曾实测 stall 真 CLI（`exp/block-level-anchor-sequential`），sequential 形态才 CLI-safe。
- **证伪方法**：真 CLI 跑一轮 >300s 静默，然后读 4141 History 看**下一轮**请求体里是否出现我方注入的空 text 块（用块内容/位置指纹区分于上游产物）。

### 4.2 现状 B：裸 `ping`（**当前生产默认**）

- 机制：`{event:"ping", data:{"type":"ping"}}` 每 20s。
- 两层超时：**字节层 ✅，300s 事件层 ❌**。源码级必然失败——SDK 在 `:10017` `continue` 掉，CC 连看都看不到。
- 被 baked：否（唯一优点）。需客户端配合：否。成本：0（现状）。
- 风险：**正在持续丢生产请求**（§2.3，4 个样本）。
- 证伪：已被 §2 的 4 阴性 + 1 阳性钉死，无需再测。

### 4.3 【Tier-1 核心】真实开块上的空 delta，不新开锚块

- 机制：仅当客户端 wire 上**已有一个真实块开着**时，按块类型发匹配的空 delta（`thinking→thinking_delta{""}` / `text→text_delta{""}` / `tool_use→input_json_delta{partial_json:""}`）。代码已存在：`src/lib/anthropic/keepalive-frame.ts:31` `makeAnthropicKeepaliveFrame(openBlock)`。
- 两层超时：**都能压住**。
- **被 baked：不会新增任何东西。** 关键论证：它不创建新块，只往一个**上游自己会闭合**的真实块上追加空字符串。CC 的累积是 `Zr.text += Kn.text` / `Zr.input += Kn.partial_json` / `Zr.thinking += Kn.thinking`（`:298270-298296`）——**追加空串是恒等操作**。最终物化的块与没有心跳时**逐字节相同**。
- 需客户端配合：否。实现成本：**极低**——`resolveAnthropicKeepalive()`（`keepalive-frame.ts:59`）当前对 `ping` 模式返回固定 `ANTHROPIC_PING`；只要在有开块时改走 provider 即可。这是把 D2 误伤的部分单独恢复，**不需要恢复锚块**。
- 风险：几乎为零。唯一注意点是 forwarded 侧的 `openBlock{index,type}` 必须准确（sink 已维护，`client-sink.ts` `currentOpenBlock()`）；index 错会触发 CC 的 `RangeError("Content block not found")`（`:298267`）。
- **覆盖**：§2.5 里 50% 的死亡样本（5500 的 `tool_use` 开块、5257 的 `text` 开块）**仅靠这一条就能全部救回**。
- 证伪：mock 上游开一个 `tool_use` 块后静默 340s，真 CLI 应完整收尾；再读 History 确认下一轮回流的 tool 输入 JSON 与直连基线逐字节相同。
- **静默期怎么办（原问题）**：此方案只覆盖"有开块"的静默。无开块的窗口由 Tier-2 覆盖，见 §4.5-§4.10。

### 4.4 SSE 注释行 / 裸 `event: ping`

- 机制：`: keepalive\n\n` 或 ping 帧。
- 两层超时：字节层 ✅，300s 层 ❌❌。注释行连 SSE 事件都不是；ping 被 SDK 吞。
- 已由 armA/armC/armP 实测 + 源码双重否定。**保留 ping 只作为字节层兜底**，不能当 300s 层的解。

### 4.5 推迟锚块到首个真实块出现（pre-content 窗口怎么撑）

- 机制：静默期不注入任何块，等上游第一个真实块到了再开始 §4.3 的空 delta。
- 两层超时：**pre-content 窗口完全裸奔**——正是 5463 / 5582 死掉的形态（上游 0 帧、320s 与 314.7s）。
- 结论：**单独用不成立**。但与 §4.9（推迟 commit）组合后成立：commit 前没有 300s 时钟，commit 后立刻就有真实块 → 窗口消失。**这是一条真正的出路，见 §5。**

### 4.6 流末尾"回收"锚块（Anthropic wire 有无此能力）

- **Anthropic wire 没有任何"删除/覆盖已发块"的事件类型**（无 `content_block_delete`、无 revision 语义）。`message_delta` 只能改 `stop_reason`/`usage`，不能改 content。所以"发一帧把它清空/覆盖"**在协议层不存在**。
- **但有一个协议外的等价效果，且被源码支持**：**永不闭合锚块**。物化只在 `content_block_stop` 发生（`:298301`），从未闭合的块**永远不进 `_r`、永远不进 transcript**。CC 在 watchdog/重试路径上会自行补一个 `content_block_stop`（`:298420` / `:298445` / `:298462`），但那是 `yield {type:"stream_event", ...}` 直接透出给外层，**不经过 switch、不触发物化**。
- 两层超时：✅（锚块开着，空 delta 照发）。**被 baked：不会**（CC 侧）。需客户端配合：否。
- 风险：**高且不对称**。① 对 CC 之外的客户端是**协议不完整流**（未闭合块 + `message_stop`），`@anthropic-ai/sdk` 的 `MessageStream` 累积器行为未验证；② 依赖 CC "不物化未闭合块"这一**实现细节**，CC 任一版本改动即静默失效；③ 我方 `closeAnchorIfOpen()`（`keepalive-anchor.ts:158`）的全部平衡性设计要反过来。
- 成本：中。证伪：真 CLI 跑一轮，读**下一轮**请求体确认锚块缺席；再用 `@anthropic-ai/sdk` 的 `MessageStream` 独立 oracle 喂同一段 wire 看是否抛错。
- 定位：**可行但脆**。作为"必须用块载体"时的优化项，不作为主推。

### 4.7 锚块内容改成非空但可辨识

- 机制：零宽字符 `​`、或 `<!-- keepalive -->` 之类 marker。
- 两层超时：✅。**被 baked：会，而且是可见污染**——会进最终文本、进 transcript、回流、且可能出现在用户复制的输出里。零宽字符还会污染 tool 参数、代码块、diff。
- 与 §4.3 相比**严格劣**：§4.3 用空串在真实块上达到同样效果且零污染。仅在"必须新开块 + 不能不闭合"时才轮得到它。
- 风险：`docs/todo` 里把它列为修复方向 1；我认为应**降级为最后手段**。
- 证伪：跑一轮后 grep 客户端最终输出与 transcript 里的 marker/零宽字符。

### 4.8 用 accept-set 事件名 + 未知 `data.type` 承载心跳（"协议缝隙"方案）

- 机制：例如
  ```
  event: message_delta
  data: {"type":"proxy_keepalive","source":"copilot-api"}
  ```
  SDK 看 `event:` 名在 accept-set → `yield JSON.parse(data)`；CC 看 `ar.type = "proxy_keepalive"` ≠ `"ping"` → **`he()` 重置**；随后 switch（`:298244`）**六个 case 全不匹配且无 default** → **零副作用**；最后 `nl = true; yield {type:"stream_event", event: ar}` 透出。
- 两层超时：✅✅。**被 baked：不会**（不经任何物化点）。需客户端配合：否。
- 成本：低（一个新帧构造器）。
- 风险：① 是**非标准 wire**，靠"CC 的 switch 没有 default"这个实现细节；② `stream_event` 通道的下游消费者（`:443378` 附近有对 `event.type` 的分支）未逐一核查；③ 对其它客户端/SDK：`@anthropic-ai/sdk` 的裸 `Stream` 会把未知对象吐给调用方，类型穷尽的消费者可能炸。
- 证伪：真 CLI 端到端 + `@anthropic-ai/sdk` `MessageStream` 独立 oracle；并 grep CC 里 `stream_event` 的全部消费点。

### 4.9 【结构性方案】把 commit 时机当作心跳杠杆

> **⚠ 2026-07-27 实测订正（本节两处前提被推翻，见 `exp/silence-recovery-gates/FINDINGS.md` §「Q1 续测」）**：
> - **「头到达前 CC 的预算是 `API_TIMEOUT_MS` 默认 600s」是错的。** 那个 600s 计时器存在但**永远轮不到它触发**——更低一层的 undici 默认 `headersTimeout` 在 **~300s** 就中止该 attempt（真 CC 四次落在 299.667–300.280s；裸 `fetch` 无 SDK 无 CC 抛 `UND_ERR_HEADERS_TIMEOUT`；裸 TCP socket 打同一 handler 420.1s 未被关，排除服务端）。**pre-commit 预算是 ~300s，不是 600s。**
> - **「总预算 = T + 300s，T=250 → 550s」是错的**，别再引用。commit 后那个 300s 是**可重置的 idle watchdog**（任何非-ping 事件即重置），不是从 commit 起只跑一次的总时限；而且我方 `streamKeepaliveEscalateSec`（默认 200s）本就在主动重置它。post-commit 能撑多久由 keepalive/escalation 契约决定，不存在这条加法。
> - **本节的核心论点仍然成立**（且不依赖上面两个数）：推迟 commit 能保住「上游报错时还能返回真 HTTP 状态码 → CC 全套原生自愈」这项能力，见本节末尾的「额外收益」。变的只是**可推迟的幅度有硬上界 ~300s**。

- 机制：**300s 时钟在响应头到达时才起跑**（§1.5，源码 `:298185` 的 `he()` 位置）。~~头到达前 CC 的预算是 `API_TIMEOUT_MS` **默认 600s**。~~ → 实测为 ~300s（undici `headersTimeout`），见上方订正。当前 `stream_commit_after_sec: 20` 在第 20 秒主动开跑时钟——**5463 死于 320.0s** 与此一致（20s commit + 300s post-commit idle）。
- ~~若把 commit 推迟到 T 秒（上游仍无内容时继续 hold header），总预算 = T + 300s。T=250 → 550s。~~ **作废，见上方订正。** 可安全断言的窄结论是：**单个 pre-header attempt 必须在 ~300s 前 commit，否则该 attempt 被 `headersTimeout` 中止**（撞上不致命，CC 会原生重试，代价是上游从头重算）。
- 两层超时：pre-commit 期间**§4.3 那两层都不存在**（无头、无流），但**受 undici `headersTimeout` ~300s 约束**（原文写「只受 600s 总预算约束」，已订正）。commit 后由 §4.3 接管。
- 被 baked：**完全不涉及**——一个字节都不发。
- 需客户端配合：否。
- **额外收益（长远正确性）**：pre-commit 期间上游若报错，我方还能返回**真 HTTP 4xx/5xx**，从而保住 CC 的全部原生自愈（thinking-strip / cache-beta drop / role:system 回退 / 429 退避重试）。一旦 commit 成 200，任何错误只能降级成 `200 + SSE error`，`.status === undefined`、**CC 零重试**（skill 已记载，`:10018` + `error.js` 路径）。**早 commit 是在拿自愈能力换心跳，而这个交换现在看是亏的。**
- 风险：① 客户端在 hold 期间完全没有反馈（用户看到"卡住"）；② 我方 `timeouts.response_header`（当前 600）与之耦合；③ 与既有 `docs/spec/2026-07-23-upstream-silence-commit-timing.md` 正在做的事直接重叠——**必须与那条主线合并设计，不能各修各的**。
- 成本：中（config + 与 silence-commit spec 协调）。
- 证伪：mock 上游静默 400s 后吐内容，`stream_commit_after_sec` 设 250，真 CLI 应完整收尾。**注意（2026-07-27 订正）**：原文写的「总 >550s 预算内」预设了已作废的 `250+300` 加法——能不能活到 400s **取决于 post-commit 的 keepalive/escalation 是否持续重置 idle watchdog**，这正是该 oracle 要独立验证的对象，不能拿它当前提。

### 4.10 `message_delta` 作为心跳载体

- 机制：`event: message_delta` + `data: {"type":"message_delta","delta":{},"usage":{"output_tokens":0}}`。
- 两层超时：✅✅（标准 accept-set 事件，`type` ≠ ping → `he()`）。
- **被 baked：不会创建内容块**（message_delta 不经物化点）。
- **但有两处真实副作用**（源码 `:298313-298348`）：
  1. **成本重复累加**：`Te += Ghe(Sie(u, pn), pn, ...)`，`pn` 是**累计** usage（`message_start` 已把 `input_tokens` 灌进去）。每发一次心跳，CC 就按完整 input 成本再加一次。10 次心跳 → 会话成本显示膨胀约 10×，且进 OTel 指标（`wFt()?.add(...)`）。
  2. **`stop_reason` 抖动**：`ve = ar.delta.stop_reason`（`delta:{}` → `undefined`），并回写所有已物化消息 `Pu.message.stop_reason = ve`。真 `message_delta` 到达后会覆盖回正确值，但流中途异常终止时会留下 `undefined`。
- 需客户端配合：否。成本：低。
- 定位：**"不进历史"这个目标它达成得很干净，但用错误的成本数据买单**。§4.8 没有这个副作用，§4.9 连帧都不发。**故不推荐**，但作为 Tier-2 的候选保留（若 §4.8 的非标准性被否决）。
- 证伪：真 CLI 跑一轮，看 `/cost` 或 session 成本是否膨胀 ≈ 心跳次数倍。

### 4.11 HTTP/传输层心跳（TCP keepalive / h2 PING / SSE 空行）

- 机制：TCP keepalive、HTTP/2 PING frame、或 SSE 层空行。
- 两层超时：**只解字节层，绝对解不了 300s 事件层。** 论证：CC 的 300s watchdog 挂在**已解析的 SSE 事件流**上（`for await (let ar of v1y(Ae, vo))`），h2 PING 和 TCP 探测根本不产生 SSE 事件，连 SDK 的解码器都进不去。**问题陈述里的这个判断是对的，源码级确认。**
- 用途：仅作字节层保险，且经代理路径上字节层 watchdog 本就没安装（§1.4）。
- 定位：**不是候选**，只是背景。

### 4.12 客户端侧配置（要客户端配合的路）

CC 提供了两个官方旋钮，源码可查：
- `CLAUDE_STREAM_IDLE_TIMEOUT_MS`：`x0i()` = `Math.max(env, 3e5)` → **只能调高**。设 900000 → 900s 死线。
- `CLAUDE_ENABLE_STREAM_WATCHDOG=0`：`Aa` 为 false → `he()` 直接 return（`:298086`）→ **watchdog 完全关闭**。
- 两层超时：✅（直接把墙推远/拆掉）。被 baked：无关。成本：0。
- 风险：**需要客户端配合**——只对本机自用的 CC 生效，对任何其它下游客户端无效；且把"代理应当自洽"的责任推给使用方。
- 定位：**不作为方案，作为"应急/诊断开关"记录**。但它有一个不可替代的用途：**做 A/B 判别**——同一场景开/关 watchdog 跑两遍，可以零歧义地确认某次断流是不是 300s 墙。

### 4.13 非 Anthropic 腿的适用性

问题陈述要求说明。逐条：
- §4.3 / §4.1 / §4.6 / §4.7 / §4.10：**Anthropic wire 专属**（`content_block_*` / `message_delta` 是 Anthropic 语义）。
- §4.8：思路通用，但具体帧形状按腿各写一份。
- §4.9（commit 时机）、§4.11、§4.12：**腿无关**，天然通用。
- OpenAI/Responses/Gemini 腿各自的客户端有各自的 idle 判据（Codex/`@ai-sdk` 等），**不能假定与 CC 同构**。`src/routes/responses/handler-v4.ts:330` 与 `ws.ts:359` 的注释已明确它们只复用 keepalive **间隔**、不复用 `streamKeepaliveMode` 枚举。
- **建议**：Tier-1/Tier-2 先在 Anthropic 腿落地并定型，再按同一评估轴（"什么帧能重置该客户端的死线"）为每条腿单独取证——**绝不跨腿外推**（skill `empirical-verification` 的既有教训：60s→300s 跨层外推就错过一次）。

### 4.14 【本轮新增】延迟 `content_block_stop`：把"块间空档"变成"块内空档"

- 机制：不再一收到上游 `content_block_stop` 就立刻转发，而是**用一帧 lookahead 把它扣在手里**，等上游下一帧到达时再连同转发。于是任何上游静默都**必然发生在一个仍然开着的块内部**，§4.3 的空 delta 就永远有载体。
- 两层超时：✅✅（与 §4.3 同）。**被 baked：零新增**——内容逐字节不变，只是块的闭合时刻晚了"一帧的到达时间"。
- 需客户端配合：否。
- 关键论证：CC 在 `content_block_stop` 才物化（`:298301`）。推迟 stop 只是推迟物化时刻，**物化出的对象完全相同**。
- 代价：`content_block_stop` 的递送延迟 = 下一帧的到达间隔（正常流里是毫秒级）。若流在空档中途死亡，该块不会被物化——但那种情况下按现状流本来也会被 300s 墙杀掉，**净变化是正的**。
- 风险：与"严格按 index 顺序输出"约束需一起验证；终局（`message_delta`/`message_stop` 前）的 stop 必须无条件 flush。
- 成本：低-中。
- 证伪：mock 上游发 `[block0 完整] → 静默 340s → [block1]`，真 CLI 应完整收尾且**两个块内容都保全**；再与直连基线做逐字节 diff。
- **意义：这一条把方案面从"要不要注入合成物"整个搬离——它让空档永远有真实载体，于是根本不需要锚块、不需要非标准帧、不需要 marker。**

---

## 5. 推荐方案

### 5.1 推荐架构：三条正交措施，覆盖三个窗口，**零合成内容**

先把静默窗口按"客户端 wire 上此刻有什么"切成互斥三类——这是整个设计的骨架：

| 窗口 | 客户端状态 | 覆盖措施 |
|---|---|---|
| **W1 pre-commit** | 响应头还没发 | **R3**：推迟 commit（CC 的 idle watchdog 根本没起跑；**但受 undici `headersTimeout` ~300s 硬约束**，2026-07-27 实测订正，原写 ~600s） |
| **W2 块内静默** | 有一个真实块开着 | **R1**：该块类型对应的空 delta |
| **W3 块间空档** | 已 commit，无块开着 | **R2**：一帧 lookahead 延迟 `content_block_stop` → W3 塌缩进 W2 |

三条措施合起来**穷尽覆盖**，且**一个合成内容块都不注入**。

- **R1（= §4.3）**：真实开块上发块类型匹配的空 delta。代码已存在（`makeAnthropicKeepaliveFrame`），只需让 `ping` 模式在有开块时也走 provider。
- **R2（= §4.14）**：`content_block_stop` 一帧 lookahead。
- **R3（= §4.9）**：commit 触发条件从"定时 20s"改为"**首个真实 `content_block_start` 到达，或 T 秒兜底（T 取 200-250）**"。同时把上游错误在 W1 内保持为**真 HTTP 状态码**。

### 5.2 为什么不是别的路（逐条否定）

| 方案 | 否定理由 |
|---|---|
| §4.2 裸 ping（现状） | 源码级不可能重置 300s；4 个生产样本正在死。**不是"现状能用"，是现状在流血。** |
| §4.1 空 text 锚块 | 能保活，但**必然被 baked**（CC 源码证明），且叠加放大 §1.2 那条已存在的"删空块→thinking 相邻"污染链。R1+R2 用零污染手段达成同一效果。 |
| §4.7 非空 marker 锚块 | 严格劣于 §4.1：既 baked 又**可见**。仅当 R1/R2/R3 全不可用时的最后手段。 |
| §4.6 永不闭合锚块 | 确实不进历史，但依赖 CC "不物化未闭合块"这个**实现细节**，且对非-CC 客户端是协议不完整流。R2 用协议内手段拿到同样的"块一直开着"。 |
| §4.8 协议缝隙帧 | 干净且不 baked，但**非标准 wire**，依赖 CC switch 无 default。R1+R2+R3 覆盖后不需要它。**保留为 W3 的兜底**（若 R2 因某种约束不能落地）。 |
| §4.10 `message_delta` 心跳 | 不 baked，但**每发一次就把整轮 input 成本再加一次**（`Te += Ghe(Sie(u,pn), pn, ...)`），污染 CC 的成本显示与 OTel 指标。用错误的计费数据买保活，不划算。 |
| §4.11 TCP/h2 PING | 源码级只能解字节层，解不了事件层。**问题陈述里的判断正确。** |
| §4.12 客户端环境变量 | 需客户端配合，只对本机自用 CC 有效，把自洽责任推给使用方。**保留为诊断 A/B 开关**，不作方案。 |
| §4.5 单纯推迟锚块 | pre-content 窗口裸奔，正是 5463/5582 的死法。但与 R3 组合后成立——已并入 R3。 |

### 5.3 迁移路径（按依赖排序，每步可独立验收）

1. **P0 — 止血，且只做这一件事**：恢复 R1。改 `resolveAnthropicKeepalive()`：`ping` 模式下**有开块时**返回 `makeAnthropicKeepaliveFrame`，无开块时才退回 `ANTHROPIC_PING`。
   - 触及面极小，`empty_text` 锚块保持休眠（**不复活 D2 退役的东西**）。
   - 立即救回 §2.5 里 50% 的死亡形态（5500/5257 型）。
   - 验收：mock 上游开 `tool_use` 块后静默 340s，真 CLI 完整收尾。
2. **P0.5 — 关闭 D2 的遗留不确定性**：跑 §3.4 的 `curl -N` 探针定位 G2 的丢帧层。若确认代理丢帧，那本身是一个独立缺陷，需单独修。
3. **P1 — R2（stop lookahead）**：把 W3 塌缩进 W2。
   - 验收：`[block0] → 静默 340s → [block1]`，两块内容全保。
4. **P2 — R3（commit 时机）**：**必须与 `docs/spec/2026-07-23-upstream-silence-commit-timing.md` 合并设计**，不能另起炉灶。附带收益是恢复 CC 的原生自愈（HTTP-4xx 路径）。
5. **P3 — 文档纠偏**（不做代码改动也应做）：
   - ADR `2026-07-22-continuation-retry-sequential-anchor` D2：补一条修订记录，说明第 ② 条判据（G2 实证）已被源码 + 6 个对照臂推翻，结论保留但理由改写。
   - skill `debugging-claude-client-connection`：把"只有真实 `content_block_delta` 能重置"改成 §1.3 的精确判据；给"60s byte-idle"标注 §1.4 的存疑。
   - `docs/todo/2026-07-22-client-proxy-keepalive-300s.md`：把"掐断源可能是代理 stall 检测"这条假设**明确排除**（字面量在 CC `:298433`）。

### 5.4 我的偏好与交回的分叉

**我的推荐**：P0 立即做（无取舍、无分叉、有生产损伤在流血）；P1/P2 按序做。

**交回主会话/用户裁决的真分叉**（我不自行拍板）：

- **F1：R3 的 commit 语义变更**。把 commit 从"20s 定时"改成"首块驱动 + 大 T 兜底"，会改变**用户可感知的行为**（长静默时客户端更久没有任何反馈，而不是收到 200 后干等）。这是产品手感取舍，且与 silence-commit spec 的既有裁决可能冲突。选项：(a) 维持 20s，只靠 R1+R2；(b) T=200-250 兜底；(c) 完全首块驱动。
- **F2：W3 兜底手段**。若 R2 因"严格 index 顺序输出"或续写/缓冲交互而不可行，退路是 §4.8（非标准帧，干净但赌 CC 实现细节）还是 §4.10（标准帧，但污染成本统计）。这是"标准合规 vs 数据正确"的价值取舍。
- **F3：D2 的处置**。是仅修订理由、还是把 `empty_text` 锚块**彻底删除**（既然 R1+R2+R3 之后它永无用武之地）。按项目"无向后兼容负担 + 不留双轨包袱"的哲学，我倾向彻底删除休眠代码；但它当前被当作"research 入口"保留，属于用户此前的决定。

---

## 6. 结论的证据分级（务必按此对待）

| 结论 | 级别 | 依据 |
|---|---|---|
| 现网 keepalive = 裸 ping，锚块未激活 | **实测** | `config.yaml:765` + `state-defaults.ts:76` + 生产 History 全部 keepalive 帧为 `type:"ping"` |
| 不存在 completed 且 >300s 的请求 | **实测** | 405 条唯一 entry，>240s 的 7 条逐条列出，唯一 completed = 292.7s |
| 300s 死线由"任何非-ping SSE 事件"重置，ping 被 SDK 丢弃 | **源码读证** | `app.pretty.js:298199-298206`、`:10013-10017`、`:88228` |
| 4 条死亡样本 = CC 300s 墙，差值 300.0s | **实测（推断链闭合）** | History offsetMs + durationMs 逐毫秒吻合；`Response stalled mid-stream` 字面量定位在 CC `:298433` |
| 闭合过的空 text 块必进 CC transcript | **源码读证** | 物化点唯一 `:298301`；`eJr` `case "text"` `:368803` 不过滤 |
| CC 的 idle watchdog 在响应头到达后才起跑 | **源码读证** | `he()` 调用位置 `:298185` |
| ~~头前预算 ~600s~~ → **头前预算 ~300s**（undici 默认 `headersTimeout`，非 `API_TIMEOUT_MS`） | **实测**（2026-07-27，非源码读证——原表把错误结论标成了最高可信档） | `exp/silence-recovery-gates/FINDINGS.md` §「Q1 续测」；客户端 cause `UND_ERR_HEADERS_TIMEOUT` 见 `results/q1-firstfail/barefetch.client.json` |
| 经代理路径不安装字节级 watchdog；2.1.207 无 60s 常数 | **源码读证，与既有文档冲突** | `:88334` `Kgc` 门控、`:88231` `k0i` 常数 |
| G2「空 text_delta 无效」是假阴性 | **推断（证据权重）** | 1 份源码 + 6 个对照臂 vs 1 个带混淆变量的反例。**需 §3.4 的 curl 探针实测确证** |
| R1/R2/R3 各自有效 | **待真实客户端 e2e** | 需 skill `client-proxy-e2e-testing` 搭真 SDK/CLI；本轮**未跑**，按指示只建议 |
| §4.8 协议缝隙帧对 CC 无副作用 | **仅源码推断** | switch 无 default；但 `stream_event` 下游消费面未逐点核查，**不可据此动手** |
| §4.6 未闭合块不进历史 | **仅源码推断** | 物化点唯一；但需 `MessageStream` 独立 oracle 验其它客户端 |

**本轮全程未改动任何生产代码，未触碰 4141 主服务器（只用 `GET /history/api/*` 只读探针），未启动任何测试服务器。**
