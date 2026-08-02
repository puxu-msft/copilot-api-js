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

## 4. 第 2 轮：Claude `reviewer`（对抗性架构轴）

报告 [2026-08-02-network-resilience-retry-hardening-review-claude.md](2026-08-02-network-resilience-retry-hardening-review-claude.md)。裁决：**须重做**（§4.0 / §4.4 / §4.5 三节返工后重审）。Blocker 4 / Major 10 / Minor 7 / Nit 1。

### 4.1 主会话独立复核（五条承重发现，全部亲手取证，全部成立）

| 发现 | 复核动作 | 结论 |
|---|---|---|
| B2 网络类抬到 9 是空操作 | `network-retry.ts:35,41,50` 的 `hasRetried` 布尔闸；`server-error-retry.ts:24` 的 `SERVER_ERROR_MAX_RETRIES = 2` 硬编码 | **成立**。`max_reactive_retries` 不是绑定约束，抬 5→9 零行为变化 |
| B4 `idle-timeout` 落不进任何腿 | `packages/foundation/src/stream.ts:164-174` 九种 kind；`driver.ts:1430` 与 `:1481` 两门均要求 `=== "other"` | **成立**。gpt-5.5 的 266–462s 静默正是这一形态 |
| B1 撞冻结硬前置门 | ADR `2026-07-22-continuation-retry-sequential-anchor.md:27` 原文「并是 Anthropic 块级默认翻转的**硬前置门**」；carrier spec `:16,:157,:193` 三处同义 | **成立**。§4.0 越过了已裁决的门（`what-decided-is-decided` 违反，责任在起草方） |
| M1 块级废掉 hedge | `driver.ts:823-825` `if (outerOpts && "retryCap" in outerOpts) return undefined`；Anthropic buffered 分支恒带 `retryCap`（`handler-v4.ts:1344`） | **成立** |
| M3 `bufferedBytes` 不清零 | 全文件仅三处：`driver.ts:1227` 初始化 / `:1274` 累加 / `:1275` 判定，无重置 | **成立**。块级下度量的是整条腿累计渲染字节而非驻留内存 |

### 4.2 逐条处置

| # | 发现 | 裁决 | 级别 | 理由 |
|---|---|---|---|---|
| B1 | §4.0 越过 allocator 硬前置门 | **采纳** | A（回用户裁排序） | 门是已裁决事实，不重新论证。需用户在「先做 allocator / 拆阶段并行 / 推翻门」间拍板 |
| B2 | 网络族抬预算是空操作，须把策略内部硬闸参数化 + 指数退避 + 正样本守卫测试 | **采纳** | C | 已独立复核。这是用户头号诉求的唯一有效落点，且与 §4.0 正交、可独立先行 |
| B2-附 | `token-refresh` 不应与网络族共用 9 次 | **采纳** | C | 凭据无效时重刷 9 次是打 auth 端点。单列低值 |
| B3 | §4.5 应扩展既有 `request_deadline` 而非新增键；另有 `stale_request_max_age` 按 `ctx.durationMs` 判定的命名谎言 | **采纳** | C | 与 G1 同源，反对造第二条平行轨（A2）。两个 1200s 杀手都要处理 |
| B4 | 三腿按 commit 状态分类，代码按 error class 门控；须补 error-class × commit-state 穷尽表 | **采纳** | C | 已复核。`idle-timeout` 在零提交时应可透明重试——它是**代理自设**门限，非上游终局决定 |
| M1 | 块级化连带废掉 hedge，草案未记录 | **采纳** | A（回用户） | 静默摧毁另一个默认开启的韧性机制违反 `no-silently-cut-but-defer` |
| M2 | translate leg（`/v1/messages` + `@cc`/`@responses`）零条腿，且它是 `liveReconcilingSink` 的第二消费者 | **采纳** | C | 范围内端点却零覆盖，必须显式处理而非沉默 |
| M3 | retreat 短路在三腿之前 + `bufferedBytes` 不清零 | **采纳，部分自决** | C | `bufferedBytes` 清零是纯根因修复，自决。retreat 保留为**单块** OOM 兜底（修清零后近乎不可达），但其后截断须走三腿体系而非直接 error |
| M4 | `32` 派发预算差一个数量级（11 候选 × 15 ≈ 165）；透明重试分支无 try/catch 会硬崩 | **采纳** | C | 两个预算是**相乘**关系，我按相加估了。预算耗尽是可预期终局，不应伪装成意外崩溃 |
| M5 | §4.2 新终态在 handler 分支阶梯里的优先级未定义，会导致干净终止符后**又**收到 error 帧 | **采纳** | C | 同族陷阱见 `reference-exactly-one-terminal-is-not-exactly-one-complete-terminus` |
| M6 | `usage:<已累计>` 无定义，acc 每腿重置，跨腿 usage 累加器不存在 | **采纳** | C | §4.2 漏列的新增实现项 |
| M7 | 「History 记为正常完成」与 contentless refusal 先例冲突，且会毁掉本特性的验收指标 | **采纳** | C | 论证强：把伤害记成成功就再也无法验证本设计是否有效。交付=干净、判定=fail 两轴正交 |
| M8 | 第四态（已提交 + 无 tool_use + 预算耗尽）未定义，§4.2 的终止符对该前缀非法 | **采纳** | A（回用户选形状） | 该态在本设计下变得**更常见**而非更罕见 |
| M9 | Responses 续写缺 `sequence_number` / `response.id` 跨腿一致性；§4.2 Responses 分支依赖 §4.3 先落地 | **采纳** | C | 附带：`sequence_number` 是否被客户端校验须先跑探针 |
| M10 | 推翻 WS terminal-only 的论证不完整；且 ADR D4 与 2026-07-11 决策 2 直接冲突、无 supersede 记录 | **采纳** | C | D4（较新）已决定「Responses WS 升块级」——**我不需要新论证，需要补 supersede 记录**并回应原论证全部三点 |
| m1–n1 | 七条 Minor + 一条 Nit（O1 闭合、learning 第四族、`recovery.max_candidates` 死旋钮、WS 改动位置指错、fallback 组合未验证、前端/doc 同步面、admission 形式判据） | **全部采纳** | D | 无争议事实修正 |
| §3 建议表 5 条 | 四维穷尽表 / `admitNewLeg` 统一 seam / 验收指标 / 真 SDK oracle + mutation control / A1 按行为而非按名字扫 | **全部采纳** | C | 最后一条尤其承重：`retreated` 与 hedge 都是「事实上的 live 退路」但不叫 live，逃过了我的公理扫描 |

本轮无驳回项。

### 4.3 需用户裁决的三个分叉（已提问）

B1 排序 / M1 hedge 去向 / M8 第四态形状。三者都改变客户端可观察行为或工作量数量级，不由我裁。

## 5. 待办（用户裁决后执行）

- [ ] 按两轮共 30+ 条发现返工草案，按 reviewer 建议的顺序：B3 → B2 → B4+M3+M8 → B1 → M1/M2/M10 → M5/M6/M7/M9
- [ ] 补 error-class × commit-state × retreat × 预算的四维穷尽表（用穷尽 `Record` 让类型系统逼出全站点）
- [ ] 返工后发起第 3 轮复评（`SendMessage` 续跑两个原 reviewer；B 级与已升级分歧另派未卷入第三方）
- [ ] G10 的暂定驳回并入收口合议

