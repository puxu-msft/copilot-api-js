# CPU gap investigation：第二轮，主假设并发度

状态：进行中；主假设“每请求主线程 CPU 随并发度增长”已在本轮隔离 mock 端到端路径中证伪。核验基线：`5272af0e4826632a70af4e882cf1469525cfe6d6`，分支 `perf/cpu-gap-concurrency-43045809`，worktree `/home/xp/src/copilot-api-js/.worktrees/cpu-gap-concurrency-43045809`，测于 2026-08-11。

## 范围和不重复验证的事实

生产 4141/PID 3868381 从未被写入、发信号、重启或作为本轮负载目标。本轮只启动了隔离实例 `127.0.0.1:4305`，其 `XDG_DATA_HOME` 为 `/tmp/cpu-profile-43045809/concurrency-main-hypothesis-r4/xdg`，并使用本 worktree 中的 mock upstream hook。生产 1571 ms/请求与隔离顺序 191 ms/请求是不同时间、History DB、进程年龄和堆状态下的混杂观测；本轮不将它们当作同一组的并发因果证据。

## 被测对象与口径

被测对象是隔离服务主进程 PID 814168 的 `/proc/814168/stat` 字段 14+15，而不是启动它的 shell/bun wrapper。PID 由服务自身启动日志 `Process: pid=814168 sha=5272af0e-dirty` 提取，并额外核对 `/proc/814168/cwd` 等于本 worktree、cmdline 是 `bun run ./packages/cli/src/main.ts start --port 4305`。`CLK_TCK=100`，所以一个 tick 是 10 ms。

每一档固定 48 个请求、1,543,331 bytes 的 Anthropic 请求载荷、mock 上游 142 帧（`message_start`、`content_block_start`、137 个 delta、`content_block_stop`、`message_delta`、`message_stop`）。客户端实际验证每个响应均为 HTTP 200、含 `message_stop`、有 62 个 SSE event 和 57 个 `content_block_delta`；这是完整 HTTP→pipeline→hook→SSE→History 路径，不是孤立函数微基准。每次样本的计量区间前后读取 `/metrics`，`copilot_api_accepted_requests_total` 的增量均为 48，与客户端成功数相等；因此 CPU 分母不是猜测的请求数。

唯一变量是 client concurrency：每个批次同时发 1、2、4 或 8 个请求，批次之间等待完成。所有档位在同一 PID、同一 mock、同一请求载荷和同一实例中按 1→2→4→8 顺序执行。开始前顺序 warmup 12 个请求；每档独立重复 3 次。可复现输入、逐样本 JSONL、环境和服务日志保存在 `/tmp/cpu-profile-43045809/concurrency-main-hypothesis-r4/`；运行器是 `/tmp/cpu-profile-43045809/concurrent-load.ts` 与 `/tmp/cpu-profile-43045809/measure-concurrency.sh`。

## 结果

| 并发度 | 样本数 × 请求数 | CPU ms/请求：min / p50 / max | 相对并发 1 的 p50 | 墙钟时间范围（每 48 请求） |
|---:|---:|---:|---:|---:|
| 1 | 3 × 48 | 202.50 / 205.21 / 215.83 | 基线 | 7.99–8.60 s |
| 2 | 3 × 48 | 193.33 / 219.17 / 231.04 | +6.8% | 7.59–13.37 s |
| 4 | 3 × 48 | 215.00 / 233.13 / 248.13 | +13.6% | 9.97–18.50 s |
| 8 | 3 × 48 | 177.92 / 193.75 / 203.96 | −5.6% | 7.19–8.65 s |

并发 4 的 p50 略高，但并发 8 反而低于并发 1，且各档范围重叠。整个观测跨度 177.92–248.13 ms/请求，远大于可支持单调 1→2→4→8 增长结论的稳定信号。墙钟单请求延迟在并发下变长是排队现象，不能替代主线程 CPU/请求指标。

结论：在此 mock 形态、无 History WS subscriber、全新隔离 History DB 的端到端路径中，主假设证伪。并发 1→8 没有把主线程 CPU/请求推向生产的 1571 ms/请求量级，因而不能解释生产与 harness 约 8 倍的差距。

## 已排除的伪结果

