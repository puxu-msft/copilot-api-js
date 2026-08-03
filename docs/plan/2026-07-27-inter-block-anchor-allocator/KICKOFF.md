# KICKOFF —— generation emission command algebra

> 整段复制为新会话第一条消息。事实、证据、理由、数字、完整步骤**都在 [HANDOVER.md](HANDOVER.md)**，本文件只放启动 gate、第一步与批准状态。

```text
接手 copilot-api-js 的 generation emission command algebra 工作。

先读 docs/plan/2026-07-27-inter-block-anchor-allocator/HANDOVER.md（唯一事实源：核验基线、硬事实、用户裁决、待办与证伪方式）。
RFC 在 docs/rfc/2026-08-03-generation-emission-command-algebra/design.md。

## 启动前的硬 gate（照做，理由在 HANDOVER）

1. **不要直接写代码。** 当前状态是「RFC 定稿、实施未开工」，卡在用户裁决「是否起执行」（HANDOVER T1）。没有该裁决前不动 src/。
2. **复验而非采信，并注意有两个基线。** HANDOVER 头部区分了「文档落地基线（master）」与「代码事实基线（未合并分支 feat/inter-block-anchor-allocator @ 2c339784）」——**硬事实表里的 file:line 全部锚在后者，在 master 上复算会一条都对不上**。接手第一件事是重新核对 git log、git status、分支与 worktree 列表。
3. **若已获准起执行**：入场条件在 RFC §7.1——在**当时的** entry commit 上连跑 ≥15 次
   `FORCE_COLOR=0 bun scripts/parallel-test.ts unit it http` 且次次全绿。旧读数不顶替，任一次失败都不得开始 cutover。
4. **每条 Bash 调用自己绑定目录根**（`cd <绝对路径> && ...` 或 `git -C <绝对路径>`），绝不依赖上一条命令留下的 cwd。
5. **绝不碰 4141 端口的用户主服务器**（kill/pkill/killall 一律禁止）。需要真服务器就自起非 4141 实例，按 PID 精确停。
6. **下任何全套件断言前，先确认没有 peer agent 在同一棵树跑测试或做 mutation。**
7. **agent 的「已完成」报告可能与磁盘不符**（本轮两个 agent 各中过一次）。任何声称「已提交/已写文件」的报告，
   先按 HANDOVER「委派可靠性」那一节的六条命令核实；派活时要求回报里贴 `git log --oneline -1` 与 `git show --stat HEAD` 的原样输出。

## 第一步（按用户裁决分支）

- 裁决 = 直接起执行  → 读 RFC §7（Commit 0–8）与 §9.4 停点表，从 Commit 0 开始；Commit 0 之前先过入场条件。
- 裁决 = 先补计划层  → 走 HANDOVER 的 T4：按 skill large-refactor §5 三层结构写 plan + prompts。
- 尚未裁决          → 把 HANDOVER 的 T1 摆给用户，不要自行选一条往下走。

## 批准状态

- 已裁决、不得重开：见 HANDOVER「用户已裁决」表（8 条：形状 / 起点 / 帧序 / 范围 / flaky 处置 / History schema / Q3 / wire-torn close）。
- 仍待裁决：Q1（telemetry 联合查询能力）——阻塞 Commit 5，不阻塞 Commit 0–4，见 HANDOVER T2。
- 未定性：基线 flaky 第 1 条（T3）、P7 translate 腿缺口（T5）。
- 停点（不得自行拍板）：ADR D2 改动——只出逐段 replacement 草案，获用户明确同意才改文件。

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

- master 全套件 unit+it+http：连跑 21 次全绿（6845 pass / 0 fail，代码状态 cc909c81），逐次记录在 docs/tmp/2026-08-03-baseline-run-log.md。起执行前仍须按 RFC §7.1 在当时的 entry commit 上重跑并保存逐次结果——旧读数不顶替。
- **注意 `bun run test` 的档位**：它是 `test:fast` = `parallel-test.ts unit http`，**不含 `it` 档**。要 unit+it+http 用 `bun run test:backend` 或显式写 `bun scripts/parallel-test.ts unit it http`。（上一版这里写「会因 rustup 前置失败」——**那是错的**，只有 `test:ci` 会先 `build:history-search`；交接评审实测推翻。）
- exp/inter-block-anchor-allocator/byte-equivalence.sh 现在是**比较**不是捕获：一致 O-6 PASS 退出 0、不一致退出 9；本 cutover 全程禁用 RECAPTURE=1。
```
