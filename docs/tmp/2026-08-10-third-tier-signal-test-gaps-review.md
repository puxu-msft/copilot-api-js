## 落地状态（2026-08-10 收口）

**8 条全部处置完毕**，其中 7 条本轮改完、1 条（G3）拆出并登记 backlog。逐条落点：

| # | 处置 | 落在哪个 commit / 位置 |
| --- | --- | --- |
| G1 | 已修 | `fix(shutdown): stop the tier-2 banner from overstating what it did` —— `mock-tracker` 现在镜像 `settled` 早返回与 `blocker !== "none"` 的不移除规则（`releasesOnSettle`）；新增「已 settled 仍在 finalizing」用例，变异对照咬中且只咬中它 |
| G2 | 已修 | 同上 —— `abandonDrain` 返回 `{started, terminated, finalizing}`，settled operation **跳过而非空转**（对它调 `reapInFlight()` 会中止其 finalization 正在用的 signal），横幅分开报数 |
| G3 | **拆出，已登记** | `docs/todo/deferred-backlog.md` 同日新条目 + 三档 ADR 内加⚠️ 段。**本轮 commit message 的「never reads as a timeout」已在 ADR 中明确更正为只对了一半** |
| G4 | 已修 | 同 G1 commit —— 新增 `describeDrainAbandonment`，drain 未开始时如实说「the drain has not started yet」且不含 "now flushing"；变异对照（把 `started` 恒置 true）咬中 |
| G5 | 已修 | `test(shutdown): pin tier 2's deliberate skip of lightweight operations` —— lightweight 替身**故意带上可用原语**，否则丢失判别式只会掉进 catch 里继续绿 |
| G6 | 已修（含更正过度声称） | 同 G1 commit + `docs:` commit —— PTY 断言改钉「选中第二档且存活」，skill 明写「**没有任何一层证明第二档之后会干净 exit 0**」 |
| G7 | 已修（判据声称降级） | `docs: weaken two claims this round overstated…` —— 实测四格证明它测的是「此刻有没有别人持着事务」且需 WAL 非空；ADR 改名 `-live-connections` → `-lock-contention`、三处入链同步、复现步骤写进 ADR |
| G8 | 已修 | `fix(history): restore busy_timeout even if the VACUUM probe throws` |

**评审报告本身的一处更正**：G7 说「真正危害形态（writer）里 VACUUM 本来就会被吞掉」——主会话独立探针发现判据比评审描述的**还要窄一层**：`busy` 非零还需要 **WAL 非空**，空 WAL 时恒 `busy:0`。已按实测写进 ADR，未沿用评审的表述。

---

# 三档信号 / VACUUM gate —— 测试判别力评审与处置

> 评审者：`reviewer`（Claude 驱动，独立实例，未参与实现）。评审范围：分支 `worktree-shutdown-third-tier-signal` 的 commit `3e2d7ae2..6dace278`。
> 该 agent 的 `Write` 未启用、Bash 重定向被 worktree 守卫拦截，故报告由主会话代为落盘；**内容为其原文结论，处置栏是主会话的裁决**。
> 结论：**0 blocker，3 major，5 minor**。三次变异对照全部有效，但它们只证明「已写判据在那三种坏实现下会红」，覆盖面缺口如下。

## 主会话已亲自复核的关键条目

**G1 与 G2 的机制主会话逐行复核过，证实成立**（不是照单全收）：
- `src/lib/context/manager.ts:427` —— `if (!ctx || ctx.operationLifecycle.blocker !== "none") return`，blocker 非 `none` 时 release **直接返回、不删除**。
- `src/lib/context/manager.ts:484-487` 注释明写这是**有意**行为：`release() is a no-op and the ctx stays visible via getTrackedOperationsSnapshot()/shutdown drain instead of silently vanishing — that is the intended "surface it, don't drop it" behavior`。
- `src/lib/context/request.ts:1912` —— `if (settled) return`，对已 settled 的 ctx，`fail()` 是 no-op。

## 处置表

