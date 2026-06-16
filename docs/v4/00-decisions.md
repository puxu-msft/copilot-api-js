# 00 — 决策记录

本文件记录 v4 重构 brainstorm 阶段的全部拍板。每条决策含**选项、定夺、理由**。后续所有文档以此为准。

---

## D1 — 架构重心：全量控制流统一

**定夺**：不只是拆 handler，也不只是改写流水线化，而是**全量**——统一阶段骨架 + driver + 可插拔改写流水线 + observability 横切分离三者兼得。

**理由**：用户的首要诉求是控制流与横切的彻底统一，接受更大的改动量换最高可维护性。注意"全量"落在**控制流统一**，不强求数据模型统一（见 D2）。

---

## D2 — IR 形态：薄信封（thin envelope）

**选项**：薄信封 / 厚规范 IR（全格式语义超集）/ 双层 IR + opaque 附件。

**定夺**：**薄信封**。driver 在阶段间流转的 context 装：① 编排元数据（model / stream / endpoint / tool 摘要 / 消息计数）② 不透明原始 body ③ 按需解析视图。改写阶段按需解析具体块，**不做全格式往返翻译**。

**理由**：
- 薄信封天然守住 **Anthropic 直连字节无损**（body 不透明透传，根本不往返翻译），避开厚 IR 最大的坑——thinking signature / cache_control / server_tool 的无损往返噩梦。
- 用户的"全量"重心是控制流统一而非数据统一；薄信封让两者正交，控制流可彻底统一而数据表示保持格式原生。
- 代价（薄信封下"加新格式"收益有限、改写仍需感知具体格式）被接受——因为加新格式不是首要诉求。

---

## D3 — 数据流驱动器 + event bus + 横切分离

**定夺**：一个 **stage-driver** 顺序驱动各阶段，每个阶段边界自动向 **event bus** 发事件；log / metric / history 作为 **subscriber** 消费；各阶段实现是**纯 transform**，零感知 observability。

**关键发现（盘点纠正）**：event bus 架构**已经基本落地**——`src/lib/observability/`（`bus.ts` + 命名空间隔离 + `assertNever` + 4 个 sink）已存在，`HistorySink` 已是一等 subscriber，`consumers.ts` / `lib/tui/` 已删除迁入 sink。当前是"双轨过渡期"（RequestContext legacy `onEvent` + 新 `ScopedPublisher` bus 并行）。

**因此 D3 的真正工作**：不是从零建 bus，而是——
1. 把 7 阶段编排从巨型 handler 提升为统一 driver；
2. 把**数据采集**（`setSseEvents` / `setForwardedResponse` / `setAttemptWireRequest` 等）从 handler 手动散点**下沉为 driver 自动采样**（现状 `setSseEvents` 只有 Anthropic 路径实现，是最大缺口）；
3. 收敛双轨过渡期，让 bus 成为唯一事件分发通道。

---

## D4 — 流式响应建模为 async-iterator transform chain

**定夺**：响应侧（S5 改写 → S6 翻译 → S7 返回）是一条**持续运行的 transform 流水线**，不是一次性阶段。SSE 帧流过 `[响应改写]→[格式翻译]→客户端`，metric/history 累积器作为 subscriber 在 transform 边界**采样**（上游原始帧入 `sseEvents`，forwarded 帧入 `forwardedSseEvents`，两端由管线统一落地）。

**理由**：请求侧线性一次性、响应侧流式逐帧，driver 必须驾驭两种节奏。把流式响应建模为 transform chain，正是"数据流驱动"价值最大处，也天然落实"上游原始 vs 客户端实收"双轨记录。

---

## D5 — 重试边界：错误驱动的策略化专用逻辑（非统一线性回退）

**定夺**：重试**不是**统一的"回退到某 stage 重跑"，而是**由错误触发原因决定专用修复逻辑**：

| 错误类型 | 修复 + 重入语义 |
|----------|----------------|
| 网络 / 认证 | 同 payload 直接重发 |
| beta 头不合法 | 裁剪 beta 后重发（或并入正在进行的裁剪试错循环） |
| 请求超长 | 专用反复裁剪 / 清理逻辑 |
| web_search 等 | 各自专用改写逻辑 |

driver 提供机制让每个 strategy 表达"修复什么 + 从哪重入"，**保留策略化而非强行线性化**。

**理由**：用户明确纠正了我最初的"stage checkpoint replay"统一模型——它过度统一化了。现状的 `RetryStrategy` 模式（每策略 `canHandle` + `handle` 改 payload/hints）本质正确，应保留并提升，而非替换为线性回退。盘点确认：现有 7 个策略里 network/token-refresh 是同 payload 重发，unsupported-beta 是改 header（含 laconic 子集枚举循环），auto-truncate / deferred-tool / legacy-thinking / body-field 是改 payload 重发——四种"重入语义"并存，证明策略化是对的。

---

## D6 — 改写装配：命名 transform，driver 按上下文组装

**定夺**：每个改写动作 = 一个**命名、可插拔、可独立测试**的 transform；driver 启动时按 (格式, config, 上下文) **装配出有序改写链**；event bus 记录每个 transform 是否触发、改了什么——喂给 history 的 sanitization 诊断（消除现状手动 `setAttemptSanitization` 散点）。

**理由**：盘点确认现状已有 40+ 个改写动作（A1–A9 / T1–T7 / B1–B12 / O1–O15 / S1–S4），**大多已是独立纯函数**，但串联顺序靠 handler 注释维系（T<sanitize、A6<A8、B3<B4<B5…），且 prepare 的子步骤未导出无法重排。把它们注册成有序 transform registry，即消除靠注释维系的顺序契约。

---

## D7 — 迁移策略：渐进混合，每 commit 不破坏

**定夺**：**渐进混合**——逐模块选最佳路径（有时提升现有资产、有时重写兄弟模块替换），每个 commit 让系统处于不破坏状态（commit invariants），旧路径并存到切换完成。

**理由**：这是 ≥1000-LOC 重构，big-bang 风险高且一次 review 不完。盘点显示现有 `executeRequestPipeline` + `RequestContext` + observability bus 已是优质横向资产，应提升而非推倒；而巨型 handler 的内联编排应重写为 driver 阶段。

---

## D8 — 范围与能力保全

**定夺**：
- 完成前**不管 UI**（UI 未来迁出主模块）。
- 但**全程保全三大能力**：① 全面 API 访问（`/history/api/*` 返回全量双轨 entry）② 日志访问（`/api/logs`、`/api/status`、`ConsoleSink`、WS topic）③ 原始数据完整记录（双轨字段集 + per-attempt 全量 + sqlite 增量持久化）。
- 新架构要让"原始数据记录"成为 event bus 一等 subscriber（`HistorySink` 已是），与 UI（`WsSink`）解耦。

**稳定契约（不可破）**：`HistoryEntryData` 类型、`ObservabilityEvent` 判别联合、`finalizeEntry` 显式终态写库、sqlite `entry_stages` 增量持久化、`/history/api/entries/:id` 全量双轨返回、WS 消息 wire 协议。

---

## D9 — 产出形式：文档优先

**定夺**：本会话产出**文档体系**（架构 / 规格 / 迁移计划 / 进度 / 未来会话实现提示词），**不直接写生产代码**。未来用户用 prompts/ 里的提示词启动新会话逐模块实现。

**理由**：用户明确要求"转为专业架构/计划设计角色"，且这符合既有的"RFC-then-implement for large refactors"方法论（≥1000-LOC 重构先 RFC + 多轮对抗 review 再实现）。
