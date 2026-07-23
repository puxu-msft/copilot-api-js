# 会话交接：h2 池事故簇 + 上游静默 spec（2026-07-23）

> 交接给新会话继续。本会话从「分析一波网络问题」起，落地了多组修复与一份 spec，并留有若干待续任务 + 待补的 skill/doc。**权威事实以代码 + 下列文档为准**；本文件只做导航 + 剩余任务清单。

## 0. 一句话现状

原始两波网络事故的**决策 1+2**、三个暂缓项（**②per-origin 硬 cap / ③结构化 error tag / Q5 timing 埋点**）均已 landed master；**①上游静默 spec** 已定稿（经对抗审 + PoC，B2 主线待用户裁决）。全后端 6300+ pass。剩余 = spec 的用户裁决→plan→执行 + Q5 实测 + 两个非阻断 MED。

## 1. 已落地（master，别重做）

| 主题 | commit（约） | 权威文档 |
|---|---|---|
| 决策 1（h2 池容量选路 N=1 消 blast-radius）+ 决策 2（pre-response rstCode=0 可重试） | `36cf45bf` 及其祖先 | [docs/plan/2026-07-22-h2-pool-capacity-routing-and-pre-response-retry.md](2026-07-22-h2-pool-capacity-routing-and-pre-response-retry.md) |
| ② per-origin 总 session **硬 cap**（阻塞式 + lease token） | `feat/h2-pool-followup` 合并 | 同上 plan（已把 backlog 项标落地）；skill `debugging-ghc-api-upstream-transport` 已更新 |
| ③ transport 错误**结构化 tag**（`transport-reason.ts`） | 同上 | skill 同上 |
| Q5 timing 埋点（4 刻持久化进 V3 + REST 导出） | `f0911d30` | [docs/plan/2026-07-14-request-timing-instrumentation.md](2026-07-14-request-timing-instrumentation.md)（尾部有 Q5 复审 follow-up） |
| 上游静默 spec（deferred-header + delayed-commit 不可逆） | `40bf8503` | [docs/spec/2026-07-23-upstream-silence-commit-timing.md](../spec/2026-07-23-upstream-silence-commit-timing.md) |
| B2-vs-B5 PoC（定 B2 主线） | `exp/` force-add | [exp/silence-recovery-b2-vs-b5/FINDINGS.md](../../exp/silence-recovery-b2-vs-b5/FINDINGS.md) |

**②③ 全经 3+ 轮对抗审**：首轮 5 HIGH（全独立探针复现）→修；复审发现 HIGH-1 修复引入 cross-epoch cap breach→改 lease token；三轮共识。承重实现细节见传输 skill 新增的「h2 session 池」节。

## 2. 剩余任务（新会话继续）

### 2.1 上游静默 spec → plan → 执行（最大块）
- **spec 已定稿**，`docs/spec/2026-07-23-upstream-silence-commit-timing.md`。B2-vs-B5 PoC 已定 **B2 主线**（§6.1）。
- **待用户裁决**（spec §8）：① 方向（B2 主线已倾向，用户答「B5 vs B2 再评」已由 PoC 完成、倾向 B2）；② fail-fast 上限 Q6（用户选「等 Q5 验证后定」）；③ 进 plan 时机。
- **进 plan 后**（`planner`）：把 B1（加宽 commit 窗口）+ B2（post-commit pre-semantic recovery supervisor，**非 continuation 小变体**，须新建 pre-ready failure ownership / 统一 semantic-content gate / sink lifetime supervisor / 三模式 wire contract 回归矩阵 / history settlement）+ B3（fail-fast 兜底）拆 TDD plan。**server-tool 双执行 gate 必复用 `classifyServerExecutionRisk`**（`hedge-policy.ts:152-183`，`allowServerTools:true` 不得绕过）。
- **待实测门**（进 B1/B2 实施前）：Q1（CC pre-header 容忍度，隔离 server + mock 二分）、Q2（事故请求 fresh-retry 可恢复性，`gpt-souls:poc-runner` + 真 GHC，决定 B2 根治 vs 退化 B3）、Q3（Responses 路径 header 时序，独立 spec）、Q8（GHC pre-content 状态面 capability probe）。

### 2.2 Q5 实测（把证伪从「强线索」升「实测」）
- 埋点已 landed，但**历史 V3 entry 无这 4 刻**，只有**新请求**才带。测量链：**新代码跑起来**（用户重启 4141 主服务器到新 master，或起隔离测试服务器发真 heavy-thinking 请求）→ 累积样本 → 查 `GET /history/api/entries/:id` 的 `attempts[].timing.upstreamHeadersAt` → 判 `upstreamHeadersAt − started_at > 20s ∩ responseSuccess` = deferred-header 铁证。
- **⚠ 绝不碰 4141 用户主服务器**（重启是用户的决定）；可起**非 4141** 隔离测试服务器（skill `live-ghc-e2e-verification`）自测——但那烧真实额度、须靶向。
- 完成后回填 spec §3/§9（把「强线索」改「实测结论」）+ 撤 §0 的证据 caveat。

