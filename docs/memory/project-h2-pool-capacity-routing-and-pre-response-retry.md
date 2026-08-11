---
name: project-h2-pool-capacity-routing-and-pre-response-retry
description: h2 连接池按容量选路(N=1)消灭并发流 blast-radius + pre-response rstCode=0 判可重试(landed master 36cf45bf)
metadata: 
  node_type: memory
  type: project
  originSessionId: c920d902-6204-44cc-a3c9-8980aa0b5232
  modified: 2026-07-23T08:41:07.055Z
---

修「同一 pooled h2 session 上并发大请求被上游一次会话级 teardown 一起打断」的两波网络事故。权威计划 [docs/plan/2026-07-22-h2-pool-capacity-routing-and-pre-response-retry.md]（含两波 History 实测取证、commit 拆分、开放问题裁决）。

**两个决策（用户拍板）**：① h2 session 每条同一时刻并发流软上限 **N（默认 1）**，超 N 用另一条 connection、原 session 流 done 后复用——池从 `Map<origin,entry>` 升 `Map<origin,entry[]>` 按容量选路，单条 session teardown 绝不连累 sibling（N=0=不限=旧单 session 多路复用字节等价）。② pre-response `rstCode=0` 关闭（`status=0` 零帧、连接已死）**无条件**判可重试（复用 network-retry，`hasRetried` 闩至多 1 次）——重连是唯一出路非取舍（见 [[feedback-recovery-is-only-path-not-risk-tradeoff]]）。

**承重实现点**：reservation 模型（选中即同步 `activeStreamCount+=1`、born-reserved、`transferred` 三路径 PATH1/2/3 各恰一次释放）消 cap 竞态；容量感知 `pending`（N=0 join 冷启动合一保字节等价，非删 pending——reviewer HIGH-1 修正）；idle-reap（`h2IdleSessionTimeout` 默认 300s，仅 active、armIdleTimer 触发前 re-check）。classify 新增**独立** pre-response token 表，不碰 REFUSED 严格边界。

**状态（2026-07-23，landed master）**：C1–C4 + 守卫修复 + 审查加固全部落地（`36cf45bf`），合并态 `test:backend` **6181 pass 0 fail**、经合并态异模型审查（无 CRITICAL/HIGH，2 LOW 已处理）。

**后续三个暂缓项亦全部落地/收官**（同源事故的延伸，均经对抗审）：
- **② 总 per-origin session 硬 cap**（`max_sessions_per_origin`，默认 0）：**阻塞式**（到 cap 全 busy 时新请求阻塞等上游 slot，客户端连接由 handler delayed-commit 心跳维持——阻塞纯上游侧）。承重教训：WS 式 evict-idle 在 idle-优先复用池里**不可达**（reaching create 意味着全 busy、没 idle 可 evict）；改带归属 **lease token**（`Map<origin,Set<symbol>>`，各 creation 唯一 token 只释放自己）修掉裸计数的 cross-epoch cap breach。合并态 6200 pass。
- **③ transport 错误结构化 tag**（`transport-reason.ts`，`pre-response-close/refused-stream/mid-body-close`）：tag 在产生点打、classify 先读 tag（穷尽 switch + `never`）、子串降 fallback；消除脆性 + defense-in-depth。
- **Q5 timing 埋点**（`f0911d30`）：上游 4 刻（`upstreamHeadersAt` 等）持久化进 V3 `ModelOperationDispatch.timing` + REST 投影导出——为上游静默 spec 的 deferred-header 证伪提供直读 oracle（`upstreamHeadersAt − started_at > 20s ∩ 成功` = 铁证）。review 0 blocker。

**②③ 全经 3+ 轮对抗审**（首轮 5 HIGH 全独立探针复现→修；复审发现 HIGH-1 修复引入 cross-epoch breach→lease 修；三轮达成共识）。教训 [[methodology-run-architecture-guards-before-structural-refactor-commit]]、[[feedback-recovery-is-only-path-not-risk-tradeoff]]。上游静默 spec + B2 主线见 [[project-upstream-silence-commit-timing-spec]]。
