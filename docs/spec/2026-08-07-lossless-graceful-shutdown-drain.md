# 首信号无损排空规格

> 状态：已实施，**信号分档部分已于 2026-08-10 被修订**。
>
> 用户裁决：2026-08-07。首个终止信号不得制造已接纳请求的失败；进程等待这些请求自行进入终态。~~第二个终止信号仍立即强退。~~
>
> **2026-08-10 修订（ADR [三档 shutdown 信号契约](../decisions/2026-08-10-three-tier-shutdown-signal-contract.md)）**：本 spec 关于**第二信号**的全部条款（§2.4、§3.2 末段、§4 不变量 4、§6.1 末条，以及 §2.1 第 1 条的措辞）已被三档契约取代——仍在等**请求**时（`stopping`／`draining`）的第二个终止信号改为「中止残余 in-flight + 照常 finalize」，第三个才强退；已越过请求排空（`finalizing`／`notifying`／`failed`）的下一个信号仍立即强退。**本 spec 其余部分（无损 drain 本身、§2.2／§2.3／§2.5、不变量 1／2／3／5／6／7）继续成立且未被修订。**
>
> 阅读纪律：下文凡出现「第二信号必定强退」的表述，一律以本节与该 ADR 为准，不得按章节正文执行。

## 1. 问题

修复前的 `src/lib/shutdown.ts` 在首个终止信号后关闭入口，等待 `shutdown.graceful_wait`，随后以进程级 `AbortSignal` 中止所有剩余 operation。该行为把仍在正常工作的长请求改写成重试型 shutdown 错误。

2026-08-07 的 incident 同时出现三个受影响请求。用户日志与运行实例 History API 两种证据均显示：三个请求在同一秒以 `Server is shutting down` 失败；请求此前仍在接收上游 delta。运行实例的 `config.yaml` 将 `shutdown.graceful_wait` 配为 300 秒，incident 进程所运行的 `4c9c7aea` 版本会在该等待结束后执行 `shutdownAbortController.abort()`。这些证据证明错误来自现行自动 Step 3，而非客户端断开、stale reaper、请求 deadline 或 Step 1 提前拆除 h2 池。

固定增加 `graceful_wait` 只能推迟复发。模型耗时和请求规模没有可由 shutdown 正确预估的统一上界；请求自身已有 `timeouts.client_request_deadline`、`timeouts.upstream_request_deadline`、上游 header timeout、stream idle timeout 和客户端取消等终止机制。

## 2. 冻结契约

### 2.1 首信号

首个 `SIGINT`、`SIGTERM` 或 `SIGUSR2` 必须完成以下动作：

1. 同步认领 lifecycle，使紧邻的第二信号必定被识别为 post-claim 信号并进入分档路径（2026-08-07 冻结时该路径只有强退一档；分档见文首修订说明）。
2. 将状态置为 `stopping`，随后进入 `draining`。
3. 立即关闭 HTTP listener，并由 middleware 拒绝信号后进入的新请求。
4. 停止只属于后台维护的 producer，例如 History maintenance 和 Telemetry rollup。
5. 等待信号前已接纳的 operation registry 清零，不设置 shutdown 自有 deadline，也不发送进程级 shutdown abort。

### 2.2 已接纳请求

`RequestContextManager.getTrackedOperations()` 与 lightweight operation in-flight registry 共同构成“已接纳”的机械边界。generation context 从创建起进入 manager registry，直到 operation body quiesce、delivery finalize、immutable canonical terminal 发布完毕后才离开；不建 `RequestContext` 的 count_tokens／embeddings 从创建起进入 lightweight registry，在 terminal publish 完成后注销。

首信号之后，registry 中的 operation 必须保留完成工作所需的全部能力：

- 等待 rate-limit admission 或 retry backoff；
- 创建、复用和继续使用上游 HTTP/2 或 WebSocket transport；
- 检查或刷新 Copilot token；
- 运行策略重试；
- 写入 History、Telemetry 和 Diagnostic；
- 向客户端发送正常协议终态。

因此首信号阶段不得调用会拒绝或拆除这些能力的 `AdaptiveRateLimiter.rejectQueued()`、token runtime `dispose()`、upstream WS `stopNew()`、`closeAll()`、`closeHttp2Sessions()` 或 `server.close(true)`。

### 2.3 请求终止权

已接纳请求只由请求级机制进入终态：

- 正常协议完成或上游错误；
- 客户端取消；
- `timeouts.client_request_deadline`（整个客户端请求，跨重试不重置）；
- `timeouts.upstream_request_deadline`（单次上游尝试，烧完只中止该次尝试）；
- response-header、stream-idle 等上游 timeout。

