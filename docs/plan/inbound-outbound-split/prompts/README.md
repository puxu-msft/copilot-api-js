# Prompts 导航：InboundCodec / CellAssembly 重构

per-commit self-contained kickoff。设计契约见 [../../rfc/2026-07-13-inbound-codec-outbound-leg-split.md](../../rfc/2026-07-13-inbound-codec-outbound-leg-split.md)（**§0.1 + §11 + §11.9 为权威**）,commit 锚点见 [../plan.md](../plan.md)。

## Commit 导航
| Commit | 内容 | 前置 | byte-critical |
|---|---|---|---|
| C0 | golden 预捕获（现有 79 + 补 3 条 byte golden）| 无 | **是（在改前 HEAD 锁）** |
| C1 | CellAssembly 接口 + 两穷尽 Record + resolveCellAssembly + hybrid shim（未接线）+ env.requestState | C0 | — |
| C2 | AnthropicCellAssembly + /v1/messages 腿 4 route 全切 | C1 | 是（direct 流式 + reverse 逐帧）|
| C3 | OpenAiCcCellAssembly + /chat 腿切 | C2 | 是 |
| C4 | OpenAiResponsesCellAssembly（+CC→Responses wire+ws）+ /responses 腿切 | C3 | 是（ws 终帧）|
| C5 | InboundCodec 收敛 + 删 registry/死方法 + shim 退化 | C4 | — |
| C6 | 清理 + gemini 命名剥前缀 + doc-sync | C5 | — |

## DAG（红线:严格串行,不可乱序/并行）
```
C0（预捕获,前置阻塞全部）──→ C1（骨架,未接线）──→ C2（/v1/messages 4-route 原子切）
                                                        │
                                                        ▼
                                          C3（/chat）──→ C4（/responses+ws）──→ C5（收敛）──→ C6（清理+命名+doc）
```
- **C2-C4 严格串行**：每个"原子切一个 cell + 同 commit 删该 cell 旧路径",hybrid shim 保证过渡期无双活。**不可并行**（共改 driver 派发点 + 同一批 handler）。
- **C2 是最大 diff**（4 route 同 commit lockstep）——若单 commit 太重无法保 typecheck 绿,可拆 C2a（direct anthropic）+ C2b（3 反向 @messages）,但 hybrid shim 须让"半迁"状态也无双活。

## 通用红线（各 commit 引用,见 plan.md R1-R5,不重复）
1. **R1**：绝不把 auto-truncate 当 clientFormat 标量（RETRY_SEMANTICS 读 env.targetEndpoint;responses-reverse cell auto-truncate ON、direct OFF）。
2. **R2**：请求生命周期稳定态住 `env.requestState`,绝不入 replace-semantics 的 prepareHints。
3. **R3**：betaProbe 惰性引用读,非 eager 快照。
4. **R4**：IT 真驱动装配器 + 负样本对照,绝不 strategies:[]/dry-run 绕过（Phase 7 教训）。
5. **R5**：转发客户端 SSE 逐字节 golden 硬 gate;上游 wire/history 用结构/GHC oracle。
6. **提取不重写**：C2-C4 原样搬算法核（plan.md factory 锚点表）,只改"谁持有+谁调"。
7. **no-destructive**：撤销自己编辑用重编辑;绝不删"无消费者"符号除非独立核实;no-auto-server、绝不 kill 4141、活服务器实测用隔离 XDG_DATA_HOME。
8. **细粒度 pathspec 提交**、无模型署名、并发 peer 行级共存、隔离 worktree（`.worktrees/`）。

## 通用必读
- RFC §0.1（三轮裁决）、§11（定稿 v2）、§11.9（v3 修订 + HIGH-A/HIGH-B 红线）。
- 前置翻译矩阵 RFC `2026-07-11-anthropic-via-openai-translation.md` §3.1（缝合模型二维门控）。
- skill `large-refactor`（RFC-first/commit invariant/golden 预捕获/批量工具箱/字节等价按消费者校准）、`empirical-verification`、`verifying-authoritative-claims`。

## per-commit kickoff 增量产出
C0 已就绪可写为首个 self-contained prompt;后续 commit 在推进到该阶段前展开（避免一次性写全、上下文腐化）。每个 prompt 骨架（`large-refactor` §5）：背景+为什么 / 必读 / 目标+改动锚点（factory file:line 表）/ TDD 步骤 / 验收 gate（byte-critical golden 逐字节）/ 提交指引（精确 pathspec）/ 红线（引用本 README）。
