# `/v1/messages` 主线程 CPU profile

## 结论

在隔离实例上，`/v1/messages` 的大请求 CPU 主要不在 JSON 解析、压缩或单独的 SSE 译码函数，而在同一个请求体被多次 `structuredClone`，以及 History 的 immutable `ModelOperationRecord` 构建／冻结。对 655 条消息的真实 History 请求体，10 次完整流式请求消耗 5.04 CPU-s，即 **504 ms/请求**；将 mock 上游从 142 个 Anthropic SSE 帧缩为 6 帧后，同样 10 次请求消耗 1.58 CPU-s，即 **158 ms/请求**。因此完整帧处理与记录路径的反向对照增量为 **346 ms/请求（69% 的该隔离负载 CPU）**。

这不是生产“3 s/请求”已经被完全解释的结论。隔离 mock 实例的 655-message 负载只有约 0.50 CPU-s/请求，低于生产观测约 3 s/请求；真实 GHC 上游帧形状、生产并发、常驻状态和本轮只抽取的一种请求体仍可能贡献其余差异。不能把这里的百分比外推为生产占比。

## 方法、代码与可复现命令

- **被测 commit**：`cbaff3c326d38c7daf43f98e5fde3d5af9f35e7b`；隔离 worktree：`/home/xp/src/copilot-api-js/.worktrees/main-thread-cpu-profile-43045809`，分支 `profile/main-thread-cpu-43045809`。没有改动共享主检出的源码。
- **隔离**：测试服务只监听 4245～4249；`XDG_DATA_HOME=/tmp/cpu-profile-43045809/xdg`，其中 token/config 从用户给出的参考目录复制，History、telemetry 与日志均写此目录。所有测试进程以其记录的实际 app PID 精确 `SIGINT`，完成 graceful History/Telemetry drain；没有触碰 4141 或 PID 3868381。
- **上游**：worktree 中的 `hooks/cpu-profile-mock.ts` 通过 `hooks.upstream_module` 的 `exchange` 返回合法 Anthropic SSE，不调用 GHC。长响应为 `message_start`、`content_block_start`、137 个 delta、`content_block_stop`、`message_delta`、`message_stop`，共 142 帧；短响应只保留 1 个 delta，共 6 帧。
- **请求入口**：真实 HTTP `POST http://127.0.0.1:<port>/v1/messages`，客户端持续读到 `message_stop`。因此覆盖 Hono handler → Anthropic codec → driver → hook exchange → 流式 processor → History/Telemetry settle；不是 isolated JSON 或 codec microbenchmark。
- **fixture**：用户给出的 `/home/xp/.claude/jobs/43045809/tmp/payload.json` 先用于 58-message smoke；随后只读访问 4141 的 `GET /history/api/entries` 与 `GET /history/api/entries/req_1786439643086_1124`，选取 655-message、28-tool、紧凑 JSON 1,891,296 B 的 production entry。重放前把 `max_tokens` 改为 512，HTTP 发送体为 1,543,331 B；请求内容没有写入本报告。
- **profile**：Bun 1.3.14 的 inspector 不提供 `Profiler` CDP domain，故使用 `bun --cpu-prof --cpu-prof-md --cpu-prof-interval 100`。对应 profile：`/tmp/cpu-profile-43045809/profiles/large-batch.cpuprofile.cpuprofile` 及 `.md`。它从进程启动到退出采样，含 2 次 warm-up、10 次计量请求、启动和 shutdown；函数百分比仅限该 11.58 s process profile，不能当作单请求精确百分比。
- **CPU 计数**：在 2 次 warm-up 后，读 app PID 的 `/proc/<pid>/stat` 字段 14+15；随后顺序完成 10 次请求，再读一次。`getconf CLK_TCK=100`。文件 `/tmp/cpu-profile-43045809/large-batch-cpu.json` 记录 500→1004 ticks，故 5.04 CPU-s／10 请求。

可复现的核心命令（worktree 根目录执行）：

```bash
XDG_DATA_HOME=/tmp/cpu-profile-43045809/xdg PROFILE_RESPONSE=long bun --cpu-prof --cpu-prof-md --cpu-prof-interval 100 --cpu-prof-name large-batch.cpuprofile --cpu-prof-dir /tmp/cpu-profile-43045809/profiles ./packages/cli/src/main.ts start --port 4248 --no-tui
PAYLOAD_PATH=/tmp/cpu-profile-43045809/payload-655.json bun /tmp/cpu-profile-43045809/load.ts 4248 10 62 57
```

`load.ts` 将非 200、缺少 `message_stop`、或者长响应不是 62 个客户端事件／57 个客户端 delta（短响应不是 6／1）判为失败。服务日志还记录长响应 `↑0 ↓137`，验证 137 个上游 delta 已进入完整 driver 路径；客户端事件较少是当前 stream assembler 的合并结果，不能把 62 当成上游帧数。

## 端到端计量与反向证据

