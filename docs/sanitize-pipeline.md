# 消息清洗管道（sanitize）

将客户端 Anthropic 请求清洗为上游可接受形态。是一条具体的 payload-level 请求改写，**不再作伞形动词**——被 v4 driver S3 经 codec 适配器包装（`src/lib/codec/anthropic/request-rewrite-adapter.ts`），web_search 双跳旁路独立复用。实现在 `src/lib/anthropic/sanitize/`，`index.ts` 是唯一对外 barrel。

## 子步骤

- **Tool blocks**：`tool-blocks.ts` 校验 tool_use/tool_result 配对、删孤儿；`deduplicate-tool-calls.ts` 去重；`tool-name-sanitize.ts` 配合顶层 `src/lib/tool-name-mapper.ts` 清洗非法/超长/冲突名（响应侧还原）。
- **内容块**：`content-blocks.ts` / `text-blocks.ts` 过滤空/空白块；损坏 thinking 块按 signature 有效性丢弃。
- **System**：`system-prompt.ts` / `system-messages.ts` / `system-reminders.ts` 处理顶层 system、inline `role:system` 消息、`<system-reminder>` 标签。
- **server tool 历史**：`rewrite-server-tool-history.ts` 降级残留 native server-tool block；`read-tool-result-tags.ts` 剥 Read 结果标签。

统计产出见 `result.ts`（`SanitizationStats`：orphan、fixedName、空块、损坏 thinking）。

详见 DESIGN.md「改写词汇」表与 anthropic 各 sanitize 配置项（运行时选项表）。
