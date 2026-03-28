# 04 — 测试文件名对齐（P1）

## 问题

测试文件命名不一致。部分按被测**源文件**命名（如 `error.test.ts` → `lib/error.ts`），
部分按被测**功能概念**命名（如 `copilot-headers.test.ts` → `lib/copilot-api.ts` 中的某个函数）。

这导致：
- 无法通过文件名快速定位测试与源的对应关系
- 源文件拆分后，测试文件是否需要跟随拆分不明确
- 新开发者不知道某个源文件的测试在哪里

## 命名规范

**规则**：测试文件名镜像源文件路径。

```
src/lib/foo.ts                    → tests/unit/foo.test.ts
src/lib/bar/baz.ts                → tests/unit/bar/baz.test.ts（如需子目录）
src/lib/bar/baz.ts（子功能）      → tests/unit/bar-baz-xxx.test.ts（加后缀区分）
```

## 确认的错位列表

| 当前测试文件 | 实际测试的源文件 | 建议名称 |
|-------------|-----------------|---------|
| `copilot-headers.test.ts` | `lib/copilot-api.ts` | `copilot-api.test.ts` |
| `system-prompt-manager.test.ts` | `lib/config/config.ts` | `config-rewrite-rules.test.ts` |
| `dedup-tool-calls.test.ts` | `lib/anthropic/sanitize.ts` | `anthropic-sanitize-dedup.test.ts` |
| `strip-read-tool-result-tags.test.ts` | `lib/anthropic/sanitize.ts` | `anthropic-sanitize-tags.test.ts` |
| `message-sanitizer.test.ts` | `lib/anthropic/sanitize.ts` | `anthropic-sanitize.test.ts` |
| `server-tool-rewriting.test.ts` | `lib/anthropic/server-tool-filter.ts` | `anthropic-server-tool-filter.test.ts` |
| `response-utils.test.ts` | `lib/request/response.ts` | `request-response.test.ts` |
| `rewrite-rule.test.ts` | `lib/config/config.ts` | 合并入 `config-rewrite-rules.test.ts` |
| `system-reminder.test.ts` | `lib/sanitize-system-reminder.ts` | `sanitize-system-reminder.test.ts` |

## 已正确命名的测试（无需改动）

| 测试文件 | 源文件 |
|----------|--------|
| `error.test.ts` | `lib/error.ts` |
| `anthropic-features.test.ts` | `lib/anthropic/features.ts` |
| `auto-truncate-common.test.ts` | `lib/auto-truncate/index.ts` |
| `error-persistence.test.ts` | `lib/context/error-persistence.ts` |
| `fetch-utils.test.ts` | `lib/fetch-utils.ts` |
| `history-ws.test.ts` | `lib/history/ws.ts` |
| `message-mapping.test.ts` | `lib/anthropic/message-mapping.ts` |
| `orphan-filter-openai.test.ts` | `lib/openai/orphan-filter.ts` |
| `proxy.test.ts` | `lib/proxy.ts` |
| `recording.test.ts` | `lib/request/recording.ts` |
| `repetition-detector.test.ts` | `lib/repetition-detector.ts` |
| `sanitize-openai.test.ts` | `lib/openai/sanitize.ts` |
| `tui-format.test.ts` | `lib/tui/format.ts` |
| `utils.test.ts` | `lib/utils.ts` |

## 与 01-oversized-files.md 的协调

如果 P0 先执行（拆分大文件），部分测试文件可能需要跟随拆分：

- `anthropic/sanitize.ts` 拆分为 4 个文件后，`message-sanitizer.test.ts` 应按新文件结构拆分
- `error.ts` 目录化后，`error.test.ts` 可能需要拆分为 `error/http-error.test.ts` 等

**建议**：P0 拆分源文件时同步调整测试文件命名。04 的执行时机与 01 协调。

## 验证

- [ ] 所有重命名后 `bun test tests/unit/` 通过
- [ ] 无遗漏（每个源文件至少有一个同名测试文件）
