# NGHTTP2_CANCEL 主线只读证据汇总

> 调查时间：2026-08-06 UTC。只读探测；未停止／重启 4141，未修改真实 History 或配置。证据等级：E1＝本轮运行态实测；E2＝当前主线源码／Git 对象读证；E3＝既有文档／历史记录（已尽量用 E1/E2 复核）；H＝待证假设。

## 1. 运行现场与证据边界

- **[E1] 4141 当前 listener**：`ss -ltnp 'sport = :4141'` 显示 Bun PID `3575452`，监听 `127.0.0.1:4141` 与 `[::1]:4141`。`/proc/3575452/cwd`＝`/home/xp/src/copilot-api-js`，argv＝`bun run ./packages/cli/src/main.ts start --restart`，进程启动于 `2026-08-06T20:39:27.120Z`；`cgroup` 为 `/init.scope`，stdout/stderr 指向 `/dev/pts/7`，journal 按 PID 无记录。
- **[E1] 运行版本指纹**：History detail 的 `process` 为 `pid=3575452`、`gitSha=fa2bfd2d`、`gitDirty=true`；主树 `.git/refs/heads/master` 为 `fa2bfd2d902af444517b2fed1a44428c8bb47367`，该 commit 时间 `2026-08-06T20:33:37Z`，早于该进程启动。由于 `gitDirty=true`，只能确认它从该 HEAD 的脏工作树启动，不能断言运行字节等于 commit tree。
- **[E1] 可用性**：初次 `GET /health` 三次均 HTTP 200，约 `1.94–1.98ms`；`GET /api/status` 三次均 HTTP 200，约 `0.340–0.741s`；`GET /history/api/entries?limit=1` HTTP 200，约 `0.752s`。但收尾复验同一 PID 时，`/health` 一次耗时 `8.691s`，紧接的 `/api/status` 在 10s 内零字节超时；随后 `/api/status` 又成功，三次 `/health` 恢复到 `1.55–2.15ms`。这直接证明运行态仍有间歇性长 stall／排队现象，但单凭 HTTP 延迟不能把原因归给 History scan、事件循环冻结或上游 I/O。
- **[E1] History 搜索限制**：`GET /history/api/entries?search=NGHTTP2_CANCEL&limit=100` 当前 HTTP 503，正文为 `History search sidecar could not serve the frozen target`。因此本轮没有用该端点重算冻结窗口内的 23 条；计划中的 `23` 仍是 [E3] 冻结调查数字。

## 2. 已完成的 transport 机制

- **[E2] TCP keepalive 已落地**：`http2-client.ts:createSession` 在直连 TLS socket 或 proxy raw socket 上调用 `setKeepAlive(true, keepAliveMs)`；`config.yaml` 默认 `tcp_keepalive_probe_delay: 15`。提交链含 `6d86be75`（真 undici subpath keepalive）及 `0b0e61a6`（0 真禁用）。
- **[E1] TCP keepalive 当前真实生效**：`/api/status.transport.configured.tcpKeepaliveProbeDelayMs=15000`；`ss -tnop | rg 'pid=3575452'` 显示该进程多条 GHC `:443` socket 带 `timer:(keepalive,约2–9s,0)`，不是 OS 默认小时级 timer。
- **[E2] H2 PING 已落地**：提交 `a1e97801`；每个 admitted session 以 `scheduleH2KeepalivePing()` 定时 `session.ping()`，默认 15s；GOAWAY 只 retire，timer 保留到 close。
- **[E1] H2 PING 当前配置已进入 session**：`/api/status` 显示 `h2PingIntervalMs=15000`，每条 H2 session 的 `effectivePingIntervalMs=15000`。但 ACK callback 仍是 `NOOP_PING_ACK`，所以当前不能证明 PING 是否 ACK、RTT、何时失去 ACK。
- **[E2] N=1 容量池已落地**：`aa320228` 将单 session 池改成按容量选路，`b5892380` 默认每 session 并发流上限 1，后续有 idle reap、per-origin hard cap 与 per-token creation lease（`3ff3781b`、`c878a7cd`、`47fd1b25`）。当前源码同步 reserve，避免两个 caller 抢同一 slot。
- **[E1] 当前状态与 N=1 一致但非完整证明**：`/api/status` 采样时同 origin 多条 session，单条 `activeStreamCount` 均为 0 或 1。状态 API 未暴露 max-stream config，故最终“运行配置确为 1”主要仍是 [E2] 默认／源码与运行形态交叉支持。
- **[E2] REFUSED／pre-response retry 已落地**：`NGHTTP2_REFUSED_STREAM` 被标为 `refused-stream`；任何 header 前 bare close 被标 `pre-response-close`；`classifyError` 将两者归为 `network_error`，复用 `network-retry`，`hasRetried` 至多一次。`mid-body-close` 明确终止为 `bad_request`。相关 commits：`2fffc4b9`、`b69a18fd`、`9be7aba7`。

