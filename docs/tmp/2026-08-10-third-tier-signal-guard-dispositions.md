# 三档信号契约：既有 guard 的处置记录

> 依据 user-rule `63-engineering-practice` 的 `red-tests-may-be-guarding-something` `[hard]`——改测试前先落盘记录该断言守的不变量、依据来源、本次为何这样处置。
> **本记录不构成放行**：同规则要求「删除或放宽既有 guard，合并前必须交独立 reviewer 或用户裁决」。用户已裁决**契约本身**（见下），但每条 guard 的具体改法仍须 reviewer 复核。

## 裁决来源

用户 2026-08-10 在本会话裁决：shutdown 信号从两档改为**三档**——

| 档 | 触发 | 动作 |
| --- | --- | --- |
| 1 | idle 时首个 SIGINT/SIGTERM/SIGUSR2 | 停 ingress，**无界**等待已接纳 operation（不变） |
| 2 | drain 期第二个终止信号 | 中止残余 in-flight，**但仍走完 finalize**（持久化全部 flush） |
| 3 | 第三个终止信号 | 立即 `process.exit`，不等任何 barrier（原逃生舱语义） |

配套裁决：自动墙钟预算**可配、默认 0 = 无界**——界默认由操作者显式划，不由 shutdown 自行到期。

被这次裁决推翻的是已冻结 spec [2026-08-07-lossless-graceful-shutdown-drain.md](../spec/2026-08-07-lossless-graceful-shutdown-drain.md) 的**不变量 4**（「第二信号在所有非 `stopped` 状态立即强退」）。推翻理由见 ADR（本轮同时产出）：该 spec 删掉 `graceful_wait`/`abort_wait` 时，连带删掉的不只是「shutdown 自作主张按 deadline 杀请求」这个坏能力，还有**「有界墙钟 + 干净 finalize」这个好能力**——旧四步实现里 Step 2/3/4 无论走哪条分支**都会跑 `finalize()`**。删除后只剩「无界但干净」与「即时但有损」两个极端，而优雅重启的快速切换恰好需要中间那档。

## 关键的范围收窄：第二档只在「还在等请求」的阶段生效

新契约**不是**把逃生舱整体后移一档。判据是**当前在等什么**：

- `stopping` / `draining` —— 等的是**请求**。第二信号中止请求 + 继续 flush。
- `finalizing` / `notifying` / `failed` —— 等的是**持久化 barrier 本身**，那正是逃生舱要逃离的东西（`lifecycle.md:56`：「第二信号一旦进入 JS handler，绝不再等待这些 barrier」）。此处第二信号**仍然立即强退**，与原契约完全一致。

**这个收窄有一条现成的正样本对照**：既有测试 `second signal during history finalization exits immediately`（`tests/shutdown/shutdown.unit.test.ts:779`）在本次改动后**未经修改仍然通过**，证明 finalizing 分支的守护没有被削弱。

## 逐条处置

### 单元测试 `tests/shutdown/shutdown.unit.test.ts`

| # | 测试 | 它守的不变量 | 不变量是否仍成立 | 处置 |
| --- | --- | --- | --- | --- |
| 1 | `broken terminal feedback cannot prevent the second signal from exiting`:685 | **逃生舱不依赖终端**——`emergencyWrite` 抛错也不能阻止强退 | ✅ 完全成立 | 改为发**三次**信号后断言强退；不变量原样保留，只换触发档位 |
| 2 | `second signal during request drain exits immediately`:714 | drain 期第二信号立即退出、不等 drain | ❌ **被裁决直接推翻** | 重写为新契约：第二信号中止 in-flight 且**不**退出、第三信号才退出。**并新增**断言证明第二档确实中止了 operation 且 finalize 仍然跑完 |
| 3 | `second signal exits even before the graceful task enters its first step`:740 | **竞态**——首信号刚同步认领、异步 task 尚未开跑时，后续信号不得被丢掉 | ✅ 成立（这是「信号不丢」，不是「第几个信号退出」） | 改为三次信号；保留「早到的信号必须被计入档位」这一核心 |
| 4 | `second SIGTERM uses the conventional forced-exit status`:760 | 强退码 SIGTERM=143 / SIGINT=130 | ✅ 完全成立 | 改为第三信号后断言 143 |
| — | `second signal during history finalization exits immediately`:779 | finalizing 期第二信号立即强退 | ✅ 成立且**已实测未受影响** | **不改**，作为本次范围收窄的正样本对照 |

### PTY 测试 `tests/shutdown/shutdown-signals.pty.test.ts`

四条真实进程测试（`real foreground SIGINT: first starts graceful shutdown, second exits immediately`、`real foreground SIGINT exits 1 when the production diagnostic barrier has dropped data`、两条 `two-signal PTY ...`）守的是**真实进程**上的信号契约与退出码，价值最高（它们是唯一不经 mock 的一层）。处置：更新为三档时序。

`real SIGUSR2 during graceful shutdown does not terminate the process` 守的是 **SIGUSR2 幂等**，该不变量**未被本次改动触及**（`isTerminationSignal` 仍然把 SIGUSR2 挡在档位升级之外）。它出现在失败列表中**疑似级联**——同一 PTY fixture 的前序步骤期待第二信号退出而未退出。处置：更新前序时序后应自动恢复，**须复跑确认**，不得直接改断言。

## 本次实现留下的两个诚实边界

1. **第二档够不到 lightweight operation**——`LightweightInFlightOperation`（`src/lib/context/lightweight-model-operation.ts:30`）是只读描述符，无取消面。count_tokens / embeddings 因此不被第二档中止。它们按构造是短请求；真卡住时第三档仍是出路。**未为此新造取消基础设施**（user-rule `solve-the-task-before-building-proof-infrastructure`）。
2. **第二档不保证 registry 一定清零**——若某 operation 已 logically failed 却仍占着 registry（`lifecycle.md` 记录过的长驻留形态），`fail()` 会被 settled 去重、`reapInFlight()` 也未必让它离开。此时操作者仍需第三档。日志已显式告知下一步。
