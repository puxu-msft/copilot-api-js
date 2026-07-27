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

- [x] **Step 1：构造小 `max_tokens` 撞预算的请求**，promt 要求生成足够长的纯文本答案，`max_tokens` 设一个明显会截断的小值（如 64）。
- [x] **Step 2：跑，确认干净终止形状** —— 记录 wire：`message_delta{stop_reason:max_tokens}` + `message_stop` 到达，无 RST/error。
- [x] **Step 3：构造续写请求**（`[原始 messages] + [assistant=已提交 text] + [user=续写消息]`），确认上游接受并从截断处自然续写（非重复、非发散）。
- [x] **Step 4：FINDINGS 记录** —— **PASS（2026-07-27）**：真实 `claude-haiku-4.5` 首轮 `max_tokens=64` 干净终止于整数 32（`output_tokens=64`），text-only assistant 前缀续写从 33 连续到 64，无重复、无跳号。证据与复现命令见 `exp/continuation-shape/FINDINGS.md`。

---

## Gate B：悬挂 tool_use 丢弃后续写——发散风险（高风险，早跑）

**Why：** spec §3.2/§12 门 B —— B 类默认透传的真正 hazard 不是「tool_use 前缀是否被接受」（姊妹 G3 已证 PASS），而是丢弃 partial tool_use 后模型是否**发散**（重建不同工具/不同 input，而非接续原意图）。

> **修订记录（2026-07-23，据 GPT plan-review [minor] 修订）**：原方案用「跑 3 次 + `<20%` 阈值示例」不足以支撑一个模型行为分型的稳定默认/opt-in 决策——3 次样本甚至无法观测到 20% 这一分辨率，且「语义等价」缺少可重复裁决规则。本门须先冻结方法论，再产出观测分布，而非临时采用阈值。

- [ ] **Step 0：冻结方法论（先于任何采样跑之前）**：
  - **固定 prompts 集**：至少 3 种不同工具场景（单参数简单工具 / 多参数复杂工具 / 嵌套 JSON 结构参数），每种场景固定 prompt 文本（不临场改写）。
  - **固定工具 schema**：每个 prompt 绑定一个具体的 `tools` 定义，跨样本不变。
  - **固定采样参数**：`temperature`/`top_p` 等如可控则固定为确定性附近的值（若模型侧不支持完全确定性，至少固定这些参数本身，让唯一的变量是模型的采样噪声）。
  - **样本量**：每个 prompt 场景至少 **20 次独立采样**（非 3 次）——20 次才能在 `<20%` 分辨率上有意义地观测比例（哪怕只是「大致定性」而非精确统计推断）。
  - **等价 oracle（可重复裁决规则，非人工目测）**：定义「语义等价」= (a) 续写响应调用的工具名与原始被截断的工具名**完全相同**（非模糊匹配）；(b) 续写响应的工具 input 的**顶层键集合**与原始被截断前缀能推断出的意图键集合有重叠（如原始 input 有 `path`/`content` 两个键的迹象，续写响应也含这两个键，即便值不同）；不满足 (a) 直接判「发散」，满足 (a) 不满足 (b) 判「部分发散」，两者都满足判「等价」。
  - **记录格式**：每次采样记录 `{prompt_id, sample_index, original_tool_name, original_input_partial, continued_tool_name, continued_input, verdict: "equivalent"|"partial-divergence"|"divergence"}`，汇总为分布表（非单一比例数字）。
- [ ] **Step 1：构造撞预算于 tool_use input 中途的请求**（按 Step 0 冻结的固定 prompts + schema，prompt 引导模型调用一个有较长 input 的工具，`max_tokens` 卡在 `input_json_delta` 中途）。
- [ ] **Step 2：验证悬挂标准**（最后块 = tool_use 且无 `content_block_stop`）——记录截断时刻的块状态。
- [ ] **Step 3：丢弃该 partial tool_use，构造续写请求**（前缀退化为其前的已闭合块，多为 text），发送「continue」续写轮，按 Step 0 样本量跑满。
- [ ] **Step 4：按 Step 0 的等价 oracle 逐样本裁决**，汇总分布表（非单一发散率数字）。
- [ ] **Step 5：FINDINGS 记录观测分布 + 明确的不确定性**（例如「20 样本中 X 个 equivalent、Y 个 partial-divergence、Z 个 divergence，置信区间因样本量小而宽」）。**是否允许 B 类 opt-in 的阈值裁决权在用户，不在 planner**——若要开放 opt-in，须把观测分布交给用户在 ADR 中冻结一个用户接受的阈值，而非本门临时定一个 `<20%`。门本身只负责产出可信的观测数据；FAIL（高发散、或用户看到分布后拒绝 opt-in）→ B 类永久透传，登记 backlog，不阻塞 A 类落地。

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

> **修订记录（2026-07-23，据 GPT plan-review [major] 修订，spec §4 已同步纠正）**：原 Step 4 把 `marker` 描述为「不抑制信号本身，只追加标记」——**这与 P2 Task 2.3 的实现描述矛盾，且与协议事实不符**：一旦首轮 `message_stop`/`[DONE]`/`response.incomplete` 转出，流已合法终止，无法在同一流续写。已冻结统一契约：**`marker` 与 `transparent` 一样抑制被替代的首轮 terminator，区别仅为在续写前注入一个可辨识且格式合法的 marker**（marker 不是"不抑制"的宽松版，而是"抑制+多一步注记"的严格版）。本门 Step 4 据此修订，并要求以此真实 producer wire 作为 SDK oracle（非手工构造帧）。

- [x] **Step 1：构造缝合流** —— mock 上游两次 exchange：首次干净终止于 `max_tokens`（`message_delta{stop_reason:max_tokens}` + `message_stop` 已产出但**不转发**给客户端）+ 续写 exchange 产出剩余内容 + 自己的 `message_delta{stop_reason:end_turn}` + `message_stop`。
- [x] **Step 2：真 SDK 消费** —— `@anthropic-ai/sdk` 的 `.finalMessage()` 断言：单一 `message_start`、块 index 连续、**最终 `stop_reason` = `end_turn`**（非 `max_tokens`）、无重复内容、无 throw。
- [x] **Step 3：usage 单调性验证** —— 客户端可见流的 `message_delta.usage.output_tokens` 累积语义须单调递增；最终值 = 两轮真实 usage 总和（可能 `> max_tokens`）；断言 SDK 不因 `output_tokens > max_tokens` 抛错或行为异常。
- [x] **Step 4：`marker` 策略变体（已按统一契约修正）** —— 同样**抑制首轮真实终止符**（与 Step 1 一致，不转发 `message_delta{max_tokens}`/`message_stop`），但在续写内容前/后额外注入一段可辨识的 marker 文本（作为一个新的 text delta，格式合法、非协议扩展字段）；用真实 producer（driver 实际产出的缝合流，非手工拼帧）驱动 SDK，验证 SDK 同样接受、`.finalMessage()` 含 marker 文本片段、`stop_reason` 仍是自然终止（`end_turn`）而非 `max_tokens`。
- [x] **Step 5：FINDINGS 记录** —— **PASS（2026-07-27）**：`@anthropic-ai/sdk@0.106.0` 接受 transparent 与 marker；请求 `max_tokens=64` 时最终 usage 分别为 88/89，均 `stop_reason=end_turn`。真实 `claude` CLI 2.1.220 亦 `num_turns=1`、无 stall。违规 index 冲突与双 terminator 正样本均被 producer oracle 拒绝。证据见 `exp/continuation-shape/FINDINGS.md`。

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
