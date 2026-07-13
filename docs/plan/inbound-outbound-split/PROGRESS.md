# PROGRESS ledger：InboundCodec / CellAssembly 重构（C0-C6）

> durable 进度账本（抗 compaction / 跨会话）。权威设计见 [RFC §0.1+§11+§11.9](../../rfc/2026-07-13-inbound-codec-outbound-leg-split.md)，锚点见 [plan.md](plan.md)，per-commit prompt 见 [prompts/](prompts/)。

隔离 worktree：`.worktrees/inbound-outbound-split`，分支 `feat/inbound-outbound-split`（从 master `e9f6ce8a` 切出）。

## 基线（改动前 master）
- backend：**4661 pass / 1 skip / 5 fail**。5 fail = 4× `request-rewrite migration golden (codec.parse → driver S3)`（peer-D2 pipelineInfo）+ 1× `/api/negotiation > GET / returns grouped snapshot`。第 6 条 base 例外（UI shell 404）在前端 `test:ui`，不在 backend。
- 全局 invariant：每 commit 后 fail 数必须仍**恰为这 5 条**（不多不少），typecheck 0。

## Commit 进度
| Commit | 状态 | 备注 |
|---|---|---|
| C0 golden 预捕获 | ✅ **已提交**（本会话 inline） | 4 条 byte golden，全量 4665 pass / 5 fail（base 不变）。见下 |
| C1 骨架 | ✅ **已提交**（本会话 inline） | cell-assembly.ts + request-state.ts + env.requestState + 4 codec 穿线 + L1 守卫测试。全量 4669/5 fail。**未接线零行为变化**。见下 |
| C2 AnthropicCellAssembly | ✅ **完整完成** | C2-prep + C2a.1 + **C2a**（direct fork + pipelineInfo 经 ctx）+ C2b.1（去重）+ **C2b**（3 反向 cell + R1 corner）**全已提交**。**整条 /v1/messages 腿（4 cell：anthropic direct + cc/responses/gemini 反向）迁移到 CellAssembly、driver cell-keyed fork 双向证成、字节等价、全量 base 5**。dead code（codec direct/reverse 分支 + handler MESSAGES 供料）推迟 C5|
| C3 OpenAiCcCellAssembly | ⬜ 待做 | /chat/completions 腿（cc direct + anthropic/gemini 前向 @cc）迁移，复用 C2 已证成的 fork 模式 |
| C3 OpenAiCcCellAssembly | ⬜ | /chat 腿切 |
| C4 OpenAiResponsesCellAssembly | ⬜ | /responses+ws 腿切 + R1 corner |
| C5 InboundCodec 收敛 | ⬜ | 删 registry 死方法 + shim 退化 |
| C6 清理 + 命名 + doc | ⬜ | gemini 剥前缀 + DESIGN.md + 记忆 |

## C0 交付（4 条 byte golden，逐字节 `.toBe`/`.toEqual`，改前 HEAD 锁，确定性 5×）
- (a) `tests/anthropic/c0-live-anchored-direct-stream-golden.http.test.ts` — live-anchored keepalive-ON direct /v1/messages 流：cold-start ping → 合成 message_start → anchor@0(start+empty delta) → commit close-off stop@0 → 真实块 remap +1 → 终帧。归一化合成 id（FakeClock-time + 全局 reqId 计数器）。
- (b) `tests/openai/c0-reverse-cc-messages-forward-golden.http.test.ts` — cc `@messages` 反向腿经 HTTP app，上游 Anthropic SSE → 转发 CC 逐帧。归一化 `created` epoch。
- (c-ws) `tests/responses/c0-ws-terminal-golden.http.test.ts` — Responses WS 转发消息对象逐帧（含终帧 response.completed）+ 1000/done 关闭。
- (c-gemini) `tests/gemini/c0-via-responses-stream-terminal-golden.http.test.ts` — gemini `:streamGenerateContent` via Responses 两跳终帧（保护 C4/HIGH-1 hub 提取 renderResponsesFrameToCc+createStreamTranslator）。

