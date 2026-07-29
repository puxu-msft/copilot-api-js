# 会话交接：h2 池事故簇 + 上游静默 spec（2026-07-23）

> **状态：进行中**（B2 实施到 P4 Task 4.0 完成）。**核验基线：** master `c716d921` / 分支 `feat/upstream-silence-recovery` @ `796ef05b`（30 提交），**2026-07-28**。
> **工作区**：隔离 worktree `.worktrees/upstream-silence-recovery`（**未合回 master**；node_modules 向上解析主树、**不是**依赖隔离）。分支上无未提交改动（除 gitignored 的 `.superpowers/sdd/progress.md` ledger）。主树有并发 peer 的未提交 WIP（`.claude/settings.json`、`docs/lifecycle.md`、`docs/memory/*` 等）——**不是本轮的，别动**。
> **已跑门禁**（基线时刻）：`typecheck` 绿；`bun test --parallel .unit.test .it.test .http.test` = 6602 pass / 8 skip / 3 fail，**3 个失败单跑全过**（2 个 Bun worker SIGILL + 1 个负载敏感 UDS sidecar）。⚠ **`bun run test:backend` 的汇总计数不可信**（见 §0.2 末尾），取真实数请用上面那条直接命令。
>
> 交接给新会话继续。**最新实施真相在 §0.2（2026-07-28 更新）——先读它**；§0/§0.1 是 2026-07-23 的历史语境，其中「Q1 ≥125s」「B1+B2-P0 可开工」等表述已被 §0.2 supersede。**权威事实以代码 + §0.2 为准**。

## 本轮我犯过的错（写在最前——只给结论会让接手重犯产出结论的错误）

1. **在过时底座上干了一整轮**：开工时没先合 master，等到 Task 0.5（sink supervisor）才发现 master 早已重写了 delivery/heartbeat 生命周期、且我的 B1 已被主线 supersede。**教训**：动某子系统前先 `git log ..master -- <该子系统路径>`；本轮第二次合并就是踩过一次后主动做的。
2. **把一句错误的经验写进了 skill**：Task 0.6 的正样本对照我写成「`unhandledRejection` 探针实测 3/3 红」，被 reviewer 用第三组 mutation 证伪——那条探针**结构上永不触发**（helper 里 `await request` 消掉了 bug 的前提「无 live awaiter」），真正咬住的是旁边的状态断言。已订正 `debugging-server-crashes` 变体 C。**教训**：断言否定性结论前，先确认测试拓扑**保留了 bug 的触发条件**。
3. **把工具缺陷判重了**：发现 `test:backend` 恒报 `0 tests` 时我说是「静默假绿」——**不准确**，门的退出码由各 shard 决定、真失败照样红，坏的只是证据行。已当场更正。


## 0. 一句话现状

原始两波网络事故的**决策 1+2**、三个暂缓项（**②per-origin 硬 cap / ③结构化 error tag / Q5 timing 埋点**）均已 landed master；**①上游静默 spec** 已定稿。**2026-07-23 续会话进展**：**Q5 已实测闭合**（只读 4141 直读 `upstreamHeadersAt`，34 正样本 header@47-231s∩success，deferred-header 实测证实、等-header 判别证伪、对抗审 HIGH-1/2 解除，spec 已回填 `9f886ade`）；**Q1/Q2 已跑**（Q1=CC pre-header 容忍 ≥125s、Q2 未定论，`exp/silence-recovery-gates/` + `25e6f81c`）；**B2 主线 + Q6 高上限已用户裁决**；**B1+B2+B3 TDD plan 已产出并跨模型对抗审**（`docs/plan/2026-07-23-upstream-silence-recovery/`，1 CRITICAL + 1 HIGH 已整合，`d280687f`）；**§3 doc/skill 已补**（`8fff5dd0`）；**MED-1/MED-2 入 backlog**（`21f0c8a9`，MED-2 已折进 B2 plan Task 0.6）。**剩余 = 用户裁决 plan 的几个开放分叉 → 实施（B1 + B2-P0 可开工）。**（**Q1 首失败点已于 2026-07-27 实测闭合 ≈300s**，见 `exp/silence-recovery-gates/FINDINGS.md` §「Q1 续测」，补测项作废。）

## 0.1 续会话更新（2026-07-23，supersedes §2/§3 below）

**本会话提交**（master，均显式 pathspec）：`9f886ade`（spec Q5 回填）、`8fff5dd0`（§3 doc/skill）、`25e6f81c`（Q1/Q2 PoC+FINDINGS）、`21f0c8a9`（MED-1/2 backlog）、`d280687f`（TDD plan）、`69786897`（记忆 stub）。

