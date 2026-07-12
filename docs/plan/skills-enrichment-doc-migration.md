# 充实 skills + 迁移合适文档进 skill

> **实施状态：已完成**
> **落地**：—
> **现状锚点**：`.claude/skills/`（proxy-api-reference/history-sqlite-schema/debugging-ghc-api-upstream-transport/test-isolation/ghc-anthropic-upstream）
> **备注**：5 个 skill 全建（anthropic-debug 换名 ghc-anthropic-upstream）；bun-runtime-timeout.md 已 MOVE 进 skill

## Context

已建 proxy-api-reference / history-sqlite-schema 两个薄 skill。用户要：大幅充实现有 skill、把"方法/调试/陷阱"型文档迁进 skill，活文档仍留 docs。skill 引用活文档、不重复其字段级真相；只吸收调试/经验/速查。

## 分诊（已与用户敲定）

判据：**开发/调试/陷阱/速查 → skill；决策/架构/特定设计/上游兼容 → docs**。skill 引用活文档、不重复字段级真相。

- **REFERENCE**：DESIGN 路由表、history.md、各 compat/pipeline/streaming/auth 模块文档 → 留 docs，skill 指过去。
- **DUPLICATE**：端点表、schema 表紧凑速查留 skill。
- **MOVE**：bun-runtime-timeout.md → skill。
- **新建**：anthropic-debug、test-isolation。

## 1. 充实现有两 skill

- proxy-api-reference：补管理 API 子端点、Azure/前缀矩阵、调用示例（curl + 探针），指 `/openapi.json`。
- history-sqlite-schema：补查询配方（按 session/status 过滤、解 blob_gz）、reaper 桶语义、in-flight 双源、debug-pin，指 history.md。

## 2. MOVE：debugging-ghc-api-upstream-transport skill ← bun-runtime-timeout.md

迁内容到 `.claude/skills/debugging-ghc-api-upstream-transport/SKILL.md`（300s 陷阱 / undici 子路径 / node:http2 / keepalive ss 验证），`mv` 删 docs。repoint 3 处反向引用：DESIGN.md 模块表+transport 行、spec/upstream-http2-transport.md、memory/feedback-bun-first-dependency-selection.md。

## 3. 新建 anthropic-debug skill

聚合 thinking 中毒/refusal/tool-call 降级/server-tool/id 容忍 + 探针手法，REFERENCE 6 条 memory（thinking-empty-plaintext-poison、thinking-signature-self-contained、ghc-tool-call-text-downgrade、empirical-probe-via-history-api、upstream-tool-use-id-format-tolerant、project_thinking_shim）+ docs/refusal-recovery.md/anthropic-compat.md。

## 4. 新建 test-isolation skill

useIsolatedRuntime / RESETTERS / sandbox-paths preload / 后缀分层速查，指 docs/spec/test-env-isolation.md + DESIGN「测试组织」。

## 验证

skill description 各 grep；死链归零（mv 后 repoint 全覆盖）；改 .md 免 typecheck；细粒度提交；subagent review。
