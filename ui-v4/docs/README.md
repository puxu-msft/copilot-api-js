# ui-v4 文档索引

> `ui-v4/` 前端的文档归属地图（读者 → 文档，一行一条）。**新会话/接手先读 [ARCHITECTURE.md](ARCHITECTURE.md)**（当前架构现状），再按需下到设计规格 / 演进史 / 具体 plan。
>
> ⚠ 与后端 `docs/`（仓库根）不同：本目录只讲 **ui-v4 前端**。后端「v4 管线重构」（`docs/v4/`）只是共用 "v4" 代号，与本目录无关。

## 我想…（读者 → 文档）

| 我想… | 读 |
|---|---|
| 建立当前架构心智模型（栈/入口/数据层/渲染管线/目录职责） | [ARCHITECTURE.md](ARCHITECTURE.md) —— **活文档、实测为准** |
| 理解设计意图 WHAT/WHY（IA / 布局 / 交互 / 领域保真） | [DESIGN.md](DESIGN.md) —— brainstorm 定稿规格 |
| 看它怎么一步步长成现在这样（逐 Plan / 逐轮反馈） | [evolution.md](evolution.md) —— 演进史 |
| 补齐旧 Vue `ui/` 的功能对等、看退役 gating | [TODO.md](TODO.md) —— 对等清单（逐页缺口 + 严重度 + plan 关联） |
| 写/测 Radix 组件（样式桥 + 测试 gotchas） | [radix-styling.md](radix-styling.md) |
| 理解某个关键技术决策 + 理由 | [decisions/](decisions/) 见下 |
| 看某功能的实现规划 / commit invariants / kickoff | [plans/](plans/) 见下 |

## decisions/（ADR，一决策一文件）

| ADR | 决策 |
|---|---|
| [2026-07-05-adopt-radix-primitives.md](decisions/2026-07-05-adopt-radix-primitives.md) | 采用 radix-ui headless 增量迁移（弃手写交互原语） |
| [2026-07-05-headless-component-stack.md](decisions/2026-07-05-headless-component-stack.md) | headless 组件栈选型（TanStack Table / react-hook-form / cmdk 等） |
| [2026-07-06-requests-list-libraries.md](decisions/2026-07-06-requests-list-libraries.md) | Requests 列表增强的库选型（含 react-day-picker） |

## spec/（设计规格 WHAT/WHY，框架无关可复用）

| spec | 范围 |
|---|---|
| [2026-07-05-ui-v4-config-form.md](spec/2026-07-05-ui-v4-config-form.md) | Config 结构化表单（全 SSOT 字段、raw 只读、整体替换语义） |
| [2026-07-05-ui-v4-models-enhancement.md](spec/2026-07-05-ui-v4-models-enhancement.md) | Models 页全面增强（数据完整性、遥测 join、6 分区详情、CSV） |
| [2026-07-06-ui-v4-requests-list-enhancement.md](spec/2026-07-06-ui-v4-requests-list-enhancement.md) | Requests 列表增强 |

## plans/（实现计划 + commit invariants）

- **里程碑主计划**：`2026-06-23-01..07`（foundation → workbench → detail-content → detail-diff → in-request-search → sessions-agent → overview-models-config → polish-responsive）、`2026-06-24-08/09`（detail-page-split-toc-tree / detail-list-polish）、`2026-07-05-06b-models-page-enhancement`、`2026-07-05-per-block-json-modal-design`、`2026-07-05-radix-migration`、`2026-07-05-ui-v4-config-form`。
- **[kickoffs/](plans/kickoffs/)**：新会话启动提示词（models-kickoff-p3-p4 / radix-migration-kickoff / ui-v4-config-form-kickoff）。
- **[iterations/](plans/iterations/)**：小迭代修复（history-url-locate / response-tab-proxy-client-data-fix / session-list-row-layout / sse-diff-false-positives-fix）。
- **[models-enhancement/](plans/models-enhancement/)**：Models 增强的分 phase 计划（phase-1~4 + README + prompts/）。

## archive/（已 supersede / 历史脑暴，留档）

| 文档 | 说明 |
|---|---|
| [decisions.md](archive/decisions.md) | 早期 chronological 决策草稿（已被 DESIGN.md supersede） |
| [web-ui-rewrite-ops-console.md](archive/web-ui-rewrite-ops-console.md) | 最初脑暴稿 |

## 交接文档

- [HANDOFF.md](HANDOFF.md) —— 早期重构交接提示词（混设计/进度/约定；设计现状请以 DESIGN.md + ARCHITECTURE.md + evolution.md 为准）。