**§3 待补 skill/doc = 已全部完成**：DESIGN.md h2 池多会话细节（`8fff5dd0`）、API.md timing 字段（早已就绪、无需改）、skill `history-sqlite-schema`（dispatch timing 注）、skill `proxy-api-reference`（timing 字段）。

**剩余（新会话继续）**：
1. **plan 的用户待裁决分叉**（实施前，见 [plan README](2026-07-23-upstream-silence-recovery/README.md) 文末 + 各门控）：① B2 配置键命名（占位 `precontent_recovery`）；② B2 触发范围是否纳入 `reaper-cancel`/`timeout(header-wait)`（plan 默认排除、留 B3）；③ buffered 路径 B2 是否尊重 `max_retries=0`、复杂则降级 backlog 只做 live；④ B3 fail-fast 计时器是否与 `responseHeaderTimeout` 合并（plan 倾向独立）。**这些是真分叉、需用户拍板**，不阻塞 B1/B2-P0 开工。
2. **实施**：B1（plan-1，独立低风险）+ B2-P0（plan-2 Task 0.1 配置骨架）可即开工；B2-P1~P6 串行；B3 依赖 B2 gate。走 `superpowers:subagent-driven-development`。**实施前建议对整合后 plan 再过一轮 consensus 复审**（resume 原 `gpt-souls:reviewer`）。
3. ~~**Q1 首失败点补测**（130/150/180s 阶梯）~~ **已完成，此项作废**（2026-07-27 实测 ≈300s，机制 = undici 默认 `headersTimeout`；见 `exp/silence-recovery-gates/FINDINGS.md` §「Q1 续测」）。剩下的是 **B1 默认值取多少**——上界已知的取舍，交用户拍板。
4. **MED-2 已折进 B2 plan Task 0.6**（seal-race crash 安全，B2 必治顺带关闭既有 process.exit 缺陷）；MED-1 折进 B2 dispatch-open 测试矩阵。
5. **记忆索引 MEMORY.md 的 upstream-silence 行**已在工作区更新到新态但**未提交**（与 peer WIP 纠缠），下个碰 MEMORY.md 的会话一并提交。

## 0.2 实施状态（**2026-07-28 更新，本节是实施真相源**）

用户授权实施 + 定下硬约束「**绝不误杀合法长思考**」（已编码进 plan Global Constraints + 各 fork 裁定，commit `5874ea78`）。走 `superpowers:subagent-driven-development` 于**隔离 worktree**。

### ⚠ 接手必读：底座已变，B1 已被主线 supersede

- **master 在本特性分支开工后前进 128 提交**。**B1 已由主线自己落地并改进**：commit 窗口默认 `20 → 180`、ceiling `125 → 240`、并把窗口从 handler timer 重构成 **ingress-relative deadline**（`d0c8a8a4` / `da59c586`）。依据是 **Q1 首失败点实测闭合（2026-07-27）：CC pre-header 容忍 ≈300s，触发器 = undici 默认 `headersTimeout`**（非 SDK 的 1200/1250s、非 CC 响应头后才武装的 stream-idle watchdog；`API_FORCE_IDLE_TIMEOUT=0` 可关闭它）。本分支原先的「ceiling 125s / 默认 20 / 待跑 130-180s 阶梯」**全部作废**。
- **master 还重写了 delivery/heartbeat 生命周期**（`freezeHeartbeat` 语义、close-before-terminal-drain、心跳跨 block-level commit 存活，P6 已 approved）——这正是 Task 0.5 所在子系统。
- **本分支已合并 master**（`e951026a`，行级共存）：B1 相关全取主线新版；保留本分支独有的 B2 delta。合并后 typecheck 干净、全后端 **6512 pass**；期间 2 个失败经**同负载对照证明 master 也挂**（History V3 capture-performance flaky 家族，已在 backlog）。
- **B2 delta 仍为本分支独有**（`precontent_recovery` / semantic-content gate / `runRecoveryFromPreReadyFailure` / `runPreContentRecovery` 等符号在 master 上 **0 命中**）。

### 已完成（分支 `feat/upstream-silence-recovery`，未合回 master）

