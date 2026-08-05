# KICKOFF —— generation emission command algebra

> 整段复制为新会话第一条消息。事实、证据、理由、数字、完整步骤**都在 [HANDOVER.md](HANDOVER.md)**，本文件只放启动 gate、第一步与批准状态。

```text
接手 copilot-api-js 的 generation emission command algebra 工作。

先读 docs/plan/2026-07-27-inter-block-anchor-allocator/HANDOVER.md（唯一事实源：核验基线、硬事实、用户裁决、待办与证伪方式）。
RFC 在 docs/rfc/2026-08-03-generation-emission-command-algebra/design.md。

## 启动前的硬 gate（照做，理由在 HANDOVER）

1. **不要直接写代码，先取得本次开工裁决。** 三层计划已全部评审放行；按 docs-merge-before-execute，文档定稿后执行仍是独立决定。获准后从 `docs/rfc/2026-08-03-generation-emission-command-algebra/prompts/README.md` 的 Commit -1 起，不从旧 P0 或直接 C0 起。
2. **复验而非采信；已经只有一个代码基线。** M1 已于 `8125f123` merge 进 master，此前「文档基线 vs 未合并 feature 代码基线」的双树口径**整体作废**。当前 `file:line` 一律锚 master；接手第一件事仍是重新核对 HEAD、git status、分支与 worktree 列表。
3. **入场证据不得手工拼一条 test 命令代替。** 正确链是 Commit -1 交付真实 shard oracle + producer + validator并先合 master得 A → 从 A 建执行树 → T0.0f 用冻结 producer CLI 生成树外 15-run evidence/manifest/P → T0.0d 写 receipt → T0.1 入场确认。旧读数、旧 raw `parallel-test` 连跑或缺 receipt 的绿都不顶替，任一门失败不得开始 Commit 0。
4. **每条 Bash 调用自己绑定目录根**（`cd <绝对路径> && ...` 或 `git -C <绝对路径>`），绝不依赖上一条命令留下的 cwd。
5. **绝不碰 4141 端口的用户主服务器**（kill/pkill/killall 一律禁止）。需要真服务器就自起非 4141 实例，按 PID 精确停。
6. **下任何全套件断言前，先确认没有 peer agent 在同一棵树跑测试或做 mutation。**
7. **agent 的「已完成」报告可能与磁盘不符**（本轮两个 agent 各中过一次）。任何声称「已提交/已写文件」的报告，
   先按 HANDOVER「委派可靠性」那一节的六条命令核实；派活时要求回报里贴 `git log --oneline -1` 与 `git show --stat HEAD` 的原样输出。

## 第一步（按用户裁决分支）

**已裁决的「先补计划层」已完成：三层均评审放行。** 当前下一步只剩用户决定是否/何时开工；获准后按 `docs/rfc/2026-08-03-generation-emission-command-algebra/prompts/README.md` 的严格串行 DAG，从 Commit -1 prompt 起。
（另两条分支已作废，留此备查：「直接起执行」= 读 RFC §7 与 §9.4 停点表从 Commit 0 开始；「尚未裁决」= 把 T1 摆给用户。**别再照它们走。**）

## 批准状态

- 已裁决、不得重开：见 HANDOVER「用户已裁决」表（8 条：形状 / 起点 / 帧序 / 范围 / flaky 处置 / History schema / Q3 / wire-torn close）。
- 仍待裁决：Q1（telemetry 联合查询能力）——阻塞 Commit 5，不阻塞 Commit 0–4，见 HANDOVER T2。
- 未定性：基线 flaky 第 1 条（T3）、P7 translate 腿缺口（T5）。
- continuation ADR D2 的 replacement／审批仍归原计划 P8，本 RFC 实施不执行、不删除该待办；Q1 等本 RFC 未裁项只在各自 prompt 触发点取得首次裁决。

## 工作方式

- 代码改动走隔离 worktree；**文档在主树改**（入口文档滞留特性分支等于没写）。
- 提交用显式 pathspec（`git commit -F <msgfile> -- <精确路径>`），conventional commits，不加模型署名。
- 派 subagent 时在 prompt 里显式写裁判轴「长远正确 + 完整」——它们默认持 ROI/YAGNI，与本项目冲突。
- API 抖动缓解：派活一次只做一节、写完立即返回、边验证边落盘、回复压到 3–5 行；中断后用 SendMessage 续跑**同一个** agent，别重派。

## 这一轮反复踩的坑（完整表与复发点在 HANDOVER）

- 人口/清单按单一轴枚举必漏——本轮同一形态出现四次。先定义完整能力面再切分，别从类目起手。
- 为闭合而加的机制，自己要过同等强度的检验——本轮新加的过滤器与 oracle 各自带过缺陷。
- 确定性结论要带次数与概率口径；两次成功证明不了可复现。
- 引用任何「门」之前亲手跑一次，看它在错误状态下会不会红——本轮发现 O-6 门此前恒真。

## 测试门禁现状（核验于 2026-08-03 / master cc909c81；接手第一件事是复验而非采信）

- master 全套件 unit+it+http 连跑 21 次全绿（6845 pass / 0 fail，代码状态 cc909c81）——**但那是自我报告的摘要、不是独立可核验的原始输出，别当门禁已过**。理由与将来那次跑的取证配方见 HANDOVER 头部「已跑门禁」与 T3 的修复 AC ④。
- 起执行前必须按 RFC §7.1 在**当时的 entry commit** 上重跑 ≥15 次，**每次留一个原始输出文件**；旧读数不顶替。
- **注意 `bun run test` 的档位**：它是 `test:fast` = `parallel-test.ts unit http`，**不含 `it` 档**。要 unit+it+http 用 `bun run test:backend` 或显式写 `bun scripts/parallel-test.ts unit it http`。（上一版这里写「会因 rustup 前置失败」——**那是错的**，只有 `test:ci` 会先 `build:history-search`；交接评审实测推翻。）
- exp/inter-block-anchor-allocator/byte-equivalence.sh 现在是**比较**不是捕获：一致 O-6 PASS 退出 0、不一致退出 9；本 cutover 全程禁用 RECAPTURE=1。
```
