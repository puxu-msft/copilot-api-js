---
name: methodology-prompt-cache-rate-diagnosis
description: 诊断代理 prompt-cache 命中率（history cache_read/input_tokens 跨同会话 turn + passthrough 热切对照）；GHC 缓存 messages 非仅 tools+system，上游认 message 断点
metadata: 
  node_type: memory
  type: reference
  originSessionId: 2b6050a0-bc91-45d0-aad1-60f50da65069
---

诊断 Anthropic 代理的 **prompt-cache 命中率**与隔离缓存策略缺陷的实测方法（2026-06-28 用此发现 proxied 默认模式丢对话缓存、并验证修复）：

**症状识别**：从 `/history/api/entries` 取**同一 sessionId 的多个 turn**，看 `usage.{input_tokens, cache_read_input_tokens, cache_creation_input_tokens}`。健康的对话缓存：`cache_read` 随对话**增长**、命中率高。**病态信号**：`cache_read` **跨 turn 冻结在固定值**（= 仅 tools+system 被缓存）、`input_tokens` 随对话增长全价计、命中率随会话变长**递减**（实测旧 proxied 长 agentic 会话仅 ~3%）。

**根因定位**：对比同一 entry 的 `inboundRequest`（客户端发的）vs `attempts[].wireRequest`（代理发上游的）里 `messages[]` 的 `cache_control` 断点数——客户端有、wire 无 = 代理剥掉了客户端的对话断点。

**隔离裁决（热切对照）**：`cacheControlMode` 可热重载（[[feedback-git-staging-and-local-commit-default-allowed]] 范畴的可逆改动）。在用户 config 加 `anthropic.cache_control: passthrough` 透传客户端断点，跑 2-3 个 agentic turn，观察 `cache_read` 是否跳升——实测 3%→**99.7%**、`input_tokens` 从 ~120K→**2**，一锤定音证明①上游认 message 断点②proxied 是元凶。测完删键还原。**注**：live server 跑的是旧代码，验证**新**代码用 exp 脚本 import 新源码喂真实 entry（绕开"live=旧码"+自洽测试两个盲点，见 [[methodology-golden-fixture-pre-capture]]/[[feedback-self-consistent-needs-independent-oracle]]）。

**REFERENCE 事实**（GHC 官方 `refs/github-copilot-chat/src/extension/intents/node/cacheBreakpoints.ts` 的 `addCacheBreakpoints`）：GHC 把 4 个断点**优先花在 message 历史**（每轮最后 tool_result + 当前 user 消息 + 终态 assistant），tools+system 只是**余位兜底**（`messagesApi.ts` 注释明确 message 断点隐式覆盖 tools+system）。"只缓存静态前缀"是错的——上游认 message 断点，缓存对话才是主收益。机制落地见 DESIGN.md `cacheControlMode` 行 + `request-preparation.ts` 的 `addMessageCacheControl`（移植自 GHC，role→block 映射：GHC `Tool`=含 tool_result 的 user 消息）。

**结局（2026-06-28）**：默认改为 `passthrough`（透传 CC 自带的好断点，实测 ~99%、最简、零代理插手）；`proxied` 修好后作 opt-in 给不自带 cache_control 的客户端（commit 4545474 + 默认切 passthrough 的后续 commit）。两者对 CC 都 ~99%。live 实证：重启后默认 proxied 时首轮 cache_creation=378729、次轮 cache_read=378729（99.0%）。