- **worktree / 分支**：`.worktrees/upstream-silence-recovery`（node_modules 已软链）。**按 SDD 纪律：全阶段 + 终审后再 ff 合并。**
- **进度 ledger**：`.worktrees/upstream-silence-recovery/.superpowers/sdd/progress.md`（gitignored）。**接手先读它**，已完成的别重派。⚠ 该 ledger 曾被并发 peer 内容污染过一次、已重建；**权威进度以本节 + git 提交为准**。
- ✅ **B1**（已被主线 supersede，见上；本分支的 B1 提交在合并中让位主线版本）。
- ✅ **B2-P0**（Task 0.1 + 0.7）——配置骨架 `precontent_recovery.enabled`（默认 true、**未接线**）+ telemetry outcome 计数器。零执行路径消费者（全仓 grep 证）、config.schema.json regenerate 零差异。
- ✅ **Task 0.2**（`a819834f`）——**delivery-level semantic-content gate（承载对抗审 CRITICAL 修法）**：gate 读 `hasEmittedRealClientContent`（**非** `boundary.result`——后者只在 `content_block_stop` 翻转、会漏「delta 已发 stop 未到」窗口致重复内容），翻转**复用既有** `onFirstRealContent` seam（`isClientContentFrame` 驱动、只数非-synthetic、只一次、live/buffered 共用）。主会话 + 异模型 reviewer 双重独立核实。
- ✅ **Task 0.3**（`eff92dc0`）——`coordinator.runRecoveryFromPreReadyFailure`（镜像 runHedge、parent-less、at-most-once、**不 settle parent**：primary 已自行 settle failed；有解释注释）。
- ✅ **Task 0.4**（`85b8c5c6` + backlog `50b09c00`）——`driver.runPreContentRecovery` + pre-ready failure ownership（存+rethrow 字节等价回归锁）+ **🔴 server-tool 双执行 gate 经异模型安全审计确认无绕过**（`classifyServerExecutionRisk` 在 dispatch 前、throw 非 continue、分类最终 target wire、`allowServerTools` 不在此路径）。
- ✅ **Task 0.5**（`41a351fa` + fix `5d386f72` / `325e3771`）——recovery sink lifetime supervisor。**plan Task 0.5 文本写于 heartbeat 重写之前，实施按现状适配**（5 处偏离全经 reviewer code-read 确证为正当）：只抑制 `close`/`finalize`，`freezeHeartbeat`/`suspendHeartbeat`/`resumeHeartbeat` 原样转发；`settleFinal()` 为幂等 `Promise<void>`（await 异步 `session.terminate()`）；**新增 `inheritDownstreamDeliverySession`**（plan 未提、实施者从当前代码挖出的真实约束：driver 用 sink 对象身份从 WeakMap 找 generation-owned delivery）。**未接线**。异模型 reviewer 自做 5 次 mutation 独立验证；2 条 Important 已闭合——(a) `await` 假绿缺口补守卫（正样本对照：删 `await` → 2 fail 真咬）；(b) Concern 事实订正 + `makeReconcilingSink` identity 缺陷登记 backlog。
  - **已知 concern（P4/P5 处理）**：`ClientSink.finalize` 类型声明 `void` 但 delivery 实际返回 Promise（`await-thenable`/`no-floating-promises` 均 off，lint 不会报）——接线时收紧为 `void | Promise<void>`。
  - **supervisor 所有权守卫**：`settleFinal()` **必须放进 owner 的 `finally`**，否则 owner 中途抛出会让 generation heartbeat timer 永久存活（unref 不阻塞退出，但会持续向已死客户端写 ping）。

- ✅ **Task 0.6**（`623fb34f`/`dbdc1ebc`/`424604d3` + fix `a24f8aec`/`8c7221c1`/`e2489b4b`/`513127af`）——**seal-race crash 安全**。① 守卫**整个** `recordOpened`（headers + timing 整体丢弃）+ 三个 timing setter 全对齐 `if (sealed) return`；**`assertWritable` 对语义写的 loud-throw 未放宽**（reviewer 逐一核对 21 处调用点 + 正反双侧 oracle）。② quiescence join 经 reviewer 四点 code-read 核实「supervisor 只包 `ClientSink`、真拿不到 candidate lifecycle」属实 → **授权延后 P4/P5**（backlog 改写保留为余项、非删除）。**这条顺带关闭了一个既有的 process.exit 缺陷**（不止服务 B2）：晚到 deferred-header 撞 sealed recorder 会把良性迟到观测放大成整进程退出。教训已沉淀进 skill `debugging-server-crashes`（变体 C）。
  - **reviewer 挖出的承重缺陷已修**：`unhandledRejection` 探针因 helper 里 `await request` 提供 live awaiter 而**结构上无牙**（三守卫全拆仍绿）→ 已补**真孤儿拓扑**用例、mutation 证其变红并捕获真实爆炸栈；`setAttemptTimingEpoch` 漏的对称守卫已补。seal-race 连跑 10 次 80/80。
  - **现状可达性（别夸大）**：主线 production primary 腿今天已被 operation scope 结构性护住；本守卫覆盖 mock/legacy ctx、candidate-discard/supersede，以及 **P4/P5 将新增的未注册 fresh recovery 腿**。