| # | 级别 | 发现 | 处置 |
| --- | --- | --- | --- |
| G1 | major | fake 的 `fail()` 同步把请求移出集合，production 不会：drain 轮询的是 `operationScopes`，只有 `releaseTrackedOperationIfTerminal` 在 finalization settle **且** `blocker === "none"` 时才移除。于是「二档 → drain 落空 → finalize」这条因果链在测试里**由替身保证**。 | **采纳**。这与 ADR 已记录的「已知边界 2」是同一件事，但替身掩盖了它，使测试分不清「对主流形态有效」与「完全有效」。修 fake 镜像真实协议 + 补真实 manager 的 `.it`。 |
| G2 | major | 已 settled 但仍 tracked 的请求是 drain 残余主力；对它们 `fail()` 因 `request.ts:1912` 早返回而无效，但 `reached++` 照加 → 横幅「terminated N in-flight request(s)」**谎报**。 | **采纳**。计数对操作者撒谎，违反本项目诚实性纪律。 |
| G3 | major | `request.ts:1124-1126` 的 `reapInFlight()` **硬编码** `cancellationAbortError("stale-reaper", ...)`，消费者 `src/lib/error/forward.ts:573` 据此产出 **504「Request cancelled by our own clock (stale-request reaper Ns)」**。取消路径是**第二条独立的 provenance 通道**，`fail()` 的 attribution 修对了它却仍在撒谎——直接违反 `abort-provenance-tag-at-source-not-guess-at-boundary`，也与本轮 commit message 里「never reads as a timeout」的声称矛盾。 | **采纳，但拆出单独一轮**：需给 `reapInFlight(cause)` 加参数并在 `forward.ts` 分流表加分支，改动面超出本轮。登记 backlog。 |
| G4 | minor | 二档覆盖 `stopping`，但该阶段可能阻在无界的 `await drainAdmissionHandoffs()`（`shutdown.ts:396`）或 handoff 的 `freeze*`（`:421`）——二档对它们**毫无作用**，而横幅仍承诺 flushing。 | **采纳（改声称）**：横幅与文档不得承诺它做不到的事。本轮修措辞 + 登记能力缺口。 |
| G5 | minor | lightweight 的「有意不终止」未被钉住：删掉 `continue` 会让调用落进 catch，测试依旧全绿。 | 采纳，补混合 tracker 断言。 |
| G6 | minor | PTY fixture 用永不 resolve 的 `gracefulShutdownFn`，故 `activeDrainSource` 恒为 null，实跑横幅是 `terminated 0 in-flight request(s)`——**该层只钉住「二档不杀进程」+ 一条字符串，drain abandonment 与 flush 一件都没走**。且**没有任何一层证明「二档之后进程会自己干净退出（exit 0）」**。 | **采纳，且必须修正过度声称**：本轮 commit message 与 skill 都把 PTY 说成证明了新能力，超出它实际证明的范围。 |
| G7 | minor | VACUUM gate 采样的是「此刻有没有事务」，不是「有没有别的连接」。独立探针实测：peer 连接已开但**无事务** → `busy:0` → **放行**；而新增测试选的 reader 形态恰恰是放行也无害的那种（VACUUM 16ms 成功），真正危害形态（writer）里 VACUUM 本来就会被 `connection.ts:241` 吞掉——**有没有 gate 观测结果相同**。 | **采纳为「判据弱于其声称」**：gate 仍减少危害窗口，但测试钉住的是探针输出而非危害本身。修正 ADR 里的声称强度 + 登记。 |
| G8 | minor | `connection.ts:217-219` 的 `busy_timeout` 还原**只在无异常路径上**；`.get()` 在锁竞争下确实可能抛（探针实测 `SQLiteError`），异常被 `:241` 吞掉后该进程主 History 连接**终身停在 `busy_timeout=0`**。 | **采纳，本轮修**（`try/finally`）。明确 bug，代价极小。 |

## false-red 评估（评审者独立结论，主会话认可）

- unit 无时序依赖：`activeDrainSource` 在首个 await 前同步赋值，`abandonDrain` 全同步。
- PTY 的 `read_until(b"abandoning the drain wait")` 不脆在时间上（信号处理器同步 `emergencyWrite`，2s 余量，实跑 7 pass），**脆在耦合**：该字面量存在于三处且 fixture 被 4 个用例共用，改文案会一次打红 4 条。失败很响不静默，可接受。
- **潜伏陷阱**：`read_until` 隐含要求子进程此刻仍在 `stopping`/`draining`。补 G6 用例（跑真实 drain）时第二刀可能落在 `finalizing` 导致子进程立即退出，harness 会抛得像产品缺陷——届时必须换独立等待条件。