第一次试跑 `concurrency-main-hypothesis-r3` 错把 `bun run` wrapper PID 778804 当作主服务 PID，所有差值为 0。该组已明确废弃，未参与上表；r4 改为从启动日志取实际主进程 PID 814168 后重跑全部档位。

`/sys/fs/cgroup/cpu.max` 与 `memory.max` 在此 WSL cgroup mount 中不可读，故没有把宿主或 cgroup 配额值写成事实。测量期间 `/proc/pressure/cpu` 的 `some avg10=12.73`、`avg60=20.37`、`avg300=30.34`，说明环境存在 CPU pressure；它是所有档位共享但仍会增加样本波动的噪声来源，不能归因给服务代码。

## 代码路径读证与下一步

`src/lib/history/in-flight.ts:26-34` 说明 summary cache 按 `HistoryEntry` 对象身份缓存，而 `updateInFlight` 在 `:58-63` 每次创建新对象；`src/lib/history/entries.ts` 会在更新后发布 `history.entry_updated`。`src/lib/ws/broadcast.ts:249-254` 仅在存在订阅客户端时序列化和发送。因此本轮没有触发的 History WS subscriber 候选仍未验证，不能据源码宽度断言其贡献。

主假设已证伪后，已按协调方重排先验证本地 h2 传输/摄入路径，结果见下节。后续仍是常驻 History 状态规模与 History WebSocket subscriber；两者都必须分别做调小/移除后的反向对照。真实 GHC 的公网 h2 session 仍未验证，且不应为此消耗额度。

结构怪味扫描：`/tmp/cpu-profile-43045809/measure-concurrency.sh` 的初版在 `concurrency-main-hypothesis-r3` 使用启动 wrapper PID，属于“测量对象与声称对象不一致”；本轮已修正为从服务日志提取主进程 PID 并以 cwd+cmdline 验证，废弃旧数据。仓库源码未改；唯一 worktree 代码侧未追踪文件是故意加载的 benchmark hook `hooks/cpu-profile-mock.ts`，不纳入提交。

反思：内部替代方案是用 eBPF/perf 读取实际主进程 CPU，但当前 `/proc` 方法与生产既有口径同构，且本轮已通过服务日志 PID 和 `/metrics` 分母交叉验证；判据能拒绝失败响应、SSE 截断和错计请求数，但尚不能隔离环境 CPU pressure；没有需要引入的第三方基准框架，Bun fetch 驱动真实 HTTP、服务和 History 路径比手写函数基准更贴近目标。


## 第三轮：本地 h2 传输与分块 SSE 摄入

状态：已完成。本轮从当前 `master` 的 `5257ed1f2b817fb6dd08b2c9b63cdf4287c86a85` 新建隔离 worktree `/home/xp/src/copilot-api-js/.worktrees/cpu-gap-transport-43045809`，在同一代理主进程 PID 921761 内交替执行 A/B。生产 4141/PID 3868381 未被触碰。

A/B 唯一变量是 `exchange` hook 的模式：A 直接 `streamOf` 142 个既有 mock frame，B 改为 `next()`，经 `ghc_api_base_url=https://localhost:4311` 调本地 TLS HTTP/2 假 GHC。两者请求载荷都是 1,543,331 bytes、客户端均验证 62 个 SSE event、57 个 delta 和 `message_stop`。B 的假上游逐 frame 分三次 `stream.write`，每请求 142 frame、426 次 write；其自身 HTTP/2 `/models` probe 的 ALPN 为 `h2`；A/B 样本结束时的即时核验中，B 的 152 次请求均记录为 `POST /v1/messages`、142 frame、426 writes。后续 profile 继续使用同一 fake，因此该累计日志随后增加；结论只引用即时核验的冻结计数。因而 B 没有被 hook 短路，且确实走过 TLS/h2、分块 byte→string、SSE 半帧重组与后续 response pipeline。每个样本的 accepted-request metric 增量均为 48，与客户端成功数相等。

| 组别 | 重复次数 × 请求数 | 主线程 CPU ms/请求：min / p50 / max | 相对 A p50 | 墙钟范围（每 48 请求） |
|---|---:|---:|---:|---:|
| A：hook exchange 短路 | 3 × 48 | 232.29 / 244.38 / 251.46 | 基线 | 9.75–10.27 s |
| B：本地 TLS h2、分块 SSE | 3 × 48 | 637.50 / 648.13 / 650.42 | +165.2% | 34.52–35.18 s |