### 🎯 B2 地基（plan-2）**全部完成**；P4 已开工

- ✅ **Task 4.0**（`1c5ea173`）——**ready-态挂载点**（B2 两个挂载点的第二个：上游已 ready、pump 在跑、但在首个真实语义内容前失败）。新增 `driver.runResponseRecovery(upstream, env, reason)`，复用既有 `coordinator.runRecovery`。三条承重：① ready-态**自己**调 `classifyServerExecutionRisk`（不复用 pre-ready 的检查、不碰 `allowServerTools`）② 给 `runRecovery` 加可选 `retryNextStrategy`——**默认仍 `"buffered-retry"`**（既有 buffered 调用方零行为变化，有回归锁），B2 显式传 `"precontent-recovery"` 防 History 诊断混淆 ③ **零 handler 接线**（4.3 才接）。`tests/pipeline` 843 pass。
- **Task 4.0 的 review findings 已全闭合**（`a125e67e`/`22b04ac0`/`1e39a720`/`9cf8a8ee`/`796ef05b`）。reviewer 做了 4 组 mutation，**M4 存活**暴露一个真缺口：driver 侧的 `"precontent-recovery"` 实参丢掉后**全后端 4709 测试仍全绿**——两端各自被证（coordinator 默认值有锁、coordinator 能接受覆盖参数有锁），**中间那根线没被证**。已补独立 oracle（注入 recording callback 断言 `settleDispatch` 收到的 `nextStrategy`），正样本对照真咬。另：错误消息区分 pre-ready/ready-state、plan 注解订正（真正漂移的是**行号**不是路径）、Task 4.4 加 per-attempt 簿记待核项。
- **buffered 旁路已落 backlog**（主会话裁决，非静默砍）：plan Task 4.0 的 buffered 子任务本轮未做，条目含用户已裁定的 **`max_retries=0` 必须被尊重**语义 + 触发条件（live 路径接线完成后）。
- **漂移已重核并写进 plan-3**：`driver.ts` 在 `src/lib/pipeline/`（非 plan 草稿的 `generation/`）；live `stream-error` 分支现于 `handler-v4.ts:1382-1423`（plan 写的 `1279-1320` 已过时）；buffered `runRecovery` 调用现于 `driver.ts:1530`。

### 第二次合并 master（`d1c5a4b2`，2026-07-28）

master 又前进 **70 提交**且碰了 P4 的三个目标文件 → **动接线前合并**（本会话已为「建在过时底座上」付过一次代价）。仅 backlog 冲突（取并集），源码全自动合并；全后端 6602 pass / 8 skip / 3 fail，**3 个单跑全过**（2 个 Bun worker SIGILL——Bun 自报是它自己的 bug；1 个负载敏感 UDS sidecar）→ 与合并无关。

⚠ **验证工具的已知缺陷**：`parallel-test` 汇总在我修掉「恒报 0」后**仍欠计约 25%**（`test:backend` 4749 vs 直接命令 6614/644 文件；发现缺口与其他 CSI 序列均已排除）。**门的退出码是对的**（由各 shard 决定、真失败照样红），坏的是**证据行**——引用「N pass」时别当精确值。已入 backlog，根治方向=改用脚本已有的 junit XML 逐 `<testcase>` 计数。

### P4 进行中（逐 Task 更新，别等最后）

