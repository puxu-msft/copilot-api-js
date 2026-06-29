# 遗留代码与未迁移模块审计报告

> 审计日期：2026-05-20
> 审计范围：`src/`、`ui/`、`tests/`、`docs/`、`config.example.yaml`
> 审计方法：grep（`@deprecated`、`TODO/FIXME`、命名 legacy/old）、目录结构对比、文档与代码核对、孤儿文件检测、重复模块识别

---

## 摘要

| 类别 | 数量 | 风险 |
|---|---|---|
| 已有替代但 config 仍接收的旧字段 | 2 | 低（带 eslint-disable 兼容） |
| 已抽象但保留兼容别名的运行时 API | 2 | 低（仅 1 处内部调用，可立即切换） |
| 文档严重过时（描述已删除的模块、错误的文件路径） | 11 | **中** — 误导新人 |
| 重复/同名并存的模块结构 | 4 | 低（实际是 facade，但容易混淆） |
| 残留的设计概念（描述被 SQLite 取代的内存存储） | 3 | 中 — config + 文档 |
| 旧的 UI 路由（已重定向但未清理） | 11 | 低 — 主动保留为书签兼容 |
| `docs/archive/` 已正确归档 | 10 个项目 | 已处理 |
| 历史规划文档（superpowers/plans）描述未来已完成的工作 | 2 个目录 | 低 |

---

## 类别 A：已迁移但旧接口仍保留（向后兼容层）

> **更新 2026-05-21**：A1、A2、A3 三个字段类型已**移除**；现在通过原始 YAML 读取以便检测旧配置，**每进程仅 warn 一次**（不再每请求 warn）。详见 [src/lib/config/config.ts](src/lib/config/config.ts) 的 `warnDeprecatedKeyOnce` + `readDeprecated`。

### A1. `anthropic.immutable_thinking_messages` → `thinking_block_message_policy`（已删除类型，保留 warn）

### A2. `anthropic.auto_cache_control` → `cache_control`（已删除类型，保留 warn）

### A3. `history.min_entries`（已删除类型，保留 warn — 完全弃用，无替代）

---

## 类别 B：内部 API 已重命名，兼容别名残留

### B1. `createContextManagementRetryStrategy` → `createBodyFieldRejectionStrategy`