首信号之后，每个 context 已武装的精确 deadline 与每次尝试的 attempt deadline 继续生效——shutdown 不触碰它们。

> **2026-08-11 推翻**：本节原句「shutdown 不再拥有请求终止 deadline」已不成立。shutdown 重新拥有 `shutdown.graceful_wait`（bundled 600s）与 `shutdown.abort_wait`（bundled 60s），裁决与「为什么这不是回到 2026-08-07」的完整论证见 ADR [2026-08-11-shutdown-owns-bounded-waits-again](../decisions/2026-08-11-shutdown-owns-bounded-waits-again.md)。要点：**当初有害的是到点后的动作**（进程级 abort、丢记录），而不是「有界」本身；新的到点动作是无损放弃排空，走完 finalize。

> **2026-08-11 更新**：本节原先还列有「stale reaper 在正常 serving 期间的泄漏兜底」，且首信号一步写作「停止 stale reaper」。该 reaper 已删除——它测的量与 `client_request_deadline` 相同、动作也相同，只是走周期扫描、最坏晚约 1.33 倍，故由精确 timer 完全取代。旧配置键 `timeouts.stale_request_max_age` 由 compat 层迁移到 `timeouts.client_request_deadline`。`reapInFlight()` 未退役，仍是第二信号 `abandonDrain` 使用的请求级取消原语。

### 2.4 第二信号

> **已被 2026-08-10 三档契约取代**（见文首修订说明）。以下为 2026-08-07 冻结时的原文，保留以说明当时的裁决；**当前行为以 ADR 为准**。

~~任何非 `stopped` 状态收到第二个终止信号，必须立即调用 `process.exit(128 + signal)`：SIGINT 为 130，SIGTERM 为 143。该路径不等待请求、持久化、通知或日志，也不尝试给客户端合成普通 API 错误。~~

现行契约：仍在等请求（`stopping`／`draining`）时的第二个终止信号**放弃 drain 但不退出**——用请求级原语中止残余 operation，随后照常走完全部 durability barrier；第三个才 `process.exit(128 + signal)`。已越过请求排空（`finalizing`／`notifying`／`failed`）时，下一个终止信号仍立即强退，因为那里在等的正是 durability barrier 本身。

~~这是 shutdown 唯一主动放弃在途请求的入口。~~ 现在有两个入口，且都由操作者按键触发、shutdown 自己仍不拥有任何时限：第二信号（有损于请求、**无损于持久化**）与第三信号（两者皆放弃）。

### 2.5 请求排空后的资源收敛

generation 与 lightweight 两个 in-flight registry 均清零后，shutdown 按以下顺序收敛资源：

1. Join generation finalizer registry，暴露排空期间记录的 canonical terminal 发布失败。正常 finalizer 工作已包含在 operation registry 内。
2. 释放 token runtime。
3. 关闭上游 WebSocket 和 HTTP/2 池。
4. 关闭 History、Telemetry 和 Diagnostic durability barrier。
5. 向观察者发布 `finalized`。
6. 关闭观察者 WebSocket 和残余下游 keep-alive 连接。
7. 仅在全部 durability barrier 成功后进入 `stopped` 并 resolve `waitForShutdown()`；失败则进入 `failed`。

资源关闭发生在 operation registry 清零后，因此不会中断已接纳请求。

## 3. 公共表面收敛

### 3.1 删除 shutdown 时间旋钮

删除以下配置和 state 字段：

- `shutdown.graceful_wait`；
- `shutdown.abort_wait`；
- `shutdownGracefulWait`；
- `shutdownAbortWait`。

同时更新 config schema、默认值、热重载、status 输出、样例配置、测试和文档。保留这些字段会错误暗示 shutdown 仍拥有请求终止 deadline。

### 3.2 删除自动 abort 基础设施

删除只为旧 Step 3 服务的 process-global shutdown `AbortController`、`getShutdownSignal()`、`isShutdownCausedAbort()`、`SHUTDOWN_ABORT_MESSAGE` 及 transport／stream 的组合信号接线。

`Server is shutting down` 仍可用于首信号后拒绝新 ingress 的 503 响应；它不得再成为已接纳请求的终态原因。

删除旧 `aborting`／`forcing` 生命周期状态及不再可达的 observer taxonomy。~~第二信号不发布阶段，因为它直接退出。~~ **2026-08-10 起**：第三信号不发布阶段（直接退出）；第二信号也不发布新阶段——它不改变 phase，只中止残余请求，随后由既有的 drain→finalize 路径继续发布。