| Task | 状态 | 要点 |
|---|---|---|
| 4.0 ready-态挂载点 | ✅ 审清 | `driver.runResponseRecovery`；独立 gate；`retryNextStrategy` 覆盖 + driver 侧实参已有独立 oracle |
| 4.1 三模式 splice | ⚠️ **首版被审掉、已重划范围**（详见下方 4.1′） | 首版 `06dc6c29` 新增 `precontent-recovery-splice.ts` 门面，异模型审判 **MAJOR：多余间接层**——`handler-v4.ts:1251` 的 `liveReconcilingSink` 已是同一 `makeReconcilingSink` 构造，且生产 live 两条腿（`:1361` direct / `:1659` translate）已在用；恢复路径**不存在拿不到该 sink 的层级障碍**（`sink`/`anchorHooks`/`anchorState` 与 catch 块同在 `:1280` 解构的作用域）。主会话逐条 code-read 复核属实 → 采纳 |
| 4.1′ decorator 透明化 + 跨 attempt 复用 | ⏳ 进行中 | ① `makeReconcilingSink` 补 `inheritDownstreamDeliverySession` + 转发 `suspendHeartbeat`/`resumeHeartbeat`/`finalize`（现漏 3 个方法；对照组 `recovery-sink-supervisor.ts:41`）② 删门面 ③ 三模式验收搬到「同一条持久 decorated sink 跨 attempt 写入」测试，**必须含 `writeAnchor` 标记断言**（reviewer 的 mutation 证明首版此处假绿） |
| 4.2 触发判定 | ⏳ | `shouldAttemptPreContentRecovery`：非 client-abort ∧ 未交付语义内容 ∧ config 开 |
| 4.3 handler 接线 | ⏳ | **全特性最硬**；两挂载点；`settleFinal()` 必须进 owner 的 `finally` |
| 4.4 History settlement | ⏳ | 含 per-attempt 簿记待核项（`commitAttemptSseEvents`/`finalizeCurrentAttemptDuration`/`resetSseEvents`） |
| 4.5 协议级回归矩阵 | ⏳ | 三模式 × 5 失败形态 × 两挂载点 |

### 剩余（依赖序）

**P4 余下**（plan-3：Task 4.1 splice 纯函数 → 4.2 触发判定 → **4.3 handler 接线（最硬）** → 4.4 History settlement → 4.5 协议矩阵；两挂载点执行器 + 三模式 splice + handler 接线 + 协议矩阵——**全特性最硬的一块**；接线时一并解决：backlog 的 `afterHook`-vs-`preflight` env seam、`_reason` 透传、`ClientSink.finalize` 的 `void`-vs-`Promise` 签名、`makeReconcilingSink` 未继承 delivery identity、Task 0.6 ② 的 quiescence join，以及 `settleFinal()` **必须放进 owner 的 `finally`**）→ **B3**（plan-4，**默认关**，never-false-kill）→ 全分支终审 → ff 合 master。

⚠ **P4~P6 接线前务必重读 handler-v4/driver 现状**：master 的 ingress-deadline 重构 + heartbeat 重写已改动 plan-3 假定的接线点（plan-3 的 `file:line` 多半已漂移）。

### 续跑方式

新会话：读本节 + [plan kickoff](2026-07-23-upstream-silence-recovery/kickoff.md) + ledger → `superpowers:subagent-driven-development` **从 Task 0.6 起** → 每任务 fresh implementer（`gpt-souls:implementer`）→ 异模型任务 review（Claude `reviewer`）→ fix loop → 标 ledger。承重声称亲自 code-read 复核。

🔴 **派 agent 时把树向校验绑进每条承重命令**（2026-07-29 实测踩坑 + 评审推翻我的第一版判据）：委派消息里写「在 `.worktrees/upstream-silence-recovery` 工作」**不改变** subagent 的初始 Bash cwd（它继承会话启动 cwd，本会话即主树）。危险不在会不会报错，而在**退出状态不能证明它验证了目标树**：精确指定只存在于本分支的文件时 eslint / `bun test` 都会响亮报未匹配，但 `bun run typecheck` / `bun test tests/routes/` 这类宽选择器在主树**照常全绿**（实测 112 pass）。所以委派 prompt 要求：**每条承重命令自带同链校验** —— `cd /home/xp/src/copilot-api-js/.worktrees/upstream-silence-recovery && test "$(git rev-parse --show-toplevel)" = "/home/xp/src/copilot-api-js/.worktrees/upstream-silence-recovery" && test "$(git rev-parse HEAD)" = "<完整目标 SHA>" && <实际命令>`。**别用 `git -C <worktree> rev-parse HEAD` 当树向证据**——它在哪棵树跑都返回目标 SHA，零区分力。→ [记忆第四方向](../memory/reference-worktree-bun-add-needs-main-tree-install-after-merge.md)。

**验证命令注意**：`bun run test:backend` 的汇总行曾恒报 `0 tests`（bun 即使 piped 也上色、脚本锚定正则不咬），**已修**（master `5454616b`，正样本对照 0 → 4243 pass）。已知**既有** flaky：History V3 capture-performance 家族等 perf/时序测试在负载下会挂（master 同样），判回归以「单跑是否过 + 是否属该家族」为准。

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