## 3. 为什么 CANCEL 尚未被核心修复

- **[E2] generic CANCEL 被有意排除出 network retry**：`classify.ts` 注释与测试明确只准 REFUSED；`NGHTTP2_CANCEL`／`INTERNAL_ERROR` 可能已被部分处理。header 后错误被 transport 标成 `mid-body-close`，终止为 `bad_request`。这是避免重复执行／重复输出的协议边界，不是漏加字符串。
- **[E2] 本地 abort 也主动发送 `NGHTTP2_CANCEL`**：pre-response abort、post-response signal abort、ReadableStream cancel 都调用 `req.close(NGHTTP2_CANCEL)`。因此只看错误文字无法区分 peer RST 与我方 abort；generic retry 会把本地取消也误当上游瞬态。
- **[E1] 新鲜实例仍复现健康长流末端 CANCEL**：`req_1786048981227_99`（运行 PID 3575452／gitSha fa2bfd2d）在约 162.6s 后失败，已有 6031 个上游 SSE events，最后 token 到终止仅约 121ms，错误仍为 `NGHTTP2_CANCEL`。这排除了“所有 CANCEL 都是全程静默／TCP idle 被回收”，也证明现有 TCP keepalive、15s H2 PING、N=1 没有消灭全部 CANCEL。
- **[E1] 同一现场另两条 CANCEL 是长尾静默型**：旧一代 PID 3509159 的两条失败分别有 3509／5013 events，末 token 到终止约 107.9s／114.2s。说明当前样本至少含“活动输出后立即 CANCEL”和“活动输出后长静默再 CANCEL”两型，不能用单一 idle-reaper 故事覆盖。
- **[E3→E1/E2 部分复核] 既有历史事故**：2026-07-14 一条流实际 312s／3484 upstream frames，却被旧诊断误报 `frames=0`，最后 CANCEL；当前共享 frame diagnostics 已修复该计数器类缺陷，但 stream/session canonical 归因仍没有。

## 4. 已排除、未排除与 A4 缺口

- **已排除 [E1/E2]**：①“所有 CANCEL 都由 TCP keepalive 未生效”——内核 timer 在跑且新鲜 CANCEL 仍发生；②“所有 CANCEL 都是单 session 多流 blast radius”——N=1 已生效形态下仍有单流 CANCEL；③“所有 CANCEL 都是全程零帧静默”——新鲜样本有 6031 events；④“REFUSED 未重试”——已独立分类并重试；⑤“错误日志 frames=0 可当真相”——历史已证伪，须读 canonical upstream track。
- **未排除 [H/TBD]**：peer 主动 RST_STREAM CANCEL；session GOAWAY／close 对流的连带影响；本地 abort 与 peer CANCEL 混淆；GHC 单流／服务生命周期上限；flow-control 或 DATA stall；主线程 starvation 使 PING／ACK callback／stream callbacks 延迟；event-loop stall 与连续 CANCEL 的因果；fresh session 与老 pooled session 差异；buffered／continuation 在不同 commit 阶段的可恢复性。
- **[E2] A4 尚缺的 canonical diagnostic**：当前 `TransportDispatchOptions` 只有可选 `forceHttp`／`signal`，scheduler 已有 `dispatch` handle 却未下传；没有 `recordGenerationDispatchDiagnostic(dispatch, …)`；H2 session 无稳定 `session_id`，GOAWAY 只调用 `retire` 丢掉 code／lastStreamID／opaqueData；PING ACK 是 NOOP；stream 只在错误文本中偶尔带 `rstCode`，未记录 headersReceived／ended／local signal reason／transport reason／session snapshot；History 的 CANCEL attempt 没有 `diagnostics` 字段。
- **[E2] A4 canonical 目标**：两层 schema——有界 `H2SessionDiagnostic`（session identity、generation/lifecycle、GOAWAY、PING seq/ACK/RTT/outstanding、有效 keepalive/cap）与按显式 dispatch 归属的 `H2StreamDiagnostic`（stream ID、phase、RST code/name、headers/end、local cancellation provenance、transport reason、关联 session snapshot），终态落 canonical Attempt/History；不得把 session 事件任意归给一个请求或无标记复制给所有 sibling。

## 5. 下一步最小可证伪实验顺序

