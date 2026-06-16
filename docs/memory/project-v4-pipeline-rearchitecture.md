---
name: project-v4-pipeline-rearchitecture
description: v4 模型请求管线重构的设计与计划，文档在 docs/v4/，分 P0-P3 渐进实施
metadata: 
  node_type: memory
  type: project
  originSessionId: aef7321a-543b-4e1e-bbb8-762455cee92b
---

copilot-api-js 正在做 **v4 模型请求管线重构**：把"每格式一套巨型 handler"（messages/handler.ts ~1000 行等）重组为"一条 driver 编排的七阶段管线"（S1 Ingest → S2 Translate-in → S3 Rewrite-in → S4 Exchange → S5 Rewrite-out → S6 Translate-out → S7 Egress）。

完整设计文档在 **`docs/v4/`**（2026-06-16 brainstorm 产出，本会话未写生产代码）：
- `README.md` 导航、`00-decisions.md`（D1-D9 拍板）、`01-architecture.md`、`02-current-state.md`（现状盘点带 file:line）、`03-spec/`（4 份模块规格）、`04-migration-plan.md`（P0-P3 + commit invariants）、`05-progress.md`（看板）、`prompts/`（P0-P3 可粘贴的新会话实现提示词）。

核心决策：**薄信封 IR**（context 装元数据+不透明 body，守 Anthropic 直连字节无损）；**event bus 已存在**（`src/lib/observability/`，HistorySink/WsSink/TelemetrySink/ConsoleSink，consumers.ts/lib/tui 已删），重构是"提升编排 + 下沉数据采集"而非重建总线；**错误驱动重试**（strategy 改 env 而非 wire，统一"修复+重入"，保留策略化非线性回退）；**改写注册式 transform**（40+ 改写已模块化，顺序契约从注释升为 order 键）；**渐进迁移**（CC→Responses→Gemini→Anthropic，feature flag 并存，每 commit 不破坏）。

未来实施：用户会用 `docs/v4/prompts/P*.md` 启动新会话逐阶段实现。三大能力全程保全：API 访问（/history/api/*）、日志（/api/logs、/api/status、WS）、原始数据双轨记录（上游原始 vs 客户端实收）。关联 [[ghc-tool-call-text-downgrade]] [[thinking-signature-self-contained]] [[methodology-commit-invariants]]。