结论：传输/摄入路径是已证实的 CPU 成本来源。B 相对 A 的 p50 增量为 403.75 ms/请求，三次样本范围不重叠。这不能直接外推为生产总差距的精确份额：本地 upstream 不含真实 GHC 的网络延迟、拥塞、连接复用与上游帧字节分布，且本实验刻意以每 frame 三个 write 放大了 chunk 边界；它只证明“hook 绕过的路径”足以贡献数百 ms 主线程 CPU，不能证明其中任一子层是唯一根因。

B 的 `--cpu-prof` 覆盖 8 个 warmup + 64 个顺序请求，持续 69.78 s、18,822 个 1 ms samples；可比 A profile 覆盖相同数量请求，持续 29.80 s、12,267 samples。B 中 native `freeze` self 为 16.93 s，对比 A 的 3.47 s；native `stringify` 为 3.43 s，对比 A 的 216.5 ms。相反，`parseOwnedSse` 在 B 的 self time 合计不足 0.4 s，不能独自解释约 404 ms/请求的差值。profile 因此将下一步定位收窄为真实响应进入后触发的 freeze/serialization/capture 路径，但它本身不是“某帧就是根因”的因果证据；要进一步归因须对候选 capture/freeze 机制做关闭或降频反向对照。

本轮失败且已处理的配置接缝：`https://127.0.0.1:4311` 被 h2 客户端拒绝，因为 TLS ServerName 不允许 IP；改用包含 `DNS:localhost` SAN 的本地证书和 `https://localhost:4311` 后，独立 h2 probe 与代理请求均成功。这是同一 h2 实验的正确配置，不是改用 HTTP/1.1 或 hook 旁路。

结构怪味扫描：外部 benchmark 启动命令的 wrapper PID 与实际 Bun 服务 PID 不同；继续沿用先前的“从服务启动日志提取 PID，再以 cwd+cmdline 验证”的测量规则。本轮不修改产品源码，worktree 内的 hook 是临时测试资产，结束时删除，不进入提交。


## 更正：传输成本口径

此前 B（3 writes/frame 且每 write `delay(0)`）相对 hook 的 +404 ms/请求包含装置强制事件循环轮转。C2（12 writes/frame、无 delay）p50=423.75 ms/请求，低于 B=648.13 ms；因此“真实传输 +404 ms”的推论已修正，当前受控传输态相对 hook p50=244.38 ms 的差约 +179.38 ms。真实 GHC 分块数与生产份额仍未实测。

## 第四轮：分块粒度扫描，以及它暴露的装置假象

先扫了「每 frame 的 `stream.write` 次数」，其余固定（1,543,331 B 载荷、142 frame、3×8 样本）：

| 每 frame write | 总 write | CPU/请求 p50 |
|---:|---:|---:|
| 1 | 142 | 357.5 ms |
| 3 | 426 | 652.5 ms |
| 12 | 1704 | 2035 ms |
| 48 | 6816 | 5969 ms |

**该轮曾被记为「强烈超线性」，这个刻画是错的。** 那三个 p50 增量（295 / 1383 / 3934 ms）对应的 x 轴步长并不相等（+284 / +1278 / +5112 次 write）；按 write 数归一化后边际成本是 1.04 / 1.08 / 0.77 ms per write，**基本恒定，即近似线性**。教训：在不等间隔的横轴上直接比较增量会得出错误的曲线形状。

随后做了 C1/C2 对照，固定 12 write/frame，唯一变量是每次 write 之间是否 `await delay(0)`：

| 形态 | CPU/请求 min / p50 / max |
|---|---:|
| C1：有 `delay(0)` | 2020 / 2035 / 2088.75 ms |
| C2：无 `delay(0)`，背靠背写 | 412.50 / 423.75 / 463.75 ms |

**C2 比 C1 低 79.2%。** 所以上表那条「分块敏感度」主要是 `delay(0)` 每次 write 强制一轮事件循环所产生的装置开销，**不是每 chunk 的摄入成本**。任何据上表外推到真实网络分段数的推论（含「约 0.84 ms/chunk，线性，可解释缺口」）**均已作废**。

这同时反过来修正了第三轮：B 组用的正是 3 write/frame **带 `delay(0)`**，所以它的 648 ms 里含约 224 ms 装置开销。同口径下真实传输路径的贡献应记为 **+179 ms**（C2 的 423.75 − hook 的 244.38），而非 +404 ms。

