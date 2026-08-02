# 网络韧性重试加固 v2 · 第 3 轮复评（Claude reviewer，仅 blocker/major）

- 评审对象：`docs/tmp/2026-08-02-network-resilience-retry-hardening.md`（v2），只覆盖调用方点名的 5 问 + 返工自生问题；上轮已闭合项不重复。
- 总体 verdict：**修复 major 后可进入下一阶段**（补完下列 6 条即可定稿，不需要第 4 轮全量对抗审）。
- blocker 数：**0**。major 数：6。
- 判据轴：长远正确 + 完整；block-level 为公理；用户三项裁决（B1 排序 / M1 拉 P7-T3 / M8 max_tokens）不重议。

## 双视角覆盖证据

**机械核对**：读 v2 全文 271 行；对照源码核实新断言 —— `classifyStreamError` 9 值域（`packages/foundation/src/stream.ts:164-174`）、idle-timeout 抛出点（`stream.ts:269` `raceIteratorNext`）、driver 终局/重试两分支（`driver.ts:1396` / `:1430` / `:1480`）、反应式重试触发位置（`dispatch-scheduler.ts:288`）、硬掐定时器体（`context/manager.ts:410-424`）与 reaper 判据（`manager.ts:306`）、hedge 合格性与预算默认（`hedge-policy.ts:118-130`、`state-defaults.ts:190-195`）、max_tokens 观测层与遥测维度（`routes/messages/handler-v4.ts:1564-1577`、`telemetry-dimensions.ts:154`）、`network-retry.ts` 全文。

**第一人称执行**：以实现者身份走了 4 条路径 —— ①上游发完 `message_stop` 但连接不关 → idle-timeout → 走 §4.1 新表；②预算耗尽 → §4.5 合成 max_tokens → 沿 acc / observer / telemetry 一路走到 History；③硬掐定时器到点 → `cancel`+`fail` → handler 想合成第四态；④只交付 §4.0 例外（B2）后，一次 9 深网络重试链在 1200s 硬掐下的挂钟走向。四条各撞出下面一条 major。

## 事实性发现

### [major] §4.1 idle-timeout 三格缺「已见终止符」前置条件 —— 引入新的误救

- `driver.ts:1396` 的终局提交要求 `drained`；上游已发 `message_stop` / 上游 `error` 帧但未关流（H2 未 END_STREAM、WS 连接天然长活）时 `drained=false`、`thrown=idle-timeout`，直落 `:1430` 失败分支。
- v2 把 idle-timeout 三格**无条件**改为可救 → 「已提交 + 已见终止符」会开续写腿，在一条**已完整**的 assistant 轮之后再追加一轮。今天该场景只是多发一个 error 帧，改后升级成**静默内容重复**（更难察觉）。
- 修复：维度一加前置谓词 —— 仅当 `!sawMessageStop() && !sawUpstreamError() && !sawContentlessRefusal()` 时 idle-timeout 才可救；「上游 error 帧后静默」永不重试（那是上游终局决定，重试 9 次是刷终局拒绝）。
- 取证：§4.1 已要求 idle-timeout / transport-close 两臂各写 mutation，请加第三臂「idle-timeout ∧ 已见终止符 → 不救」。

### [major] §4.5 合成 `max_tokens` 对**内部** max-tokens 观测层不可辨识（违 A4）

- `handler-v4.ts:1564` 的 `isAnthropicMaxTokensTerminal(acc.stopReason)` 按累加器的 stop_reason 判，产出 `recordMaxTokensTruncation(...)`；`telemetry-dimensions.ts:154` 的 `max_tokens_truncation` 维度直接由它派生。
- 预算耗尽合成的 `max_tokens` 一旦进 acc / wire，就被记成「上游 max_tokens 截断」：污染 max_tokens 续传特性（P0 已 landed 的观测层）的判据；P1 自动续传落地后，还会对**我们自己合成的**终止符发起续写 → 网络已死时的续写循环。
- 用户裁决的是 wire 形状（不重议）。spec 需补的是内部纪律：识别只走 driver outcome kind（与 §4.3 第 1 条同构），观测层 / 未来续传层显式排除 `budget-exhausted-truncation`，并加守卫测试。

### [major] §4.1 的 `request-deadline` × 已提交 → 第四态，与现行硬掐机制不相容

- `manager.ts:410-424`：硬掐定时器在**同一 tick** 内先 `ctx.cancel(REQUEST_DEADLINE_CANCEL_REASON)` **再立刻 `ctx.fail(...)`**。handler 观察到 `request-deadline` 时 ctx 已 settled。
- 于是合成终止符只有两种落法：写在 settle 之后（History entry 已冻结 → 客户端拿到的终止符不在记录里，违 A4），或与既有超时错误路径并存（客户端在干净终止符后又收 error 帧，正是 §4.3 第 1 条自己点名要避免的形态）。
- 修复：硬掐路径拆成「先通知交付层收口（合成终态 + 记账标签）→ 再 settle」；或由 §4.7 的 admission 保证 deadline 到达前腿已收口、硬掐仅作最后兜底。**这条决定 §4.7 选哪个方案**。

