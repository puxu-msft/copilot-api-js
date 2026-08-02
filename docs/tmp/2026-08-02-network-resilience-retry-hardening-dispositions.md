# 处置表：网络韧性重试加固草案（第 1 轮）

- 对象：[2026-08-02-network-resilience-retry-hardening.md](2026-08-02-network-resilience-retry-hardening.md)
- 第 1 轮评审：`gpt-souls:reviewer` 事实核验，报告 [2026-08-02-network-resilience-retry-hardening-review-gpt.md](2026-08-02-network-resilience-retry-hardening-review-gpt.md)（裁决：7 确证 / 5 部分成立 / 0 证伪 / 0 blocker）
- Claude `reviewer`（对抗性架构轴）**运行中**，回来后并入第 2 节。
- 级别取值见 skill `adopting-agent-findings` 的分级表（A 不由我裁 / B 写进指令文本 / C 落进产物可逆 / D 当场可撤）。

## 1. 主会话独立复核（不代替评审，只证实我要据以行动的事实）

按 `verifying-authoritative-claims`，我没有直接采信报告，对三条要据以改设计的事实亲手复核：

| 事实 | 我的复核动作 | 结论 |
|---|---|---|
| 存在 1200s per-request hard deadline | `rg -n request_deadline config.yaml` → `:261 request_deadline: 1200`；`src/lib/context/manager.ts:410-424` 在 `create()` 时 arm timer、到期 `ctx.cancel`；用户 override `/home/xp/.local/share/copilot-api/config.yaml` 的 `timeouts:` 只有 `response_header: 900` / `stream_idle: 600`，未覆盖该键 | **成立**。内置默认 `requestDeadline: 0`（禁用），但 shipped config 显式设 1200 → effective 1200s |
| 首块提交后的 inter-block gap 只发裸 ping | `delivery/session.ts:127` 注释自陈「a no-open window needs the future monotone index allocator」 | **成立**，且见下方升级 |
| `server_tool_use` 的现有测试是假绿 | 读 `tests/anthropic/committed-block-extractor.unit.test.ts:50-60`：测试名为 `drops non-replayable block types (thinking / server_tool_use)`，fixture 只有 thinking + text 两块，**无任何 server_tool_use 帧** | **成立**，名实不符 |

## 2. 逐条处置

| # | 发现 | 裁决 | 级别 | 理由 |
|---|---|---|---|---|
| G1 | C6 被推翻：存在 `timeouts.request_deadline` = 1200s，3600s 若不联动则不可达 | **采纳** | A（遵从既有裁决分支，直接执行） | 已独立复核。用户明确要求「总超时到 3600s」，故把该值提到 ≥3600 正是**遵从**用户裁决，不重问。但 §4.5 必须重写成「与既有 hard deadline 的关系」而非「新造一个不存在的东西」 |
| G2 | C10 修正：60s byte-idle 已过时（CC 2.1.207 为 first-party 180s / 其他 300s，且可被 env/remote 覆盖） | **采纳** | C | 事实性修正，直接改 §2 C10 |
| G3 | C10 收窄：首块完成后的 no-open inter-block gap 仍只发 ping，不覆盖 300s event-idle | **采纳并升级**（见 §3） | C→需用户知情 | 报告把它定位为「§4.5 承重因果链的缺口」，我复核后认为定位偏轻 |
| G4 | C11 敞口可关闭：extractor 明确丢弃 `server_tool_use`，不会归一成 `tool_use` | **采纳** | D | 独立 probe + 我读码复核一致。删除草案 §6 的 O1 |
| G5 | C11 附带：现有测试是假绿，建议补真实 fixture | **采纳** | C | 已独立复核成立。补 fixture 进实施计划；它守的正是 ADR D3 的判别谓词，值得一条真测试 |
| G6 | C5 修正：「用户 config 亦为 3」不成立，用户 override 无该键，effective 3 来自 shipped config | **采纳** | D | 事实性修正 |
| G7 | C8 收窄：`configKey` 是逐策略 ID 不是族标签，按族解析预算需扩展 registry entry 或加显式映射 | **采纳** | C | 直接影响 §4.4 工作量估算，草案「无需新建注册机制」的措辞会误导计划阶段 |
| G8 | C12 修正：Chat Completions 实际挂了 `ccCommitBoundaries`（只把 in-band error 当边界），「无 commitBoundaries」字面错误 | **采纳** | D | 事实性修正；「内容递送实质 terminal-only」的结论不变 |
| G9 | §4.5 的 300/300 是 hardcoded fallback，非 effective（shipped 600/600、用户 override 后 900/600） | **采纳** | D | 改为写明 effective 值并声明本设计不改动它们 |
| G10 | 建议把修订路由给 `gpt-souls:architect-advisor`、实施交 `gpt-souls:implementer` | **不采纳（暂定）** | D | 草案修订量小且全是事实替换，主会话直接改比重建心智模型便宜（`31-subagent-economics`）。实施阶段的角色分工等计划定稿后再定，现在指派为时过早 |

无「不采纳且理由为惯例/体例/我觉得没必要」类驳回。唯一驳回项 G10 已标暂定，收口前并入合议。

## 3. 升级：inter-block gap 不是 3600s 的因果链缺口，而是 §4.0 的回归源

报告把 G3 定位为「3600s 承重因果链的缺口」。我复核后认为**定位偏轻一档**，理由：

- 今天 Anthropic 走 live 路径，持续有 open block 的 delta，**不暴露**在这个缺口上。
- 草案 §4.0 把 Anthropic 默认翻成 block-level 后，driver 只在 `content_block_stop` 原子 flush ⇒ **正在生成的上游块在客户端轨上根本不存在** ⇒ 首块提交后的每一次长生成，客户端看到的都是「无 open block 的静默」。
- 所以这不是「3600s 达不到」，而是**开启块级本身就会让超过 300s 的生成必断** —— 一个当前不存在的回归。

该缺口已有冻结设计与完整计划，但**未实施**：
- spec [docs/spec/2026-07-27-inter-block-keepalive-carrier.md](../spec/2026-07-27-inter-block-keepalive-carrier.md)（已过审）
- plan [docs/plan/2026-07-27-inter-block-anchor-allocator/](../plan/2026-07-27-inter-block-anchor-allocator/) 共 9 相位，状态「**计划待审**」
- 该 plan README 自陈：「当前 master 已落地的是 pre-content-only 升级（`semanticBlockCount === 0` 门），首块后仍只发裸 ping，>300s 必断。本计划就是该门的解除条件。」

**结论：generation-scoped 单调 wire-index allocator 是本特性的硬前置，不是可选项，也不能降级为「以后做」。** 排序上它必须先于 §4.0 的默认翻转。

## 4. 待办（第 2 轮评审回来后合并处置）

- [ ] 并入 Claude `reviewer` 的架构轴发现
- [ ] 按 G1–G9 修订草案 §2 / §4.4 / §4.5 / §6
- [ ] §4.5 重写为「`retry.total_budget_sec` 与 `timeouts.request_deadline` 的优先级与迁移关系」
- [ ] 新增依赖节：inter-block allocator 作为硬前置，并给出排序
- [ ] G10 的暂定驳回并入收口合议