| 口径 | 长 upstream SSE：142 帧 | 短 upstream SSE：6 帧 | 差异 |
|---|---:|---:|---:|
| 真实 655-message body | 1,543,331 B | 1,543,331 B | 相同 |
| 计量请求数（warm-up 不计） | 10 | 10 | — |
| 服务进程 CPU | 5.04 CPU-s，504 ms/请求 | 1.58 CPU-s，158 ms/请求 | **+3.46 CPU-s，+346 ms/请求** |
| 客户端 wall p50 | 459.3 ms | 130.6 ms | +328.7 ms |
| 客户端 wall min～max | 358.2～671.2 ms | 95.6～203.8 ms | 不作统计显著性主张 |
| 完成条件 | 200 + `message_stop` | 200 + `message_stop` | 两边均满足 |

这是一条正样本／反向对照：唯一有意改变的是 hook 生成的上游帧数；输入、端点、server 配置、History、客户端消费与轮次一致。它证明“逐帧路径”真实消耗大约 346 ms/请求，不证明其中任一个函数可被删除。

另有 58-message 用户 fixture 的 20-request 长响应 batch：wall p50 280.5 ms、min～max 196.6～733.9 ms；短响应 batch：p50 188.8 ms、94.9～583.8 ms。该组仅作方向交叉检查，未采 `/proc` CPU，不能用于量化前表的 CPU 差。

## 函数级热点

下表按 `large-batch` Bun CPU profile 的 self time 排序。profile 总窗口为 11.58 s、12,131 samples，含 startup/shutdown；“profile 占比”是整个窗口而不是 production request 的占比。`structuredClone`、`freeze` 的父调用按 cpuprofile sample stack 聚合，因而能定位到本仓函数。

| 排名 | 自身 CPU／profile 占比 | 函数或子系统 | 父调用／证据 | 性质判断 |
|---:|---:|---|---|---|
| 1 | 1.717 s／14.8% | native `structuredClone` | `cloneValue` 565.0 ms，`handleMessagesV4Admitted` 452.0 ms，`parseAnthropic` 353.3 ms，`buildWirePayload` 345.6 ms | 同一大 body 的多重边界复制。各处有 snapshot／mutability 契约，不能直接删；但四条完整深复制是已实测的重复成本，应收敛为一次 immutable ingress snapshot 加明确 ownership，而不是向 Worker 再复制一遍。纯计算本身可 offload，但 `postMessage` 同样 clone，未改数据所有权不会降低主线程总成本。|
| 2 | 1.175 s／10.1% | native `freeze` | `buildSnapshot` 547.5 ms，`snapshotDispatch` 277.2 ms，`freezeCapturedValue` 142.0 ms，candidate `deepFreeze` 103.2 ms | 必要的 History/operation-record immutability 工作，但当前终态 `buildSnapshot()` 重新 map/copy 整个 arena，且逐 frame capture 深冻结。它是可优化的数据表示／增量 seal 问题，不是适合简单 Worker offload 的独立纯计算。|
| 3 | 918.0 ms／7.9% | native `parse` | 863.2 ms 的调用方在 Bun profile 中是匿名 native frame；已命名的 Anthropic frame parser 合计很小（`parseFrame` 13.2 ms 等） | 需要继续细分。不能据此称 JSON.parse 是主根因，也不能判定可 offload；Bun stack 未把主要 native caller符号化。|
| 4 | 436.0 ms／3.8% | Hono `match2` route matcher | `node_modules/hono/dist/router/reg-exp-router/matcher.js` | profile 可见但无单独反向对照，且含启动／管理 GET。暂列未验证，不建议优化。|
| 5 | 81.9 ms／0.7% | `RequestContext.copy` | `src/lib/context/request.ts` | 候选／dispatch 状态复制；与前两类重复数据所有权有关。需要先合并 clone/snapshot 设计后再单独测量。|
| 6 | 66.6 ms／0.6% | `freezeCapturedValue` | `src/lib/context/model-operation-record.ts:602` | 同第 2 项的 immutable capture；必要但当前实现吞吐代价明确。|
| 7 | 61.8 ms／0.5% | `loadConfig` / `applyConfigToState` | `src/lib/config/config.ts` | 每请求 config hot-reload 相关路径。尚无关闭 hot reload 的端到端正样本，性质与优化空间未验证。|
| 8 | 35.4 ms／0.3% | `captureRewrite` | `src/lib/pipeline/stream/response-processor.ts` | 逐帧必要工作；在本 profile 中远小于 record/snapshot 成本，不能作为“3 秒根因”。|

源代码与 profile 的因果对应：`handler-v4.ts:662` 保存 client history body；`codec.ts:420` 保存 original snapshot；`request-preparation.ts:568` 对 wire 的 deep-clone fields 复制；`candidate-state.ts:118-136` 再 clone+deepFreeze。`model-operation-record.ts:602-614` 递归冻结；`:774-832` 在 `buildSnapshot` 复制 dispatch、payload/frame arena 与 candidate snapshot；`:1206` 在 terminal seal 时调用它。上述位置解释了采样栈而非仅凭火焰图猜测。

## 结构怪味审计

