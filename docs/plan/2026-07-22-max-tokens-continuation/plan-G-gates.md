# Plan-G: PoC 门簇（gate-first，先跑定可行性）

> 门先于承重实现。裁决 = 实测 > 文档 > 声称（skill `empirical-verification`）。用 `exp/continuation-shape/`（姊妹 spec 已用此目录，本特性追加文件，不新建目录）+ mock 上游 + 真客户端 SDK oracle。真实 GHC 计费探针用 cheap 模型 + 小 `max_tokens`，走用户 4141 代理（只读 POST，不 spawn、不 kill 4141——protect-user-main-server）。

**Files（门产出物，keep-poc-in-project，force-add 到 git）：**
- Create: `exp/continuation-shape/max-tokens-transparent-stitch.ts`（门 D）
- Create: `exp/continuation-shape/max-tokens-text-prefix.ts`（门 A，继承姊妹 G3 场景）
- Create: `exp/continuation-shape/max-tokens-tooluse-discard-continue.ts`（门 B）
- Create: `exp/continuation-shape/max-tokens-thinking-retry-budget.ts`（门 C）
- Create: `exp/continuation-shape/max-tokens-cc-responses-boundary.ts`（门 E）
- Modify: `exp/continuation-shape/FINDINGS.md`（追加本特性门结果，不覆盖姊妹已有记录）

---

## Gate A：text-only 前缀续写在 max_tokens 场景下成立（低风险，继承姊妹门 A）

**Why：** spec §12 门 A —— 姊妹 spec 的 text-only 前缀续写已双模型实证 PASS（`exp/continuation-shape/FINDINGS.md` G3）。本门只需补一发「真实 max_tokens 截断」场景的端到端验证（截断原因不同——姊妹是 mid-stream CANCEL，本特性是预算耗尽干净终止，wire 形状不同：有 `message_delta{stop_reason:max_tokens}` + `message_stop` 正常到达，而非 RST）。

- [ ] **Step 1：构造小 `max_tokens` 撞预算的请求**，promt 要求生成足够长的纯文本答案，`max_tokens` 设一个明显会截断的小值（如 64）。
- [ ] **Step 2：跑，确认干净终止形状** —— 记录 wire：`message_delta{stop_reason:max_tokens}` + `message_stop` 到达，无 RST/error。
- [ ] **Step 3：构造续写请求**（`[原始 messages] + [assistant=已提交 text] + [user=续写消息]`），确认上游接受并从截断处自然续写（非重复、非发散）。
- [ ] **Step 4：FINDINGS 记录** —— PASS/FAIL + 样本。FAIL → A 类续写整体回退透传（罕见，姊妹机制已验证同构场景 PASS，预期本门 PASS）。

---

## Gate B：悬挂 tool_use 丢弃后续写——发散风险（高风险，早跑）

**Why：** spec §3.2/§12 门 B —— B 类默认透传的真正 hazard 不是「tool_use 前缀是否被接受」（姊妹 G3 已证 PASS），而是丢弃 partial tool_use 后模型是否**发散**（重建不同工具/不同 input，而非接续原意图）。

- [ ] **Step 1：构造撞预算于 tool_use input 中途的请求**（prompt 引导模型调用一个有较长 input 的工具，`max_tokens` 卡在 `input_json_delta` 中途）。
- [ ] **Step 2：验证悬挂标准**（最后块 = tool_use 且无 `content_block_stop`）——记录截断时刻的块状态。
- [ ] **Step 3：丢弃该 partial tool_use，构造续写请求**（前缀退化为其前的已闭合块，多为 text），发送「continue」续写轮。
- [ ] **Step 4：断言语义等价性** —— 续写响应是否调用**同一个工具**、input **语义等价**（非逐字节相同，判断走同一意图路径 vs 完全换了工具或参数）。跑 ≥3 次同 prompt 观察发散率（模型采样有随机性，单次 PASS 不足以下结论）。
- [ ] **Step 5：FINDINGS 记录** —— PASS（发散率可接受，如 <20%）→ 评估纳入 P2b opt-in；FAIL（高发散）→ B 类永久透传，登记 backlog，不阻塞 A 类落地。

---

## Gate C：C 类 thinking retry-with-budget（高风险，早跑，历史雷区）

**Why：** spec §3.3/§12 门 C —— thinking round-trip 签名安全是本项目历史雷区（多个 400 incident，参考 skill `ghc-anthropic-upstream`）。本门验证两件事：(a) 抬高 `max_tokens` 重发是否真能让模型在思考后产出可见答案（而非再次烧满 thinking）；(b) 重发（非续写）路径不涉及 thinking 块回喂，是否规避签名风险。

