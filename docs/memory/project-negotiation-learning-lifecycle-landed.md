---
name: project-negotiation-learning-lifecycle-landed
description: "反应式学习记录(feature-negotiation 缓存)TTL 生命周期 + /api/negotiation 管理 API + ui-v4 Learned 页面已实现(feat/negotiation-lifecycle 分支,待 merge)"
metadata: 
  node_type: memory
  type: project
  originSessionId: ae552a7b-91e3-4c6c-839c-cd362bfc4fa3
---

反应式学习记录（GHC 400 反应式学到的兼容 workaround，[[feature-negotiation.ts]]）从**永久**升级为 **TTL 生命周期**：每条 `LearnedEntryMeta{firstLearnedAt,lastConfirmedAt,pinned?,manuallyExpired?,migrated?}`，按分类可配 TTL（`negotiation_learning` config，默认 30d，`toolFields`=90d、`partnerFeatures`=never），到期自动过期。单一过期判据 `isEntryActive`（新 leaf `src/lib/anthropic/negotiation-lifecycle.ts`）；门控只在 12 个 exported reader，mutator/快照/导出读原始。管理 API `/api/negotiation`（GET 分组快照 / POST renew·expire·pin·entry/delete → `{ok,entry}` / GET export v2 JSON），ui-v4 `Learned` 页面（10 分组、状态徽章合并「已过期」、续约/立即失效/pin/删除、整体导出、状态筛选）。

**承重不变量**（改动前 deep-read）：
- **meta 刷新 ≠ changed 返回值**（对抗审查 H3）：`setSupportedEfforts` 复活「已过期」条目时返 true（否则 effort retry 腿放弃、客户端吃 400；clampEffortLevel 预剥使正常期永不刷新 lastConfirmedAt→每 ~TTL 必过期一次）。仅「此前活跃+白名单未变」返 false。
- **v1→v2 单向迁移**：旧数组读时 stamp `migrated`，写时升 version:2，legacy `serverToolHistoryDowngrade` 仍读。
- config 热重载**五触点**（schema/config 接线/state[MutableState+CONFIG_MANAGED_DEFAULTS+4 clone 站点,含显式枚举站点列非可选 primitive]/mergeConfigIntoDocument 嵌套 ttl_days 分支/effective-config 自动 emit）。
- **扁平分类 snapshot value = endpoint 级 modelKey**（systemRejectModels/serverToolDowngrade），非裸模型；UI `displayValue` 剥 `|anthropic-messages|` 前缀显示、action ref 仍用 raw 往返。

工作流实例：spec(对抗审查)→两阶段 plan(对抗审查抓 H1/H2/H3 编译+回归 bug 折入)→subagent-driven 执行（**隔离 worktree** 避并发会话对 schema.ts/state.ts 在飞改动）→Phase1 review(Spec✅/Approved,7 红线全过)→Phase2 review(Spec✅/Changes-requested:2 spec 列测试+死码)→fix。权威：`docs/spec/2026-07-08-negotiation-learning-lifecycle.md` + `docs/plan/2026-07-08-negotiation-learning-lifecycle/` + `docs/DESIGN.md`。生命周期转换遥测暂缓见 `docs/todo/deferred-backlog.md`。

**待办**：分支 `feat/negotiation-lifecycle` 待 merge 回 master（并发会话提交 schema.ts/state.ts 后，行级共存解冲突）；ui-v4 pre-existing typecheck 错 `EntrySummary.responsePreviewText` 属并发 history 会话漂移、非本特性。