| 项 | 位置 |
|---|---|
| 旧别名 | [src/lib/request/strategies/context-management-retry.ts:117](src/lib/request/strategies/context-management-retry.ts#L117) `@deprecated` |
| 新名称 | 同文件 line 65 `createBodyFieldRejectionStrategy` |
| 现有调用 | [src/routes/messages/handler.ts:218](src/routes/messages/handler.ts#L218) **已切换到新名** |
| 测试调用 | [tests/unit/context-management-retry-strategy.test.ts](tests/unit/context-management-retry-strategy.test.ts) 仅测试别名等价性 |

**建议**：可立即删除别名 + 删除测试中"alias preserved"用例。**唯一外部使用者已迁移。**

### B2. `parseContextManagementExtraInputsError` → `parseExtraInputsError`

同上，仅在测试中使用以验证兼容性。可一并移除。

### B3. 文件名 `context-management-retry.ts` 名实不符

文件名仍叫 `context-management-retry.ts`，但内容已是通用 `body-field-rejection-retry`。
**建议**：rename 文件 + 更新 import。1 个 import + 1 个测试 import。

---

## 类别 C：文档严重过时

文档与实际代码出现明显偏差，**这是最大的负债**——会误导新人和后续 AI/agent 操作。

### C1. `docs/DESIGN.md` 提到不存在的文件

| 文档中 | 实际状态 |
|---|---|
| `src/lib/anthropic/handlers.ts` | 不存在。实际是 [src/routes/messages/handler.ts](src/routes/messages/handler.ts) |
| `src/lib/sanitize-system-reminder.ts` | 不存在。功能在 [src/lib/anthropic/sanitize/system-reminders.ts](src/lib/anthropic/sanitize/system-reminders.ts) |

### C2. `docs/history_实施状况.md` 引用已删除的模块

[docs/history_实施状况.md:46](docs/history_实施状况.md#L46) 仍声称 `src/lib/history/memory-pressure.ts` 实现 LRU 淘汰 — 但该文件已被 [docs/superpowers/plans/2026-04-17-sqlite-history-persistence.md](docs/superpowers/plans/2026-04-17-sqlite-history-persistence.md) 中描述的 SQLite 迁移彻底删除。

文件修改时间对比：
- `docs/history_实施状况.md`: 2026-04-17（迁移前）
- `src/lib/history/sqlite/connection.ts`: 2026-05-20（迁移后）

**建议**：删除或重写整个 `_实施状况.md`，描述当前的 SQLite + in-flight 双层架构。

### C3. 大量 `_实施状况.md` 文件可能全部过期

| 文件 | 最近修改 | 风险 |
|---|---|---|
| `docs/anthropic-compat_实施状况.md` | 2026-04-17 | 中 |
| `docs/authentication_实施状况.md` | 2026-04-17 | 低（认证变化少）|
| `docs/history_实施状况.md` | 2026-04-17 | **高**（已确认过时）|
| `docs/model-resolution_实施状况.md` | 2026-04-17 | 中 |
| `docs/request-pipeline_实施状况.md` | 2026-04-17 | **高**（pipeline 已重构）|
| `docs/sanitize-pipeline_实施状况.md` | 2026-04-17 | 中 |
| `docs/shutdown_实施状况.md` | 2026-04-17 | 低 |
| `docs/snippets_实施状况.md` | 2026-04-17 | 未知 |
| `docs/streaming_实施状况.md` | 2026-04-17 | 中 |
| `docs/260324-fixes_实施状况.md` | 2026-04-17 | 已完成的 fix tracking |
| `docs/SECURITY_RESEARCH_MODE_实施状况.md` | 2026-04-17 | 未知 |

**建议**：评审每一个 `_实施状况.md`。它们最初是用于跟踪某次审查的实施进度——任务完成后应**归档到 `docs/archive/`** 或**删除**。这种 "_实施状况" 命名表明这些是**临时文档**而非长期参考。

### C4. `docs/archive/2603-webui/README.md` 描述的 Legacy + Vuetify 双 UI

archive 中明确描述了**旧的双 UI 架构**（"Legacy 路由" + "Vuetify 路由"），现在仅剩 Vuetify（[ui/CLAUDE.md](ui/CLAUDE.md) 确认）。
**状态**：已归档，但 [ui/src/router.ts:40-51](ui/src/router.ts#L40-L51) 11 条 `/v/*`、`/history`、`/logs`、`/usage` 重定向仍指向曾经的 Legacy 路径——这是为外部书签兼容性主动保留。

**建议**：在 router 中加块注释说明"这些是 v1 webui 时代的路径，仅为外部书签保留"。如果有遥测发现已无访问，可逐步删除。

---

## 类别 D：模块结构存在容易混淆的"同名并存"

这些**不是 bug**，但读源码时容易困惑。

### D1. `anthropic/auto-truncate.ts` 文件 vs `anthropic/auto-truncate/` 目录

```
src/lib/anthropic/
├── auto-truncate.ts          # 401 行，主入口
└── auto-truncate/            # 子模块
    ├── token-counting.ts     # 工具函数
    ├── tool-utils.ts
    └── truncation.ts
```

`auto-truncate.ts` 协调子模块，子模块文件提供 helpers。Node 模块解析时 `./auto-truncate` 优先匹配 `.ts` 文件，所以没有歧义，但目录结构看着不对称。

OpenAI 端 [src/lib/openai/auto-truncate.ts](src/lib/openai/auto-truncate.ts) + [src/lib/openai/auto-truncate/](src/lib/openai/auto-truncate/) 同样模式。

**建议**：要么把 `auto-truncate.ts` 改名为 `auto-truncate/index.ts`（标准 barrel 模式），要么不动但在 CLAUDE.md 加说明。

### D2. `anthropic/sanitize.ts` 文件 vs `anthropic/sanitize/` 目录

同 D1 模式。`sanitize.ts` 是 orchestrator + re-export。OpenAI 端只有 `sanitize.ts` 一个（无子目录），不对称。

### D3. `lib/error.ts` 是单行 barrel 转发到 `lib/error/`

[src/lib/error.ts](src/lib/error.ts) 仅一行：
```ts
export * from "./error/index"
```
单纯为了维持 `~/lib/error` 这个 import 路径不变。实际代码在 `lib/error/{classify,forward,http-error,parsing,utils}.ts`。

同样情况：[src/lib/system-prompt.ts](src/lib/system-prompt.ts) → `lib/system-prompt/`。

**建议**：保留。这是合理的 facade，迁移完成的标志。

### D4. `anthropic/request-preparation.ts` 单文件 539 行

虽然不算"遗留"，但文件已涵盖：buildWirePayload、adjustThinkingBudget、clampEffortLevel、applyCacheControlMode（带递归 walker）、filterUnsupportedBetas、effort 学习等。

**建议**：考虑拆分为 `anthropic/request-preparation/` 子目录，每个 concern 一文件。

---

## 类别 E：被 SQLite 取代但概念残留

### E1. `history.min_entries` 配置（见 A3）

### E2. `docs/history.md` 文档表述已更新但其他 markdown 散落旧表述

- [docs/DESIGN.md](docs/DESIGN.md) 已更新到 SQLite 架构 ✓
- [docs/history.md](docs/history.md) 已更新到 SQLite ✓
- `docs/*_实施状况.md` 大量仍描述内存存储（见 C2、C3）

### E3. `historyState` 模块中的内存映射字段

[src/lib/history/in-flight.ts](src/lib/history/in-flight.ts) 仍维护内存 Map，**这是有意的**——存"进行中"请求供 WebSocket 推送，已完成的才落 SQLite。这是新架构的一部分，不是遗留。

---

## 类别 F：孤儿与未引用代码

通过 grep 检查后**未发现**真正孤儿。早期误报（`refresh-loop`、`consumers`、`proxy`、各 routes）都在 `start.ts`、`server.ts`、`routes/index.ts` 中正常注册。

---

## 类别 G：测试目录有大量代码风格债（已分析过）

| 项 | 数量 |
|---|---|
| `tests/component/history-store.test.ts` | 79 lint 错误 |
| `tests/component/stream-accumulator.test.ts` | 72 |
| `tests/component/request-context.test.ts` | 49 |
| 其他 60+ 文件 | 共 ~440 余 |

**不是"遗留"**，但与"未迁移"相关：很多测试是早期写的，与现行严格 lint 规则冲突。详见上一轮报告中的 C1/C2 分类。

---

## 推荐处理顺序

### 立即可做（低风险）

1. **删除 [src/lib/request/strategies/context-management-retry.ts](src/lib/request/strategies/context-management-retry.ts) 中 2 个 `@deprecated` 别名** + 相关测试用例 — 唯一调用者已迁移
2. **重命名 `context-management-retry.ts` 文件 → `body-field-rejection-retry.ts`** — 名实统一
3. **删除 `history.min_entries` 字段定义** — 仅保留 warn

### 中期（文档清理）

4. **评审 11 个 `_实施状况.md`** — 归档完成的、删除过时的、保留尚有效的
5. **修正 [docs/DESIGN.md](docs/DESIGN.md)** 中的两处错误文件路径（C1）
6. **更新 [docs/history_实施状况.md](docs/history_实施状况.md)** 或直接归档（C2）
7. 在 [ui/src/router.ts](ui/src/router.ts) 的 legacy redirects 上加详细注释说明保留原因

### 长期（架构整理）

8. **拆分 [anthropic/request-preparation.ts](src/lib/anthropic/request-preparation.ts)** — 539 行单文件偏大（D4）
9. **统一 `auto-truncate.ts` 与 `auto-truncate/` 命名约定** — 改为 `auto-truncate/index.ts` 标准 barrel（D1）
10. **统一 `sanitize.ts` 与 `sanitize/` 命名约定**（D2）
11. **决定 `_immutable_thinking_messages` / `auto_cache_control` 配置兼容窗口** — 选定移除版本

### 保留不动（已确认）

- `ui/src/router.ts` 的 11 条 legacy redirects（外部书签兼容）
- `lib/error.ts` / `lib/system-prompt.ts` 单行 barrel（facade pattern）
- `in-flight.ts` 内存映射（新架构组成部分）
- `docs/archive/` 内容（已正确归档）

---

## 附录：扫描方法

| 维度 | 命令 |
|---|---|
| 显式弃用标记 | `grep -rn "@deprecated" src/` |
| TODO/FIXME | `grep -rEn "TODO\|FIXME\|HACK"` |
| 命名暗示 | `find -name "*legacy*" -o -name "*old*" -o -name "*-v[0-9]*"` |
| 文档/代码一致性 | `comm` 比对 `docs/DESIGN.md` 中文件路径 vs 实际 |
| 文件时间 | `date -r <file>` 对比相关源码修改时间 |
| 重复实现 | `find -name "<base>.ts" -o -name "<base>"` 配合目录列表 |
| 孤儿检测 | 遍历 `src/**/*.ts`，逐个 grep 其他文件是否 import |
