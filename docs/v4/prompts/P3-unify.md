# P3 — 统一收尾实现提示词

复制以下内容到新会话启动 P3 实现。

---

我要实施 copilot-api-js 管线重构 v4 的 **P3 阶段（统一收尾）**。所有格式已切到 driver（P2 完成），现在统一透传判断、下沉数据采集、删除旧 handler、收束单一事件通道。**等价切换，不改外部行为**。

> **⚠️ 前置自检（粘贴后第一件事：先读 `docs/v4/05-progress.md` 顶部「当前位置」）**：P3 要求 **P2.4/P2.5/P2.6（Responses/Gemini/Anthropic 切 driver）全部完成且逐格式 flag 已翻 ON**。若 05-progress 显示它们仍 ⬜——**你在 P2 阶段，不是 P3**，应改做下一个未完成的 P2.x（粘 `P2-driver-and-codecs.md`），**立即停止 P3**。P3.1 需 4 codec 的 decideRoute 齐、P3.3 会删仍在用的 handler，过早执行 = 危险不可逆。
>
> **排程重排（2026-06-17，详见 04-migration-plan「排程重排」+ 05-progress「P2.3 收尾排程」）**：原 P3.2「driver 加采样」半已**提前到各格式迁移点**（CC=P2.3-S）完成。故下面 **P3.2 实为 P3.2b（删剩余 handler 手动 setter）**；若到 P3 时某格式采样尚未提前落地，则该格式的「driver 加采样 + 删 setter」在此一并补做。

**前置**：P2 全部格式完成且验证无回归（逐格式 flag ON、L1 行为等价 ∧ L2 记录等价均过）。
**先读**：
- `docs/v4/01-architecture.md` §6（透传统一）
- `docs/v4/03-spec/codec.md` §2（decideRoute 统一矩阵 + 3 非一致默认）、`envelope-driver.md` §4（自动采样）
- `docs/v4/02-current-state.md` §4.2-4.3（4 处散点）、§5.3-5.4（采集散点 + 双轨字段）
- `docs/v4/04-migration-plan.md` 的 P3 表 + 「排程重排」note
- 遵守 `docs/v4/prompts/README.md` 通用红线

**四个 commit**：

### P3.1 — 透传判断统一进 decideRoute
现状 4 处散点（messages:165 / cc:305 / responses:138 / responses/ws:202）+ Gemini 无 gate（`02 §4.2`）。全部收进各 codec 的 `decideRoute`（`codec.md` §2）。**显式保留 3 个非一致默认**（写进实现注释，不静默改变）：
- `isEndpointSupported` 缺 supported_endpoints → true
- `isWsResponsesSupported` 缺 → false
- Gemini 无条件翻 CC
- Responses force-list（Google）绕过 CC 检查

invariant：**表驱动测试覆盖 (接入格式 × 模型 supported_endpoints) 全矩阵** → RouteDecision 等价。删除散落在 handler 的旧判断分支。

### P3.2b — 删各 handler 残留手动 setter（driver 采样已逐格式提前）
**重排后此步只剩删 setter**：driver 加采样（P3.2a）已在各格式 P2.x-S 提前落地。删除各 handler 残留的手动 `setSseEvents`/`setForwardedResponse`/`setAttemptWireRequest`/`setOriginalRequest`/`setInboundRequestHeaders`/`setHttpHeaders`/`recordStreamProgress`/`recordFeature`/`setPipelineInfo` 调用（`02 §5.3` 手动散点清单中尚未随各格式 P2.x-S 删除的剩余部分）。若某格式采样未提前，则在此一并做「driver 加采样 + 删 setter」（envelope-driver §4）。invariant：**所有格式都记上游原始 sseEvents + 客户端 forwarded + per-attempt 双轨**（补齐现状"仅 messages"缺口）；`/history/api/entries/:id` 字段集不变；前后 history entry fixture 对比一致。


### P3.3 — 删旧 handler + flag + 死代码
删除所有旧 `handler.ts` 巨型编排、feature flag、并存分支。用 `refactor-cleaner` agent / `knip` / `ts-prune` 验证无悬空导出。保留并复用的：`sanitize/translate/convert/request-preparation`（codec/registry 内部实现）、`fetch-utils/proxy/adaptive-rate-limiter/stream/upstream-ws`（transport）、`observability/history`（基本不动）。invariant：全测试绿、knip 无悬空、`bun run typecheck` 绿。⚠️ 删除前用 subagent 复核"无消费者"断言，亲自核对关键文件 file:line（别信单方声称）。

### P3.4 — 更新 DESIGN.md
更新 `docs/DESIGN.md` 的"请求流程""核心模块"章节指向 v4 七阶段管线（driver/codec/registry/transport 结构），移除已删除模块的描述。invariant：文档与代码一致。

**完成后**：更新 `05-progress.md` P3 表，标记整体重构完成。最终全套 subagent review（factual/senior-engineer/security/consistency 多视角）。

**关键坑**：
- P3.3 删除是不可逆的高风险操作——**绝不**用 `git checkout/rm` 误删未提交改动（no-destructive-workspace-loss；git 破坏性操作由 settings.json ask 强制）。删除前确保所有要保留的逻辑已迁移并测试覆盖。
- 三大能力守卫每 commit 必过：`/history/api/entries/:id` 全量双轨、`/api/logs`+`/api/status` 形状、WS wire 协议。
- 透传矩阵的 3 非一致默认是**有意行为**，不是 bug——统一时保留，别"顺手修正"成一致（会改变路由行为，scope-ambiguity-then-ask：范围外先问）。
- 数据采集下沉后，accumulator 降为 sink 内部状态——确认 `outboundResponse`(上游原始) 与 `inboundResponse`(客户端实收) 双轨重建正确。
