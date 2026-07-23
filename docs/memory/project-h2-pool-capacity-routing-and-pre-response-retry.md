---
name: project-h2-pool-capacity-routing-and-pre-response-retry
description: h2 连接池按容量选路(N=1)消灭并发流 blast-radius + pre-response rstCode=0 判可重试(landed master 36cf45bf)
metadata: 
  node_type: memory
  type: project
  originSessionId: c920d902-6204-44cc-a3c9-8980aa0b5232
  modified: 2026-07-23T04:55:10.673Z
---

修「同一 pooled h2 session 上并发大请求被上游一次会话级 teardown 一起打断」的两波网络事故。权威计划 [docs/plan/2026-07-22-h2-pool-capacity-routing-and-pre-response-retry.md]（含两波 History 实测取证、commit 拆分、开放问题裁决）。

**两个决策（用户拍板）**：① h2 session 每条同一时刻并发流软上限 **N（默认 1）**，超 N 用另一条 connection、原 session 流 done 后复用——池从 `Map<origin,entry>` 升 `Map<origin,entry[]>` 按容量选路，单条 session teardown 绝不连累 sibling（N=0=不限=旧单 session 多路复用字节等价）。② pre-response `rstCode=0` 关闭（`status=0` 零帧、连接已死）**无条件**判可重试（复用 network-retry，`hasRetried` 闩至多 1 次）——重连是唯一出路非取舍（见 [[feedback-recovery-is-only-path-not-risk-tradeoff]]）。

**承重实现点**：reservation 模型（选中即同步 `activeStreamCount+=1`、born-reserved、`transferred` 三路径 PATH1/2/3 各恰一次释放）消 cap 竞态；容量感知 `pending`（N=0 join 冷启动合一保字节等价，非删 pending——reviewer HIGH-1 修正）；idle-reap（`h2IdleSessionTimeout` 默认 300s，仅 active、armIdleTimer 触发前 re-check）。classify 新增**独立** pre-response token 表，不碰 REFUSED 严格边界。

**状态（2026-07-23，landed master）**：C1–C4 + 守卫修复 + 审查加固全部落地，与并发 `favor`（HTTP/2 偏好开关）特性 3-way 合并后 ff 回 master（`36cf45bf`）。合并态 `test:backend` **6181 pass 0 fail**、经合并态异模型审查（无 CRITICAL/HIGH，2 LOW 已处理）。合并冲突全在 `state.ts`/`proxy.ts` 的 config 加性字段（union 单行、defaults、getters），保留双方全字段；favor 的 config-hot-reload coverage 缺口（peer 遗漏、master 本已红）一并补登记。暂缓：总 per-origin session cap（plan Q4，已记 backlog）。教训 [[methodology-run-architecture-guards-before-structural-refactor-commit]]、[[feedback-recovery-is-only-path-not-risk-tradeoff]]。