1. **先做 A4，不改行为 [E2 plan gate]**：显式 dispatch ownership → session/stream identity → GOAWAY/RST/local-abort/PING ACK RTT canonical History；h2c 双控先证明 peer CANCEL 与 local `req.close(CANCEL)` 可区分。
2. **校准 fake [H]**：用真实 Node/Bun `node:http2` 事件序列对照忠实 RST 制造方式（`stream.destroy(err)`，不用已知会假绿的 `stream.close(code)`），逐个注入 CANCEL／REFUSED／GOAWAY／session destroy／丢 ACK。
3. **固定负载单变量 A/B [H]**：非 4141 隔离实例先做 PING 15s vs disabled；只有拿到 ACK 与 stream close 时序后才比较 CANCEL 型别，不以一次成功裁决。
4. **再测 TCP keepalive [H]**：15s vs disabled，并用 `ss -tno` 作独立 L4 oracle；与 PING 正交，不同时改两项。
5. **starvation 因果 [H]**：正常 vs 注入等价 History scan 阻塞，记录 metronome max-gap、PING send/ACK callback delay、stream events；若可重复诱发同型 CANCEL，先修事件循环根因。
6. **session 生命周期 [H]**：N=1 保持，fresh-session-per-request vs pooled，比较 session age／GOAWAY／RST，判断是否为 session drain／age 型。
7. **最后才测恢复策略 [H]**：buffered／continuation on/off，严格按 pre-content、mid-body pre/post committed block 分型；只有独立 oracle 证明无重复、无丢失、完整终止符，才讨论该型 retry。不得加 generic CANCEL retry。

## 6. 结构怪味扫描与处置

- `src/lib/transport/http2-client.ts:95-115,228-262,551-572,1039-1179`——**职责堆叠／可观测性丢失**：session pool、保活、stream adapter、错误分类同文件，却没有 canonical event owner；**处置：本轮只读不改，A4 应以显式 dispatch + 两层 diagnostic schema 修根，不再补日志字符串**。
- `src/lib/pipeline/generation/dispatch-scheduler.ts:184-205` 对比 `src/lib/pipeline/types.ts:122-128`——**已有 identity 未穿透**：scheduler 持有 dispatch handle，transport options 丢掉它；**处置：A4 本轮计划修**。
- `src/lib/context/request.ts:1539-1548`——**legacy currentAttempt 归属泄漏**：transport 记录仍依赖 current attempt，hedge 并发可能错绑；**处置：A4 增显式 dispatch API 后逐步退役，不用全局 current attempt 兜底**。

## 7. 方法反思

- **更好的内部替代**：直接调 PING cadence 或给 `NGHTTP2_CANCEL` 加 retry 都比 A4 差，因为前者无 ACK/归因 oracle，后者混淆 peer 与 local abort；当前最佳内部路径是先补 canonical producer-side diagnostics。
- **判据判别力**：`/api/status` 配置快照只能证定时器被安排，不能证 PING 到达／ACK；`ss` 只能证 L4 keepalive，不能证流健康；History SSE events 能证流活动，但不能证 RST／GOAWAY 来源。三者必须组合，且 A4 要补最后一块。
- **成熟第三方方案**：HTTP/2 帧观测可借 Node `http2` 原生事件与 nghttp2 debug tooling 作校准 oracle，但 canonical dispatch 关联与 History 落盘是项目域模型，现成库不能替代；不应手写第二套 HTTP/2 实现。

## 8. 相关分支与复跑命令

- **[E2] 相关分支没有主线外增量**：`nghttp2-history-fixes`、`nghttp2-resume`、`h2-observability-block-delivery-docs` 的 tip 分别是 `50941d32`、`c23ed804`、`285dc571`，三者都是当前 `master` 祖先；`git diff --quiet master...<branch>` 均为 0。不能把分支名本身误读成 A4 已在旁支实现。
- **[E1] 现场复跑命令**：listener 用 `ss -ltnp 'sport = :4141'`；进程树／cwd／启动时间读 `/proc/<pid>/{stat,cmdline,cwd,cgroup}`；运行身份读 History detail 的 `process`；健康与读面用 `curl --max-time` 请求 `/health`、`/api/status`、`/history/api/entries?limit=1`；L4 timer 用 `ss -tnop | rg 'pid=3575452'`；CANCEL detail 用 `GET /history/api/entries/<id>` 后读取 `attempts[0].{error,timing,upstreamResponse.sseEvents}`。
- **[E2] 源码复跑锚点**：`src/lib/transport/http2-client.ts:140-175,228-262,528-572,991-1184`；`packages/foundation/src/error/{classify.ts:70-145,transport-reason.ts:21-51}`；`src/lib/pipeline/{types.ts:122-128,generation/dispatch-scheduler.ts:184-205}`；`src/lib/context/{types.ts:548-580,request.ts:1539-1548}`；计划门见 `docs/plan/2026-08-06-history-read-path-and-h2-diagnostics.md:141-176,185-215`。行号已按本轮读取的主线文件复核。