- [ ] **Step 1：构造撞预算于 thinking、0 可见答案的请求**（复现 spec §1.1 实证画像 C 类场景——高 thinking 预算、低总 `max_tokens`）。
- [ ] **Step 2：验证判据**——最后块 == thinking（唯一判据，不用 token 占比）。
- [ ] **Step 3：重发**（非续写）——同一原始请求，把 `max_tokens` 抬到模型 cap（或 `thinking_retry_budget` 配置值），观察是否产出可见答案。
- [ ] **Step 4：验证无 thinking 回喂**——重发请求体不含任何前一次响应的 thinking 块（纯粹是原始请求 + 抬高的 max_tokens），确认无 400 / 签名相关错误。
- [ ] **Step 5：FINDINGS 记录** —— PASS（抬预算后产出可见答案 + 无签名错误）→ P2c 落地 `retry_with_budget`；FAIL → C 类仅 `passthrough`，登记 backlog（分型 telemetry 仍先行落地，§9 独立观测价值不受此门影响）。

---

## Gate D：transparent 缝合被客户端 SDK 接受（承重，P1 依赖）

**Why：** spec §5.3/§12 门 D —— `visibility:transparent` 缝合的 wire 层关键是「首轮成功终止符被抑制，续写轮以自己的真实终止符收尾」。姊妹的 `exp/continuation-stitch/FINDINGS.md`（P-A 门）已验证「跨 exchange 缝合流被 SDK 接受」的**同构场景**（cut-path），但姊妹场景的首轮**没有**发出终止符（是被 RST 打断的），本特性场景首轮**已发出**完整 `message_delta{stop_reason:max_tokens}` + `message_stop`——抑制的是一个**本该合法结束**的终止符，这是本特性独有的新变量，姊妹门不能直接复用其 PASS 结论。

- [ ] **Step 1：构造缝合流** —— mock 上游两次 exchange：首次干净终止于 `max_tokens`（`message_delta{stop_reason:max_tokens}` + `message_stop` 已产出但**不转发**给客户端）+ 续写 exchange 产出剩余内容 + 自己的 `message_delta{stop_reason:end_turn}` + `message_stop`。
- [ ] **Step 2：真 SDK 消费** —— `@anthropic-ai/sdk` 的 `.finalMessage()` 断言：单一 `message_start`、块 index 连续、**最终 `stop_reason` = `end_turn`**（非 `max_tokens`）、无重复内容、无 throw。
- [ ] **Step 3：usage 单调性验证** —— 客户端可见流的 `message_delta.usage.output_tokens` 累积语义须单调递增；最终值 = 两轮真实 usage 总和（可能 `> max_tokens`）；断言 SDK 不因 `output_tokens > max_tokens` 抛错或行为异常。
- [ ] **Step 4：`marker` 策略变体** —— 同缝合流但注入可辨识 marker（不抑制信号本身，只追加标记文本/元数据），验证 SDK 同样接受。
- [ ] **Step 5：FINDINGS 记录** —— PASS/FAIL。FAIL（SDK 拒绝抑制真实终止符后的缝合，或 usage 处理异常）→ **P1 承重回退**：`transparent` 策略需调整形状（如改为总是 `marker`），须与用户重议 Q1 裁决的默认档（spec 已裁决 transparent 默认，若门 FAIL 需回报用户此裁决基础被证伪，非 planner 自行改）。

---

## Gate E：CC / Responses 悬挂判据可靠性（决定 P3 覆盖）

**Why：** spec §7 —— CC/Responses 无 Anthropic 的 `content_block_start/stop` 悬挂概念，B 类「悬挂 tool_use」判定须靠各格式累积器状态（CC `stream-accumulator.ts` `toolCallMap`；Responses `output_item.done` 缺失）。

- [ ] **Step 1：CC 悬挂探针** —— 构造 CC `finish_reason=length` 撞预算于 tool_call arguments 中途的流，检查 `toolCallMap` 状态能否可靠判「该 tool_call 未终结」（对照姊妹已有 G4 CC 串行性 PASS 结论，本门只加 max_tokens 截断视角）。
- [ ] **Step 2：Responses 悬挂探针** —— 构造 Responses `status=incomplete + max_output_tokens` 撞预算于 function_call arguments 中途的流，检查缺失 `output_item.done` 能否作为可靠悬挂判据。
- [ ] **Step 3：FINDINGS 记录** —— PASS/FAIL 分格式。FAIL → 对应格式的 B 类判定退化为「只判 A/C，B 类一律走该格式的 terminal-only 透传（不细分悬挂/已闭合）」，登记 backlog，不阻塞该格式的 A 类续写落地。

---

## 门簇收口

- [ ] **汇总：** `exp/continuation-shape/FINDINGS.md` 追加本特性 5 门 verdict 表（PASS/FAIL + 样本 + 对 P1/P2/P3 的分支决策），与姊妹已有 G3/G4/G5 记录并存、不覆盖。
- [ ] **提交：** `git add -f -- exp/continuation-shape/max-tokens-*.ts exp/continuation-shape/FINDINGS.md` + `git commit -F <msgfile> -- <精确路径>`。
- [ ] **门 → 相位映射回填 README DAG**（哪些门 FAIL 触发哪条 fallback，写进对应 plan-N 头部）。
