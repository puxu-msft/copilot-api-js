---
name: methodology-content-addressed-normalization-boundary-strip
description: 内容寻址哈希的归一化方法论——config-无关 canonical 投影、剥易变样板用 own-line 边界锚定而非全局正则（inline 字面提及须存活）、易变清单靠真实数据实测枚举
metadata:
  type: project
---

把结构化数据（消息）做内容寻址去重（git-blob 式 hash→存一次）时，归一化投影的三条方法论。落地 `src/lib/history/normalize-message.ts`（search_index）。

**① 哈希投影必须 config-无关、确定、稳定，且哈希输入 == 存储搜索文本（单一投影）。** 同消息恒同输出，与运行时 config 无关——**绝不**复用 config 驱动的清洗函数（`removeSystemReminderTags` 读 `state.rewriteSystemReminders`、默认 no-op → 投影随 config 变 + 跨运行不稳）。canonical = 递归剥易变 key（`cache_control`，Claude Code 每轮前移 ephemeral 断点的唯一易变源——实测两连续请求同消息仅此一处差、剥后字节相等）+ sorted-key JSON（key 序无关）。

**② 剥注入样板用 own-line 边界锚定正则，绝不用全局 `<tag>.*</tag>`。** 真实 transcript 含**合法 inline 字面提及**同名标签（如文档讨论 `<system-reminder>`/`<ide_opened_file>`——本会话的 meta 数据实测 9 处 inline vs 1 处结构注入）。全局正则会误删这些真内容。正解：`(?:^|\n)[ \t]*<tag>...lazy...</tag>[ \t\r]*(?=\n|$)`——只匹配自起一行+自终一行的结构块，inline backtick 提及（行中、无 own-line 闭合）天然不匹配。**坑**：边界要容 `\r`（CRLF transcript 否则漏剥→该块进哈希→每轮 re-hash）。

**③ 易变子串清单靠真实数据实测枚举，不靠想象。** 从运行中后端 `/history/api/entries/:id` 拉真实消息（skill `empirical-verification`），取**同 session 连续两请求**对比哪些字段每轮变（cache_control 位置/ide_*/cwd/turn-counter）。漏一种→该类消息每轮 re-hash、去重退化、悄悄 bloat。安全网=dedup-ratio tripwire（见 [[methodology-recoverable-backfill-cooperative-stop-and-keyset]] ④）。**实测点须用 history 存储后的消息形状**（经 `any`-typed content round-trip，非 live sanitize 输入）。

**④ 测试要独立 oracle，自洽抓不到。** 同消息含/不含 cache_control 哈希相等的 golden 取**真实连续两请求**实测 pair（非合成）；config 切 true/false 哈希不变证 config-无关；inline 字面提及保留证 own-line 锚定正确。