## C1 交付（契约 + 穷尽 Record + env.requestState，未接线零行为变化）
- `src/lib/pipeline/cell-assembly.ts`：`RETRY_SEMANTICS`（Record<ClientFormat,(env)=>RetrySemanticsSpec>，语义半读 env.targetEndpoint = R1/HIGH-A）+ `OUTBOUND_LEGS`（Record<UpstreamEndpoint,OutboundLeg>，wire 半）两穷尽 Record（占位 throw）+ `resolveCellAssembly` 组合 + `MIGRATED_LEGS` 空集/`isLegMigrated`（具名 hybrid shim，C2+ 逐腿增长、C5 断言全集）。
- `src/lib/pipeline/request-state.ts` + `env.requestState`（readonly，R2/HIGH-B）：请求生命周期稳定供料（truncateBaseline/resanitize/共享可变 betaProbe/anthropic-beta 种子）与 model 同级、`with()` 保留引用、独立于 replace-semantics 的 prepareHints；穿过 4 codec makeEnvelope/with（各 4 行，C2+ 由 parse 设值）。
- `tests/pipeline/cell-assembly.unit.test.ts`：L1 存在性守卫（全 cell resolve 正确轴 / Record 运行时也全 / C1 无腿迁移 / 占位 throw 响亮）。C2-C4 逐 cell 加「buildStrategies 非空」。
- **C1/C2 边界偏离**：RFC 字面 C1 含 driver hybrid shim，但我把 **driver hybrid fork 推迟到 C2**（与首个 live assembly 同 commit 引入 → fork 立即被 golden 覆盖，`large-refactor`「过渡态显式无害」），C1 保持纯追加零 driver 改动、trivially 字节等价。不破坏 RFC 不变量（MIGRATED_LEGS 具名 / C2→C4 增长 / C5 断言收敛）。
- **review 分层决策**：C1 是未接线契约（typecheck 验证 + 测试绿 + 忠实转录已过两轮对抗 review 的 RFC §11.2/§11.3/§11.9），按 `tiered-review-by-risk` 把 C1 独立 review **并入 C2 后的批量 review**（契约 + 首个 live 消费者一起审，更能抓集成缺陷）。

## 执行期实测发现（对后续 commit 重要）
- **base 有第 6 条间歇 flake（非确定性）**：`request payload logging > logs OpenAI payload diagnostics ...`（`tests/pipeline/request-payload.unit.test.ts:67`）在**全套件高负载**下偶发 `timed out after 5000ms`（该测试做重 token 估算 ~5-6s，贴近默认超时）；隔离 3/3 + heavy-context 3/3 + 部分全量跑均通过。**与本重构无关**（anthropic-leg 纯移动提取时首次撞见，多轮实测证伪归因）。后续全量跑见 fail=6 且第 6 条是它 → **忽略/重跑**，别当回归；理想 fix 是给该测试显式更大 timeout（未做，避免 scope creep）。
- **reverse @messages 经 HTTP app 从没被字节测过**（无 `.http.test.ts` 用 `@messages`）。经 cc 路由时，`processOpenAIMessages` **无条件** `applyConfigToState()` 重载磁盘 config 并重应用 disabled_models 过滤（`src/lib/system-prompt/override.ts:132`）；而 `processAnthropicSystem` 无 system 时提前 return、不重载。**后果**：cc `@messages` 反向腿要求 model 挺过这次重载（否则 router 的 `supportsDirectAnthropicApi` 在 index 被清后返 vendor unknown → 400）。golden (b) 用 `claude-opus-4.8`（未被 bundled config disabled）。C2 不改 router/model-resolution 时序，此项**out of scope**，但记录以防误判。
- 实测环境 `loadConfig()` 的 disabled_models 含用户真实模型（`gpt-4o`/`claude-sonnet-4-5` 等长列表，疑测试隔离对 config 文件不完全沙箱化）——但对所有既有测试一致、不阻塞；用 disabled 列表外的 `claude-opus-4.8` 规避。
- **gpt-souls agent 底座当前不可用**：派 `gpt-souls:implementer` 报 `400 Model "gpt" does not support /v1/messages: vendor is unknown, not Anthropic`（proxy 把 gpt 路由到 /v1/messages 被拒——正是本重构要修的 bug 类）。C0 改为主会话 inline。C2-C4 计划用 Claude general-purpose 实现 + 独立 Claude reviewer 对抗（gpt 底座故障期替代）。