## 4. 不变量

1. 首信号关闭 ingress，但不降低任何已接纳 operation 的能力。
2. shutdown 不以任何固定时间值终止 operation。
3. 请求级 deadline 仍能终止真正超时的 operation，防止首信号无限等待泄漏。
4. ~~第二信号在所有非 `stopped` 状态立即强退。~~ **已于 2026-08-10 被 ADR [三档 shutdown 信号契约](../decisions/2026-08-10-three-tier-shutdown-signal-contract.md) 修订**：仍在等**请求**时（`stopping`／`draining`）的第二个终止信号改为「中止残余 in-flight + 照常 finalize」，第三个才强退；已越过请求排空后（`finalizing`／`notifying`／`failed`）的下一个信号仍立即强退。修订理由：本 spec 删掉 `graceful_wait`／`abort_wait` 时，连带删掉了旧四步实现里「有界墙钟 **且** 干净 finalize」这一档（旧 Step 2/3/4 无论走哪条分支都会执行 `finalize()`），而优雅重启的快速切换需要的正是那一档。**本 spec 的其余不变量（尤其 2「shutdown 不以任何固定时间值终止 operation」）继续成立**——第二档由操作者按下、走请求级原语，不是 shutdown 自己的时限。
5. History、Telemetry 和 Diagnostic 在最后一个 operation 终态落盘前保持可用。
6. observer 只在 durability barrier 成功后看到 `finalized`。
7. `waitForShutdown()` 只在 `stopped` resolve；失败路径不 resolve 成功 latch。

## 5. 不采纳方案

| 方案 | 不采纳原因 |
| --- | --- |
| 增大 `graceful_wait` | 只移动失败边界；未来更长请求仍会被误杀。 |
| 仅让 `SIGUSR2` 无限排空 | 普通 SIGINT／SIGTERM 仍会把首信号伪装成“优雅”却制造请求失败，契约分裂。 |
| 有帧就续期 | 引入第二套 activity clock，静默 reasoning 仍可能被误杀，并与 request deadline、stream idle timeout 重复。 |
| 保留 Step 3 但改变日志级别 | 只隐藏症状，不修复客户端请求失败。 |

## 6. 验收标准

### 6.1 正确行为

- 一个已接纳 streaming 请求跨过旧 `graceful_wait` 边界后继续产帧并正常完成，客户端与 History 均无 shutdown error。
- 首信号后，已在 rate limiter 中等待的 context 可以获得 permit 并完成。
- 首信号后，已接纳但尚未打开 transport 的 context 可以新建上游 WS 或 HTTP/2 connection 并完成。
- 首信号后，已接纳 context 可以执行 token validity check／refresh 和策略 retry。
- generation 与 lightweight 两个 in-flight registry 均清零前，token runtime、上游 transport、History、Telemetry 和 Diagnostic 均未关闭。
- 两个 registry 均清零后，资源按 §2.5 顺序关闭并发布唯一终态。
- 新 ingress 在首信号后收到 503。
- ~~第二信号在 draining、finalizing、notifying 和 failed 状态立即以对应信号退出码强退。~~ **2026-08-10 起**：第二信号在 `stopping`／`draining` 中止残余请求但**不**退出，第三个才以对应退出码强退；在 `finalizing`／`notifying`／`failed` 仍立即强退。

### 6.2 反向控制

测试必须同时证明两类错误状态会失败：

- 若在首信号后调用 process-global abort、`rejectQueued()`、token `dispose()`、WS `stopNew()` 或 transport close，相关回归测试必须变红。
- 若删除请求自身 `client_request_deadline` 的终止能力，deadline 测试必须变红；无损 shutdown 不等于允许请求泄漏。

### 6.3 验证范围

实施完成后至少运行：

- shutdown、request deadline、rate limiter、upstream WS／HTTP/2、token refresh 定向测试；
- `bun run typecheck`；
- `bun run lint:all`；
- `bun run test:backend`；
- 结构性架构守卫。

不得停止或改动用户在 4141 端口运行的主服务器。黑盒验证使用受控测试 app 或其他端口。

## 7. 文档同步

实施时同步更新：

- `docs/lifecycle.md`：改为 stop ingress → lossless drain → durability finalize；
- `docs/DESIGN.md`：删除 shutdown 两个 state/config 字段；
- `config.yaml` 与生成的 `config.schema.json`：删除两个废弃旋钮；
- 运维样例：不再用 `graceful_wait + abort_wait` 计算 supervisor kill timeout；supervisor 必须允许首信号排空，操作者用第二信号显式放弃。