| 位置 | 怪味 | 处置 |
|---|---|---|
| `src/routes/messages/handler-v4.ts:662`、`src/lib/codec/anthropic/codec.ts:420`、`src/lib/anthropic/request-preparation.ts:568`、`src/lib/pipeline/generation/candidate-state.ts:118-136` | 同一 request graph 在四个层级重复 full deep clone，ownership 由局部约定而非单一 immutable ingress snapshot 表达。 | **本轮记为必须修的结构性性能项**；本任务只做 profile，不在共享树上改实现。下一步应在隔离 worktree 设计一次 clone、持久 immutable request representation 和 borrow/derive contract，并以本报告命令复测。|
| `src/lib/context/model-operation-record.ts:815-832` | 终态 History snapshot 重建完整 arena/dispatch/candidate graph；与 `freezeCapturedValue` 的逐节点冻结叠加。 | **本轮记为必须修的结构性性能项**；保持最终 record 不可变和 richest-data-flow，不削历史字段。候选方向是 persistent/append-only sealed nodes，避免 terminal 全量重建；需在真实 History 读写路径验证行为与 CPU。|
| `src/lib/config/config.ts:597,686,824` | config freshness 进入每请求热路径。 | 记 backlog，需要 `config.yaml` 不变时的 cache-hit/early-return 正样本对照后才决定是否为热点；不得凭 profile 一次采样改掉 hot-reload 契约。|

## 我没有验证什么

1. 未在生产 PID 3868381 上 attach、采样、发信号或重启；只以用户已给的 3 s/request 为目标基线。
2. 未打真实 GHC、未测真实 upstream 142 SSE 帧的字节大小／时序；hook frames 保证协议路径、不是上游成本的 oracle。
3. 未复现生产 3 s CPU/request，也未证明隔离 504 ms 与生产之间的 2.5 s 差来自哪一层。
4. 未证明四处 `structuredClone` 的任一处可安全删除；已证明其成本与调用位置，尚需由 ownership/History contract 设计裁决。
5. Bun profiler 含 process startup/shutdown；函数表不能作为严格每请求 attribution。`/proc` CPU 的 10-request counterfactual 是本报告中可量化的端到端证据。
6. 未处理 `/api/debug/dry-run-pipeline` 的 `Unhandled observability event variant: undefined`；按任务说明未把它扩展为修复工作。

## 试过但不可用的手段

- Bun inspector（`--inspect=9231`）能建立 WebSocket，但 `Profiler.enable` 返回 `-32601: 'Profiler' domain was not found`；因此不能以 request 边界 start/stop，只能以 `--cpu-prof` 进程 profile + `/proc` request-window CPU 组合取得归因。
- `perf` 不存在（`perf: command not found`），未安装系统包或改变机器环境。

## 产物位置

- 报告：`docs/tmp/2026-08-11-main-thread-cpu-profile.md`。
- 可复现 profile：`/tmp/cpu-profile-43045809/profiles/{large-batch,long-batch3,short-batch,idle-batch}.cpuprofile.cpuprofile` 与同名 `.md`。
- 负载器与计量 JSON：`/tmp/cpu-profile-43045809/{load.ts,payload-655.json,large-batch-measure.json,large-batch-cpu.json,large-short-measure.json,large-short-cpu.json}`。
- mock hook：`/home/xp/src/copilot-api-js/.worktrees/main-thread-cpu-profile-43045809/hooks/cpu-profile-mock.ts`。


## 同 commit A/B 复测

2026-08-11 在同一次会话、相邻顺序的隔离实例中重测：before 为 `db4d16efbb9d44b74e4a573e67ba0f74df7b1ce5`（4251），after 为 `49fb9e3200e1c8d93989ce8784f32dc8504dcc7a`（4252）。两端均用 `/tmp/cpu-profile-43045809/payload-655.json` 的 655-message、28-tool、1,543,331 B HTTP body；相同 hook mock 的 142 upstream Anthropic SSE 帧；各先 warm-up 2 次，后顺序完成 10 次请求，客户端验证 200、`message_stop`、62 client SSE events 与 57 client deltas。`CLK_TCK=100`，CPU 是 app PID 的 `/proc/<pid>/stat` 字段 14+15 之差。

| 版本 | 10 请求 CPU tick | CPU-s | ms/请求 | wall p50（min～max） |
|---|---:|---:|---:|---:|
| before `db4d16ef` | 202 | 2.02 | 202 | 135.0 ms（115.3～156.6） |
| after `49fb9e32` | 191 | 1.91 | 191 | 128.8 ms（117.9～160.2） |

严格 A/B 的点估计为 **-11 ms/请求（-5.4%）**。它远小于此前跨 commit 的 504→229 ms/请求差；由于 `/proc` 计数分辨率为 10 ms、每组仅 10 次且机器长期高负载，本轮不能主张统计显著的 CPU 改善。两端结果接近，说明早先大幅差异至少部分来自 commit/机器状态/启动后常驻状态差异，而不是本次单一 ownership 改动可稳定复现的 55% 收益。
