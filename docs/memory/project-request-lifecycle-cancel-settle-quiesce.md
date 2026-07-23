---
name: project-request-lifecycle-cancel-settle-quiesce
description: "请求超时/优雅退出多根因修复(2800s 越超时)——四根因+C5 结构全合 master,剩低频 operation 站点接线"
metadata: 
  node_type: memory
  type: project
  originSessionId: e978549f-891d-4684-a1e7-3cf08463cbc3
---

2026-07-14 起。用户观测 `POST /v1/messages` gpt 请求 2800.9s 越过所有配置超时,触发对超时机制的全面分析 → 定位**多根因、跨模块架构病**:settle(记终态)/cancel(停工作)/quiesce(异步退出)三态混为一谈,取消信号覆盖不一致,drain 等 context 而非 operation。

**权威文档(master)**:RFC `docs/rfc/2026-07-14-request-lifecycle-cancel-settle-quiesce.md`(定稿 v4,**6 轮独立 GPT 对抗复核**逼出并修正 3 个致死锁/orphan 架构缺陷:三态因果环、无限等 quiesce、lifecycle record 删除矛盾)+ plan `docs/plan/2026-07-14-...-plan.md`(C0→C6 DAG + 锚点表 + 实施状态注解)。

**四根因(全证实/强候选)**:
- RC1 streaming pre-response fetch 故意排除 shutdown(`send.ts` 旧 `stream?undefined`)→ Phase3 abort 够不着 → 挂 Phase4(07-12 实测卡 120s)。**证实**。
- RC2 reaper 周期扫描迟到(实测迟 198s,age 1398 vs max 1200);机制强候选=config 热重载改阈值但 cadence 冻结、或**进程/WSL2 suspend** 冻结所有 timer(证伪"退避饿死 timer")。
- RC3 退避 `delay()` 不接 signal + 循环不检查 settled → reaper settle 后仍 sleep(631s)再起 attempt=2800s 溢出。**证实**。
- RC4 限流 rejectQueued 与在飞 processQueue 竞争 → caller 拿 shutting-down 后仍跑上游。**证实**。

**已 landed（全部合上 master）**:四根因治根 + **C5 结构核心 + C4a 承重接线 + C6 全部已合 master**（worktree `feat/request-lifecycle` 已 FF 入 master 后移除）——C0-observe `reaper-diagnostics.ts`、C1+C2 RC1+RC3、C4b RC2 request_deadline 精确 timer（bundled 900s、绕迟到 reaper）、C3 RC4 per-item cancelled、operation-scope+finalization-coordinator primitive、RequestContext `operationSignal`/`cancel`/`trackOperationBody`/`whenOperationQuiesced`（Task4）、manager 双 registry visibleContexts/operationScopes（Task5）、**shutdown drain 切 getTrackedOperations——settle 后在飞 orphan 现被 drain 等待（用户原始问题正解）**（drain-switch）、driver `runRequest` 追踪 exchange 为 operation-body（C4a 承重、covers 观测的 2800s 退避 orphan）、DESIGN.md 活的架构现状行 + lifecycle.md 同步。全 TDD、行为保持、golden 保持。

**待续**:其余低频 operation 站点（token-refresh/hook/heartbeat/response-pump）接 `trackOperationBody`、finalization coordinator 接 shutdown（History 已有 pendingFinalizations drain、Calibration 未 drain——评估统一别破坏 working History drain）。primitive/ctx API/双 registry/drain-switch 全就位,续做只需在站点加 `ctx.trackOperationBody(promise)`。

**合并纪律实证（本次跨多小时并发）**:合回 master 反复被 peer 未提交 WIP（driver.ts→request.ts/types.ts→DESIGN.md/plan）卡住,**每次等 peer 提交后 3-way 自动合非重叠 hunk、从不 force**;唯一真冲突是 plan 文档实施状态段（纯文档,取最新 + 对齐 peer 的 shutdown.md→lifecycle.md 改名）。master 有 3 类 peer 遗留红（`unknown_endpoint_logging.*` 完备性未登记 / `responses-to-cc-stream` item_id typecheck / ConsoleSink telemetry 失败）——**全在我从未碰的 peer 文件、非我引入、不揽改**。**并发 peer 是常态、不进计划**(isolated worktree 消化);硬约束只有「不覆盖未提交工作」。

**承重教训**:①RFC-first ≥3 轮对抗复核的价值实证——6 轮逼出 3 个会致死锁/orphan 的架构缺陷,全在写码前逮住(若从"可中断 delay"补丁开写会实现后期才爆)。②有界 grace 是关键——"cancel→等**完全** quiesce→settle"让不 quiesce 的 op 永不 settle、打败目标(reviewer 逮),须 `race(quiesce, grace)` 超时仍 settle。③per-request 精确 timer > 周期 scan 治 total-cap(绕过 RC2 迟到)。
