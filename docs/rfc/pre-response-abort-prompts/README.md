# pre-response abort RFC — 后续待跟进 Kick-off Prompts

每个文件是一个**可直接粘给新会话独立实现者的完整 kick-off prompt**（仿 [response-pipeline/prompts](../response-pipeline/prompts/) 结构）。设计稿见 [../pre-response-abort-handling.md](../pre-response-abort-handling.md)，权威进度看其 **§5 commit invariants 表**（哪些 ✅ 已落地）。

## 已落地（本系列之前，勿重做）

| 项 | commit |
|---|---|
| ① forwardError 分类 abort（504/499） | `ee4dd34` |
| ② pre-response client-abort 记 aborted | `d4bced4` |
| ⑤ 孤儿 promise abort 崩服务器防御 | `c824df4` |
| **④ reaper 装牙齿**（真取消在飞上游，全传输 HTTP h2 + Responses-WS） | `d6eacf0`(C4a) + `4bd6850`(C4b) + `67b6eca`(WS) |
| **C3b-pre1** `mapHttpErrorToEnvelope` 抽取 | `3e4b3cd` |
| C3b-pre2 emitPingOnAttach | 判定冗余（③ 用既有 `sink.write`），无 commit |

## 待跟进 Prompts

| Prompt | 任务 | 前置 | 性质 |
|---|---|---|---|
| [P1-q2-oracle-measurement.md](./P1-q2-oracle-measurement.md) | Q2 真实客户端实测（③ 的**硬门**） | 无（需真实 Claude Code/SDK + 运行中代理） | 实测、非代码 |
| [P2-c3b-delayed-commit.md](./P2-c3b-delayed-commit.md) | ③ 延迟-commit 实现（opus 长思考保活） | **P1（Q2 出结论）** + 解 §4.2.1 的 2 个新 CRITICAL + 并发 L2 字段冻结 | 大特性、byte-critical |
| [P3-keepalive-naming-taxonomy.md](./P3-keepalive-naming-taxonomy.md) | keepalive 配置命名一族重整 | L2 `protect_streaming_*` 字段冻结（建议与 P2 同期） | 重构 + compat 迁移 |
| [P4-reaper-real-abort-repro.md](./P4-reaper-real-abort-repro.md) | reaper-真-abort 的 0-unhandled repro（强化 ④） | 无（④ 已落地） | 独立小测、可随时做 |

## 依赖 DAG

```
P1 (Q2 实测) ──► P2 (③ C3b 延迟-commit) ──► [P3 keepalive 可同期]
P4 (reaper repro) ── 独立,随时可做(④ 已落地)
P3 也独立依赖 L2 字段冻结(与 P2 解耦但建议同期,避免二次改名)
```

**P1 是 P2 的硬门**：③ 把 POST-COMMIT 上游错误降级成 200+SSE-error 帧——双 oracle 已证对 Anthropic SDK 不等价（`.status===undefined` + 零自动重试）。grace 默认值也依赖实测客户端超时。**P1 不出结论，P2 不能落地**（不是 YAGNI 可绕，是真实外部/实测阻塞）。

## 通用红线（每个 prompt 都遵守，复制进实现会话或依赖项目 CLAUDE.md）

1. **中文对话**回答与思考；散文一段一行（prose-line-per-paragraph）。
2. **裁判轴 = 长远正确 + 完整**（architecture-health-first）：判断该不该做、做到什么程度，唯一轴是"问题是否真实存在"+"哪个方案最终质量最高"，**非** ROI/工期/改动量/YAGNI 默认。真实风险（资源泄漏、静默数据丢失、竞态、可观测盲点、协议契约错误）必须修。但"范围内彻底"≠无中生有——守住 YAGNI 不做投机表面（如本系列的 C3b-pre2：实现期发现 `sink.write` 已够，就**不加**冗余 `emitPingOnAttach`）。
3. **派 subagent 对抗 review 永远做**（多视角、全量工具 `claude`/`general-purpose`），prompt 里**显式写裁判轴**（长远正确+完整，覆盖 subagent 默认的 ROI/YAGNI 价值观）；**亲自复核 reviewer 引用的每个 file:line**，不信声音权威。
4. **实测裁决**（empirical-verification）：主张与观测冲突时写最小探针实测；flaky 连跑 10-25×；否定性结论（测试绿/grep 空/"无问题"）不自证，先确认检查真触达目标。环境/工具能力主张永远用探针验证。
5. **并发多会话 git 纪律**（本仓库有并发 agent 会话同时提交，HEAD 会在脚下移动）：提交用 `git commit -m "..." -- <精确路径>`（pathspec=只提目标、无视 index 其它），提交后 `git show --stat HEAD` 复核**只含你的文件**；同一文件含你的+别人未暂存改动只提你的 hunk 用 `git apply --cached`（之后裸 `git commit`、不带 pathspec）；**绝不**在并发提交活跃时 `reset`/`rebase`/`--amend` 重写历史。每完成一个自洽阶段即提交（conventional commits，无 Claude 署名）。
6. **绝不**未经同意 `git checkout/restore <file>`、`reset --hard`、`clean -f`、`rm` 工作区文件（不可逆，最严重错误）。
7. **不自动启服务器**（`bun run dev`/`start`）、不 `kill`/`pkill` 本项目进程。验证用 `bun run typecheck`、`bun test tests/<域>/...`、`bunx eslint --fix`（**不用 `prettier --write`**）。**注**：并发 L2 重构可能打挂全树 typecheck，用 `grep -v <对方文件域>` 切片确认我的文件零错。
8. **byte-critical 纪律**（P2 适用）：流式生命周期改动**先 golden-fixture-pre-capture**（在**改动前**代码上锁字节），改后逐字节等价是硬 gate。流式/时序 fixture 连跑 10-25×。
9. 不使用分号、三元行首、`printWidth` 160；严格 TS、避免 `any`；同目录导入相对路径；不删有意义注释。不忽视既有错误。
10. **完成 == 收尾完成**：代码改完后同步 plan（RFC §5 标 ✅）、项目文档（DESIGN.md 运行时选项表/hot-reload 表/活的架构现状表）、memory（删过时 pending、回填已落地机制）。

## 通用必读（每个 prompt 开场先读，复核 file:line——代码会漂移）

```
docs/rfc/pre-response-abort-handling.md     # RFC 设计稿(§3 ①②/§4 ③/§4.2.5 错误保真/§5 commit 表/§6 Open Qs/§2 缺陷④⑤)
docs/DESIGN.md                              # v4 七阶段管线现状 + "活的架构现状"表 + 运行时选项表
docs/memory/project-pre-response-abort-rfc.md  # 项目 memory(进度 + 触发条件)
```

相关 memory（recall 关键）：`empirical-probe-via-history-api`（从 4141 后端拉真实 entry）、`self-consistent-needs-independent-oracle`（P1 错误帧等价须独立 oracle）、`git-concurrent-sessions-pathspec-commit`、`methodology-golden-fixture-pre-capture`（P2）、`feedback-byte-equivalence-is-proxy-calibrate-by-consumer`。
