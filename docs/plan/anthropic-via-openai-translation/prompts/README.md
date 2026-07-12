# Prompts 导航：通用翻译矩阵实施

per-phase self-contained kickoff 提示词。实现者按 phase 顺序取用。设计契约见 [../../rfc/2026-07-11-anthropic-via-openai-translation.md](../../rfc/2026-07-11-anthropic-via-openai-translation.md)，task 锚点见 [../plan.md](../plan.md)。

## Phase 导航表
| Phase | kickoff | 前置 | 可并行 | byte-critical |
|---|---|---|---|---|
| 0 codec 纯化 | [phase-0.md](phase-0.md) | 无（前置阻塞全部）| 否 | golden 等价 |
| 1 路由骨架+二维门控 | phase-1.md（待写）| P0 | 否 | 现状零回归 |
| 2 hub+请求翻译 | phase-2.md（待写）| P1 | 否 | — |
| 3 非流式响应 | phase-3.md（待写）| P2 | 否 | @responses 四跳 |
| 4 流式+handler 缝合 | phase-4.md（待写）| P3 | 否 | **是（死磕逐字节）** |
| 5 反向格子接线 | phase-5.md（待写）| P4 | cc/responses 可并行，gemini 依赖 hub 组合 | 反向逐帧 golden |
| 6 doc-sync | phase-6.md（待写）| P5 | — | — |

> per-phase kickoff 增量产出：Phase 0 已就绪可执行；后续 phase 在推进到该阶段前展开（避免一次性写全、上下文腐化）。

## 阶段依赖 DAG（红线：不可乱序）
```
P0 ──前置阻塞全部──→ P1 ──→ P2 ──→ P3 ──→ P4 [byte-critical 严格串行]
                                              │
                                              ▼
                              P5 (反向格子) ──→ P6 (doc-sync)
```
- **P0-P4 严格串行**：翻译链 byte-critical，不可拆并行。
- **P5 内部**：cc→messages / responses→messages 格式独立可并行；gemini→messages 依赖 hub 两段 translator 组合（W-gemini-hub-composition），不与前两者纯并行。

## 通用红线（各 phase 引用，不重复）
1. **no-destructive-workspace-loss**：撤销自己的编辑用重新编辑，不 `git checkout --`；不删「无消费者」符号除非独立核实。
2. **细粒度 pathspec 提交**：`git commit -F msgfile -- 精确路径`，每语义单元一 commit，conventional commits，无 `Co-authored-by`。共享 worktree 用 pathspec（免疫 peer index race）。
3. **commit invariant（large-refactor §2）**：每 commit 终态 typecheck 绿 + `bun test` 全过 + 现状 6 格 golden 不变。中间态显式无害（dead code / silent flag），绝不半坏。
4. **golden-fixture 预捕获（§4）**：behavior-preserving 的改动，先在**改动前 HEAD** 写 golden 断言并跑通（锁定现状），再改，同一测试须仍过 + 连跑 N× 确认确定性。
5. **byte-critical 死磕逐字节**：转发给客户端的响应 SSE（Claude Code/Anthropic SDK 苛刻解析）逐字节等价是硬 gate；上游 wire / history 用结构等价/oracle。
6. **no-auto-server**：不跑 `bun run dev/start`、不 kill 本项目实例；可跑 typecheck/lint/bun test。需验证服务器行为让用户启动。
7. **subagent 全量工具**：派 review subagent 放开工具限制（含 Bash）。
8. **三能力守卫 + 二维门控**：改写/策略按 `targetEndpoint` 门控（上游 wire），render/心跳按 `clientFormat`（客户端）——见 RFC §3.1。别把出站关切钉入站轴。
9. **反向红线（WARN-B）**：反向请求侧（→messages）**绝不合成 Anthropic thinking content block**（无有效 signature 必撞 GHC 400/毒化）。

## 通用必读
- RFC §3.1（二维门控轴）、§4.2（hub 共享层）、§7（缝合落地契约）。
- ADR 两份（codec 纯化 + 全矩阵）。
- 探针实测 [PROBE-FINDINGS](../../../exp/anthropic-via-openai-translation/PROBE-FINDINGS.md)。
- skill：`large-refactor`（RFC-first/commit invariant/golden）、`ghc-anthropic-upstream`（thinking signature 400）、`claude-code-connection`（300s 断连）、`empirical-verification`。