## 第五轮：常驻状态规模（D2 门槛未通过，机制被否）

假设：生产的 2.25 GB RSS / 2110 条 History / 4 小时运行时长是剩余缺口的主因。

门槛实验（进入 CPU 对照前先验证 RSS 真的涨上去）：

- 生产库以 SQLite read-only backup 复制出 583,434,240 B、含 3,162 条 `v3_operations`（源库未写入，4141/PID 3868381 未触碰）。
- 空库实例：`VmRSS` = 170,176 KiB。
- 同配置大库实例：`VmRSS` = 203,332 KiB，**仅高出约 33 MB**。
- 另一次带 `--history` 的大库实例在日志显示已打开 DB 后，**超过 5 分钟仍未监听端口**。

**结论：机制不成立。** History 库在磁盘上，应用不会把它整体读入堆；大库不产生大堆，因此生产那 2.25 GB 堆**不是 History 库撑起来的**，这条假设无法通过「预置大库」来检验。CPU 对照因门槛未过而未进行。

**副产物（与本调查目标无关，但值得单独跟进）**：583 MB 的历史库会让启动在打开 DB 之后长时间不进入监听状态。当前生产实例因为在 08:11 轮转过库而未遇到；若不轮转，重启会变得极慢。

## 总账与结论

| 项 | CPU/请求 | 状态 |
|---|---:|---|
| 生产实测（4141，180 s 窗口 / 38 请求） | ~1571 ms | 目标 |
| harness：hook 短路，不走传输层 | 244 ms | 基线 |
| 真实传输路径贡献（同口径） | +179 ms → 424 ms | 已证实 |
| ├ 递归深冻结 `freezeCapturedValue` | 42 ms | 已用反向对照实测可回收 |
| └ 其余传输成本 | ~137 ms | 未细分 |
| **仍未解释** | **~1150 ms** | **隔离手段已穷尽** |

已排除的候选，逐条附依据：

| 候选 | 结论 | 依据 |
|---|---|---|
| 并发度 | 证伪 | 同实例只变并发 1/2/4/8，CPU/请求不升（8 低于 1） |
| 响应帧数 | 排除 | 生产 100 条 `output_tokens` mean=628；mock 的 142 帧 ≈ 生产均值 |
| 请求体规模 | 排除 | harness 载荷 1.54 MB > 生产均值 869 KB |
| 重试 / 多尝试 | 排除 | 生产 100 条全部 `attemptCount: 1` |
| 后台任务 | 排除 | 10×30 s 窗口回归，截距约 3.7% 单核 |
| SSE 拼接 / 解析本身 | 排除 | `parseOwnedSse` self time < 0.4 s；上游累积是 `push()`，O(1)；`[...forwardedSseEvents]` 只在终态路径调用，不在逐帧循环内 |
| 分块粒度敏感度 | 装置假象 | C1/C2 相差 79.2% |
| 常驻状态规模 | 机制被否 | 大库只让 RSS 高 33 MB |

**结论：现有隔离手段最多复现到 424 ms/请求，无法复现生产的 ~1571 ms。** 继续做隔离实验的边际收益已经很低；下一步应改为**在生产进程上做直接归因**，而不是继续构造更像生产的隔离环境。

## 方法论教训（本调查两次被测量装置骗到）

1. **跨 commit 对照被机器负载漂移污染**：先前报出的 504 → 229 ms/请求（−55%）在同会话严格 A/B 下变成 202 → 191 ms（−5.4%）。同一个 before 状态两次测得 504 与 202，差 2.5 倍。
2. **`delay(0)` 被当成每 chunk 成本**：第三、四轮的 +404 ms 与「0.84 ms/chunk」都含事件循环轮转开销，同口径下降到 +179 ms。

两次都是**在拿到同口径对照之后才暴露**。因此：**没有同口径对照的性能数字应默认视为可疑，包括自己算出来的**。

另一条独立教训：**profile 的 self time 不能当作「可回收量」**。`freeze` 在 B 组 self time 折算约 187 ms/请求，而关掉递归深冻结的反向对照只回收了 42 ms——高估 4.5 倍。原因是同一个 self-time 桶里混着未被该变异触及的其他调用路径。
