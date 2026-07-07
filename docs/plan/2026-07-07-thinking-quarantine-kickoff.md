# Kick-off Prompt: thinking-quarantine 三层防治实施

复制以下内容开启新会话执行实施计划。

---

请实施 thinking「cannot be modified」400 三层防治。

**计划**：[docs/plan/2026-07-07-thinking-quarantine.md](docs/plan/2026-07-07-thinking-quarantine.md)（12 个 TDD task，分 3 phase）。
**规格**：[docs/spec/2026-07-07-thinking-signature-quarantine.md](docs/spec/2026-07-07-thinking-signature-quarantine.md)（v4.1，读「架构」「不变量」节）。
**PoC 实证**：[exp/thinking-signature-quarantine/README.md](exp/thinking-signature-quarantine/README.md)（根因=折叠后 assistant 消息内两个 thinking 块相邻；strip/交错/拆分行为全实测）。

**执行方式**：用 `superpowers:subagent-driven-development`——每 task 派新 subagent 实现、task 间两阶段 review。按 task 顺序（Phase 1→2→3，各 phase 独立可交付）。

**必读硬约束（Global Constraints，违反会自伤或功能失效）**：
1. **de-stack 是终末 sanitize pass**——必须在 `processToolBlocks` + `filterEmptyAnthropicTextBlocks` 之后（复审 #04 CRITICAL：放前面分隔符被后续删→thinking 重新相邻→400）。
2. **de-stack 严格幂等 + no-op 保序**（`resanitize` 每次 retry 重跑）；**合成分隔符非空非空白**（空/空格被上游 strip 掉、无效——实证）。
3. **L2/L3 反应式策略必须原生 env-strategy**（读 `env.ctx` 拿 session/agent），**不经 `adaptLegacyStrategy`**（它丢 env）。
4. **L3 主动 strip-all 排在 L1 de-stack 之前**（否则残留孤儿标记）。
5. **实现前读真实类型**：`src/lib/pipeline/types.ts`（`RetryAction`/`RequestEnvelope`/`EnvRetryStrategy`/`RequestRewrite` 成员）、`src/lib/history/sqlite/driver.ts`（`createDatabase` API）、`src/lib/codec/anthropic/strategies.ts`（策略注册）——计划里标注「以 X 为准」处对齐真实签名。
6. **测试隔离**：sidecar store 构造收 path 参数（DI），禁碰真实 `~/.local/share/copilot-api/`；用临时目录。
7. **工程纪律**：不启服务器、不 kill；显式 pathspec 提交、conventional commits、无模型署名；每 task 跑 `bun test <path>` + `bun run typecheck` + `bunx eslint <改动文件>`。

**收尾**（`session-closeout`）：三 phase 各自收尾跑绿既有 `tests/pipeline/payload-rewrite-registry.it.test.ts`（byte-lock）；全部完成后 subagent 独立复核 + doc-sync（spec 状态更新为 landed + DESIGN.md「活的架构现状」加行）+ 归档 plan。

先读计划 + 规格 + PoC，确认理解后从 Phase 1 Task 1 开始。
