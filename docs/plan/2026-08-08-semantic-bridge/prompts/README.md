# Prompts 导航：Anthropic ↔ Responses semantic bridge 实施

每个文件是一个**可直接粘给独立 implementer 的 self-contained kick-off prompt**。设计契约见 [RFC](../../../rfc/2026-08-08-anthropic-responses-semantic-bridge.md)，任务锚点与 commit invariant 见 [../plan.md](../plan.md)。

> **增量产出**：C0–C3 的 kickoff 已就绪可执行；C4 及之后在推进到该阶段前展开——一次性写全会在前序阶段落地后腐化（前序 commit 会改变后续的锚点行号与接线形状）。这不是偷懒，是 [plan 陈旧程度 ∝ 实现返工轮数] 的直接应对。

## 阶段导航表

| 片 | kickoff | 前置 | 可并行 | 改 production writer |
|---|---|---|---|---|
| C0.1 共享 SDK oracle | [c0-1.md](c0-1.md) | 无 | — | 否（纯测试） |
| C0.2 缺陷语料 | [c0-2.md](c0-2.md) | C0.1 | — | 否（纯测试） |
| C0.3 mutation registry | [c0-3.md](c0-3.md) | C0.2 | — | 否（纯文档） |
| C1.1 ledger 类型与 declare | [c1-1.md](c1-1.md) | C0 | — | 否 |
| C1.2 三层 terminal | [c1-2.md](c1-2.md) | C1.1 | — | 否 |
| C1.3 snapshot/fork/property | [c1-3.md](c1-3.md) | C1.2 | — | 否 |
| C2.1 config snapshot | [c2-1.md](c2-1.md) | C1 | — | 否 |
| C2.2 lineage 与 policy resolver | [c2-2.md](c2-2.md) | C2.1 | — | 否 |
| C2.3 delivery authority | [c2-3.md](c2-3.md) | C2.2 | — | 否（只加记录层） |
| C3.1 observation stage | [c3-1.md](c3-1.md) | C2.3 | — | 否 |
| C3.2 History 双路径投影 | [c3-2.md](c3-2.md) | C3.1 | — | 否 |
| C3.3 REST/WS + docs | [c3-3.md](c3-3.md) | C3.2 | — | 否 |
| C4.1 / C4.2 ordered-turn | 待写 | C3 | 与 C5/C6/C7 并行 | 否 |
| C5.1 / C5.2 server-tool 四格 | 待写 | C3 | 同上 | 否 |
| C6.1 / C6.2 capability policy | 待写 | C3 | 同上 | 否 |
| C7.1 / C7.2 carrier v2 | 待写 | C3 | 同上 | 否 |
| C8.1 / C8.2 两 emitter | 待写 | C4–C7 全部 | 8.1 与 8.2 并行 | 否 |
| C8.3 全 cell shadow parity | 待写 | C8.1+C8.2 | — | 否 `[hard]` |
| C9 A→R 原子 cutover | 待写 | C8.3 | 否 | **是** |
| C10 R→A 原子 cutover | 待写 | C9 | 否 | **是** |
| C11.1 / C11.2 退休与文档 | 待写 | C10 | — | 是（删旧路径） |

## 阶段依赖 DAG

```text
C0.1 → C0.2 → C0.3
                │
                ▼
        C1.1 → C1.2 → C1.3          [纯状态机，严格串行]
                        │
                        ▼
        C2.1 → C2.2 → C2.3          [lineage 与 authority，严格串行]
                        │
                        ▼
        C3.1 → C3.2 → C3.3          [observation 与公共契约，严格串行]
                        │
        ┌───────┬───────┼───────┬────────┐
        ▼       ▼       ▼       ▼        │
      C4.1/2  C5.1/2  C6.1/2  C7.1/2     │  ← 四组可并行分派
        └───────┴───────┴───────┴────────┘
                        ▼
                 C8.1 ∥ C8.2 → C8.3
                        ▼
                       C9  ← 第一个改 production writer 的 commit
                        ▼
                       C10
                        ▼
                C11.1 → C11.2
```

