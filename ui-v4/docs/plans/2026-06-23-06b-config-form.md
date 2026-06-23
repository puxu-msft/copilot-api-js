# ui-v4 Plan 06b — Config 结构化分组表单 Implementation Plan

> REQUIRED SUB-SKILL: superpowers:subagent-driven-development。先读 `ui-v4/docs/HANDOFF.md` + `DESIGN.md §7`。

**Goal:** 给 Plan 06 的 Config raw-JSON 编辑器加**结构化分组表单**（spec §7：默认 raw、可切结构化）——左 section 导航 + 字段控件 + 校验高亮。

**Architecture：** `/api/config/yaml` 返结构化 JSON 对象（Plan 06 已确认）。表单按 section（anthropic/openai_responses/history/timeouts/web_search/rate_limiter/shutdown/...）分组，每字段按类型渲染控件（toggle/number/enum/string-list/kv-map/text）。改动累积成 partial → PUT。校验错误（PUT 400 的 `{error,details:[{field,message}]}`）映射到对应字段高亮。Config 顶部「raw JSON ↔ 结构化」切换（raw 复用 Plan 06 的编辑器）。

**参照旧 UI**：`ui/src/components/config/{ConfigSection,ConfigToggle,ConfigNumber,ConfigEnum,ConfigStringList,ConfigKeyValueList,ConfigText,ConfigRewriteRules}.vue` + `ui/src/types/config.ts` 的 `EditableConfig`（字段 schema 蓝本）。

## 后端契约（deep-read）
- GET `/api/config/yaml` → 结构化对象；PUT 接 partial、返 200 parsed 或 400 `{error, details:[{field,message}]}`。**deep-read** `src/routes/config/route.ts` + `ui/src/types/config.ts` 确认 section/字段 schema + 校验错误形状。后端字段含义见根 `docs/DESIGN.md` 「运行时选项」配置表。

## 文件结构
```
ui-v4/src/components/config/
├── ConfigPage.tsx(修改)            # raw ↔ 结构化切换
├── StructuredConfig.tsx            # section 导航 + 字段表单
├── fields/{Toggle,Number,Enum,StringList,KeyValueList,Text}.tsx  # 字段控件
└── config-schema.ts                # section→字段→控件类型 映射(从 EditableConfig 蓝本)
tests/ 字段控件 + StructuredConfig vitest
```

## Tasks
- [ ] **Task 1 — config-schema.ts**：deep-read `ui/src/types/config.ts` + 根 DESIGN.md 配置表 → 声明 section/字段/控件类型/枚举值的 schema（数据驱动表单）。
- [ ] **Task 2 — 字段控件（TDD）**：Toggle/Number/Enum/StringList/KeyValueList/Text，受控 value+onChange。
- [ ] **Task 3 — StructuredConfig**：左 section 导航 + 按 schema 渲染当前 section 字段 + 改动累积成 partial。
- [ ] **Task 4 — 校验高亮**：PUT 400 的 details[].field → 对应字段高亮 + 消息。
- [ ] **Task 5 — ConfigPage 切换**：默认结构化（spec §7 默认 raw——确认用户偏好；spec 写默认 raw，则保持 raw 默认 + 切结构化），raw 复用 Plan 06。
- [ ] **Task 6 — 验证 + 回填**。

## 验收
- typecheck/test/build 绿；手动：结构化编辑字段 + 保存 + 校验高亮 + raw/结构化切换。

## 暂缓
- ConfigRewriteRules 等复杂嵌套控件 → 视需要。