### [major] §4.7 应取「admission 加在硬掐之前」，`request_deadline_mode` 枚举是错方案；且 request-age 兜底不能一起改掉

- 两个候选里正确的是**后者**：admission 与硬掐派生自同一个量，硬掐留作外层兜底。`mode: hard | admission` 的 admission 取值会**删掉「每个请求终有上界」这条不变量**——一个配置值就能移除一条不变量，是错误的配置形状。
- 叠加 §4.7-2 后风险实体化：request-age 判据今天只有两处（`manager.ts:306` 周期 reaper + `:410` 硬掐定时器）。把 reaper 改判为「单次上游尝试年龄」等于交出其中一处；硬掐若又被切成 admission，泄漏 ctx（settle 路径 bug）无人回收。
- 正确形状：`request_deadline` 同时派生 admission（带最坏单腿成本，复用 `hedge-policy.ts:128` seam）与硬掐兜底；**per-attempt 是另一个量，应新增第二个键**（如 `upstream_attempt_deadline`）而非改判原键 —— 两个不同量并存不属于 A2 的「双轨」，请在文中明写，否则实现者会误引 A2 去合并它们。

### [major] §4.0 的「唯一例外」对阶段 0 确实正交，但对 §4.7 不正交

- **正交性已核实成立**：反应式重试只在 dispatch 开启阶段触发（`dispatch-scheduler.ts:288` 在 `response.error` 上调 `decideRetry`），不在流中；因此把网络族抬到 9 不会产生客户端可见重复内容，也不触碰 allocator / 块级改动面。这条可以先行。
- **但**族预算 9 + 指数退避的挂钟时间无上界约束，而 `request_deadline` 硬掐 1200s 仍在（3600s 属 §4.7、在阶段 1）。慢失败形态下（effective `responseHeaderTimeout` 900s）9 次结构上不可达 → 复制 C13「名义 N、实际更少」的同一缺陷，而 B2 的全部卖点正是消灭该缺陷。
- 修复：例外条款补边界句 ——「B2 先行时有效上限受 `request_deadline` 约束，族预算须带挂钟感知的 admission」；并把 §4.6-5 的正样本守卫扩成「预算 N **且时间充裕**时恰好 N 次重试」，否则守卫会在时间被截断时假绿。

### [major] §4.9 作为一等范围项，缺进入计划阶段的最小要件

- ①**hedge 合格性语义要先裁定**：`hedge-policy.ts:118` 的 `semanticContentCommitted → 不合格`，在块级默认开之后语义变成「首块提交即永久禁 hedge」。统一后 hedge 是否允许 post-commit（若允许，与已提交前缀如何并存）是前置决定，不是实现细节。
- ②**预算口径要重算**：§4.6 推出的候选上限 12（11 + 余量 1）未计 hedge secondary（`state-defaults.ts:190` 默认 1），余量已被吃光；`generationMaxActiveCandidates: 2` 与「恢复腿 + 并行 hedge」的并发上限也需重推。
- ③**与阶段 0 allocator 的接缝**：两个候选并发时 wire-index 的预留 / 回收语义（allocator 是 generation-scoped，hedge 天然并发）。
- ④**缓冲归属**：`driver.ts:823-825` 短路移除后，buffered 下谁的 buffer 提交给客户端、败者候选已提交块如何处置。
- ⑤验收 oracle 与需先跑的 PoC 项（同 §4.4 前置门体例）。少了这五项，§4.9 无法被 planner 转成 TDD 阶段。

## 对五问的直答

1. **§4.1 是否闭合 B4/M3/M8**：维度补齐方向对，B4（分类轴投影损失）与 M3（idle-timeout 覆盖缺口）实质闭合；**但 idle-timeout 引入了新误救**（发现 1），且 M8 第四态在 `request-deadline` 行与机制冲突（发现 3）。「不救」诸格理由**均站得住**：shutdown / reaper-cancel / request-cancel / dispatch-cancel / client-abort 都是本进程或客户端的主动决定，重试等于违抗主动意图；`unknown-cancel` 的「先补 provenance 标签再议」是正确的保守姿态。
2. **§4.0 例外**：对阶段 0 / allocator / 块级**确实正交**（反应式重试触发点在流之前），但对 §4.7 不正交（发现 5）。
3. **§4.7 形状**：选「admission 加在硬掐之前」，弃 `mode` 枚举；`stale_request_max_age` 的改判必须以「新增第二个键」而非「改判原键」落地，否则长请求的 request-age 兜底归零（发现 4）。
4. **§4.9 缺什么**：见发现 6 的五项。
5. **返工是否长出新问题**：是，三处 —— 发现 1（长在 M3 的修复上）、发现 2（长在 M8 裁决的落地方式上）、发现 3（长在 M8 × C6 的交叉处）。

## 未纳入本轮（按约束只报 blocker/major）

余下若干 minor（措辞、指针一致性、可选守卫）不列出；6 条 major 补完即可定稿。