**并行边界与合并顺序**：C4–C7 四组共改 `src/lib/pipeline/semantic/` 下的 mapper 与 policy 模块。建议合并序 **C7 → C5 → C6 → C4**（按对共享模块的改动面从小到大），每组合并后下一组 rebase 并重跑自己的测试。C8.1（Responses emitter）与 C8.2（Anthropic emitter）格式独立，可分派不同 implementer。

**不可并行**：C1→C2→C3 每一步消费前一步的类型契约；C9→C10 必须串行，否则无法独立证明单方向的「旧路径不可达」并单方向回滚。

## 通用红线（各 kickoff 引用，不重复）

1. **中文对话**，回答与思考都用中文。
2. **不改变 production writer** `[hard]` —— C1–C8 一律不得让新路径成为客户端 writer。只有 C9/C10 切换，且必须原子。你的片若不在 C9/C10，`git diff` 里出现「新 path 被生产调用」即返工。
3. **shadow 零副作用** `[hard]` —— 只写 request-local 内存比较器。写客户端／日志／History／指标／共享状态即失败。
4. **4141 保护** `[hard]` —— 绝不 `kill`/`pkill`/`killall` 用户在 4141 端口的主服务器。需要测试服务器就起在其它端口、用完按**记录的 PID** 精确清理。
5. **不可逆动作 fail-closed** —— 无法确定 opaque 来源、schema dialect 不接受、context-management 混合策略，一律 reject，不猜。
6. **实现优先、非 TDD red-first** —— 先写生产行为，再补直接覆盖该行为的核心测试。**唯一例外是 C0**：它是 golden 预捕获，必须在改动前的旧码上跑通。
7. **绝不破坏性还原工作区** `[hard]` —— 撤销自己的编辑用**重新编辑**，不用 `git checkout -- <file>` / `restore` / `reset --hard` / `clean`。共享树里那个文件可能含别的会话的未提交 WIP。
8. **细粒度 pathspec 提交** —— `git commit -F <msgfile> -- <精确路径>`，一语义单元一 commit，conventional commits，**不加模型署名**。绝不 `git add -A` / `git add .`。
9. **不 push** `[hard]` —— 提交到本地即可，发布是用户的决定。
10. **进度文件** —— 一 agent 一文件，放 `docs/plan/2026-08-08-semantic-bridge/progress/<你的片 ID>.md`，随**每个**实现 commit 一起提交。只记 git 记不下的三样：为什么这么选、试过什么没成、下一步卡在哪。
11. **mutation 不变红有三解** —— 测试没咬住 / mutation 没生效 / fixture 造不出被测状态。排除前两条后先写探针问「这状态真存在吗」，**别改断言凑绿**。
12. **不忽视既有错误** —— 遇到的所有 typecheck／测试／导入错误都修，不当「与我无关」。

## 通用必读（每片开场先读，并**复核引用的 file:line**——行号会漂移）

```
docs/rfc/2026-08-08-anthropic-responses-semantic-bridge.md   # 权威契约。你片对应的节见 plan.md 的覆盖表
docs/plan/2026-08-08-semantic-bridge/plan.md                 # 锚点表 + 你片的 commit invariant / Verify / Mutation
docs/decisions/2026-08-08-protocol-neutral-reasoning-exchange.md
docs/DESIGN.md                                               # 「活的架构现状」表 = 当前活/wip/bypass 路径的权威
CLAUDE.md                                                    # 项目工作哲学与工程纪律
```

相关 skill：`large-refactor`（commit invariant / golden 预捕获 / 三层文档）、`empirical-verification`（实测裁决）、`positive-control-your-tests`（mutation 纪律）、`ghc-anthropic-upstream`（thinking signature 400 与布局三约束）、`test-isolation`（隔离基建）。

## 测试档位速查

| 命令 | 含义 |
|---|---|
| `bun run typecheck` | `tsc`，每次编辑后先跑 |
| `bun run test` = `test:fast` | unit + http，快速反馈 |
| `bun run test:backend` | unit + it + http，**交付前必跑** |
| `bun run test:it` | 仅集成 |
| `bun run test:ci` | backend + pty + e2e（会先构建 history-search native） |
| `bunx eslint <改过的文件>` | 本项目 2026-06-29 起无 pre-commit 门禁，lint 靠手动 |

前端（`ui/`、`ui-v4/`）测试必须显式单独触发，后端档位脚本一律不聚合前端。
