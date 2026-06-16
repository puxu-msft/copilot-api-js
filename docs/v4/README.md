# v4 — 模型请求管线重构（Pipeline Re-architecture）

把"模型请求后端"从**每格式一套巨型 handler**重组为**一条统一的、数据流驱动的、可观测的分层管线**。

## 这是什么

当前每种 API 格式（Anthropic Messages、OpenAI Chat Completions、OpenAI Responses、Gemini、Azure 变体）各有一个 `routes/*/handler.ts`，把"接收→翻译→改写→上游收发→响应改写→翻译回→返回"七个阶段**全部压扁进单个文件、且每格式各重复一遍**（`messages/handler.ts` ~1000 行，`chat-completions/handler.ts` ~740 行）。

v4 把这七个阶段提升为一条 **driver 编排的管线**：每个阶段是纯 transform，driver 在阶段边界发事件，log/metric/history 作为 subscriber 横切消费。各格式只提供自己的 **codec**（解析/翻译/改写实现），编排、驱动、横切、收发全部复用。

## 文档地图

| 文档 | 内容 | 状态 |
|------|------|------|
| [00-decisions.md](./00-decisions.md) | 决策记录：本次设计的全部拍板 + 理由（读这里先理解"为什么这样设计"） | ✅ |
| [01-architecture.md](./01-architecture.md) | 目标架构：6 个一等概念 / 7 阶段 / driver / event bus / 薄信封 / 错误驱动重试模型 | ✅ |
| [02-current-state.md](./02-current-state.md) | 现状精确盘点：重试策略、请求改写、响应改写、codec、context+history、client 全清单（带 file:line） | ✅ |
| [03-spec/](./03-spec/) | 各模块规格：接口契约、类型定义、行为规格 | 🚧 |
| [04-migration-plan.md](./04-migration-plan.md) | 渐进迁移计划 + 每个 commit 的 invariant（每步不破坏系统） | 🚧 |
| [05-progress.md](./05-progress.md) | 开发进度看板 | 🚧 |
| [prompts/](./prompts/) | 给未来新会话的逐模块实现提示词（可直接粘贴启动实现会话） | 🚧 |

## 核心设计速览

```
                          ┌─────────────────── event bus（已存在）───────────────────┐
                          │   subscribers: HistorySink / WsSink / TelemetrySink /     │
                          │                ConsoleSink （横切，零侵入业务）            │
                          └──────────────▲───────────────────▲──────────────────────┘
                                         │ 阶段边界自动发事件  │ 自动采样原始数据
   请求侧（线性一次性）                   │                    │
   ┌──────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐
   │ S1   │→ │ S2       │→ │ S3       │→ │ S4       │
   │Ingest│  │Translate │  │Rewrite-in│  │Exchange  │←── 错误驱动重试（策略化，非线性回退）
   │接收  │  │-in 翻译  │  │请求改写  │  │上游收发  │
   └──────┘  └──────────┘  └──────────┘  └────┬─────┘
                                               │ SSE 帧流
   响应侧（流式 transform chain）              ▼
   ┌──────────┐  ┌──────────┐  ┌──────┐
   │ S5       │→ │ S6       │→ │ S7   │
   │Rewrite   │  │Translate │  │Egress│
   │-out 改写 │  │-out 翻译 │  │返回  │
   └──────────┘  └──────────┘  └──────┘

   薄信封 IR：context 装编排元数据 + 不透明原始 body + 按需解析视图
   codec：每格式提供 parse / translate / render 三钩子
   改写：每个动作是命名 transform，driver 按 (格式, config) 装配成有序链
```

## 关键约束（不可破）

1. **Anthropic 直连字节无损**：thinking signature 等块必须逐字回传上游，否则上游 400。薄信封 body 不透明透传守住这一点。
2. **三大能力全程保全**：① 全面 API 访问（`/history/api/*`）② 日志访问（`/api/logs`、`/api/status`、WS）③ 原始数据完整记录（双轨：上游原始 vs 客户端实收）。
3. **每个 commit 不破坏系统**（commit invariants）：渐进迁移，旧路径并存到切换完成。
4. **UI 未来迁出主模块**：所以"原始数据记录"必须是 event bus 的独立 subscriber，与 UI 解耦（现状 `HistorySink` 已经是了）。