### 2.3 Q5 复审两个非阻断 MED（plan 文档尾部有详述）
- **MED-1**：`upstreamHeadersAt` 的真实捕获（`recordOpened`，`driver.ts:642`）无 .it 测试覆盖（现有 harness 用 `runResponse` 喂已开流、绕过 dispatch-open）。接线已 code-read 验证；补一个走完整 dispatch-open 路径的测试。
- **MED-2**：timing 写入在 sealed 时抛错、同族 capture 一律 `if(sealed) return`——不对称。**注意**：seal 边界既定设计是 loud throw（`assertWritable` 硬钉、首轮 review 确认正确），对齐须谨慎、非简单加 guard。

## 3. 待补的 skill / doc（用户明确要求）

已做：skill `debugging-ghc-api-upstream-transport` 已更新（h2 池模型 + 结构化 tag 分类，commit `992e4a1e`）。

**待新会话补**：
1. **`docs/DESIGN.md` 「活的架构现状」**：h2 池从单 session 升多 session 容量选路——若 DESIGN 有 transport/上游连接节，同步（当前活路径 = `acquireSession` + reservation + cap + lease + idle-reap）。
2. **`docs/API.md`（端点 SSOT）**：`GET /history/api/entries/:id` 的 `attempts[].timing` 现含 `upstreamHeadersAt/MessageStartAt/FirstTokenAt/LastTokenAt`（Q5，绝对 epoch）——补字段级备注。
3. **skill `history-sqlite-schema`（V3 schema）**：`ModelOperationDispatch.timing`（4 刻，随 manifest/journal JSON、**无** SQLite schema 迁移）——补一句。
4. **skill `proxy-api-reference`**：History REST 详情的 timing 字段（同 API.md）。
5. （可选）新 skill 或并入现有：**并发原语教训**（reservation exactly-once 三路径、lease token 跨 epoch 归属、阻塞 primitive FIFO waiter + lost-wakeup 避免 + raceAbort onAbandonedResolve、WS-evict-idle 在 idle-优先池不可达）——目前散在传输 skill 的「h2 session 池」节，若日后复用可抽独立 skill。

## 4. 承重教训（已入记忆库，勿丢）
- `feedback-recovery-is-only-path-not-risk-tradeoff`（重连是唯一出路非取舍）
- `methodology-run-architecture-guards-before-structural-refactor-commit`（结构重构提交前跑架构守卫/全 backend——C2 曾漏跑留红 master）
- **offset 反推 ≠ 直读时刻**（spec reviewer 抓：我把 SSE offset 反推的 header 时刻包装成「实测」；直读 mark 才是 oracle）——可并入 `empirical-verification`。
- 全程 **subagent 承重声称亲自 code-read/探针复核**（reviewer 5 HIGH 我逐条核；implementer 数据流断点我 code-read 确认）。

## 5. 并发协作纪律（本仓库常态）
master 有活跃 peer（tool-name-sanitize / continuation-retry / docs 等）持续提交。合并模式：**隔离 worktree 里 `git merge master` 解冲突 → 主树 `git merge --ff-only feat`**（链式、赢竞速）；ff 前**核 feat delta ∩ 主树 peer WIP = ∅**（`comm -12`）。skill `git-preference:coordinating-a-shared-git-worktree` / `isolating-from-a-shared-git-worktree`。

## Kick-off Prompt（复制到新会话）

```
接手 copilot-api-js 的「上游静默 + h2 池事故簇」工作。先读交接文档 docs/plan/2026-07-23-handover-h2-pool-and-silence-spec.md，据其 §2 剩余任务与 §3 待补 skill/doc 继续。

优先级：
1. 上游静默 spec（docs/spec/2026-07-23-upstream-silence-commit-timing.md）——与用户确认方向（PoC 已定 B2 主线）后，若确认推进则派 planner 写 B1+B2+B3 的 TDD plan；B2 是新拓扑非 continuation 变体（见 spec §6.1 + exp/silence-recovery-b2-vs-b5/FINDINGS.md）。进实施前 Q1/Q2 待实测门可派 poc-runner。
2. Q5 实测：新代码跑起来后（用户重启 4141 或起非-4141 隔离测试服务器）读 attempts[].timing.upstreamHeadersAt，判 >20s∩成功 固定 deferred-header 证伪，回填 spec §3/§9。绝不碰 4141 主服务器。
3. 补 §3 列的 skill/doc（DESIGN.md 活架构、API.md timing 字段、history-sqlite-schema、proxy-api-reference）。
4. Q5 两个非阻断 MED（plan 2026-07-14 尾部）。

纪律：审查永远派异模型 subagent 且亲自复核其承重声称；结构改动提交前跑全 backend；并发 peer 用隔离 worktree + ff（§5）；面向用户中文。
```
