# Q1 pre-header 实测与文档同步评审

> 评审进行中；按检查项增量记录，最终 verdict 见文末。

## 已核检查项 1：正样本与探针触达

- `curl --max-time 5` 的 abort 正样本成立：`exp/silence-recovery-gates/results/q1-firstfail/poscontrol.json:7-14` 记录 `/v1/messages` 在 `5002ms` 触发 `request.signal`；服务端监听逻辑位于 `exp/silence-recovery-gates/q1-abort-observer-server.ts:98-115`。
- 10s 成功端到端正样本成立：服务端标签由 `q1-abort-observer-server.ts:118-128` 写入合法 SSE；`results/q1-firstfail/smoke.client.json:5-8,55-60` 记录 exit 0、`num_turns:1`、`result:"Q1_PRE_HEADER_OK after 10001ms"`；对应服务端记录见 `smoke.observations.json:24-53`。
- 125s 新版本复现成立：`repro-125s.observations.json:9-15` 记录服务端在 `125002ms` 回答，`repro-125s.client.json:5-8,53-60` 记录 CC 2.1.220 成功、`num_turns:1`、`ttft_ms:125249`。
- 限定：10s smoke 是在当前探针代码提交前采集的旧变体。证据是 `smoke.observations.json:9-22` 把 `/api/hello` 算作 attempt 1 并静默 10s，而当前 `q1-abort-observer-server.ts:76-83` 会立即回答 `/api/hello` 且只记入 `probes`。它仍证明当次 `/v1/messages` 成功路径能通，但当前仓库不能逐字复跑该原始文件；建议在 FINDINGS 明示 evidence-producing revision，或用当前探针补一个短 smoke。

## 已核检查项 2：服务端候选层与 raw TCP 对照

- `idleTimeout:0` 的语义有本地 Bun 类型/文档独立支撑：`node_modules/bun-types/docs/runtime/http/server.mdx:216-220` 明写 `0 disables the timeout entirely`；探针实际设置见 `q1-abort-observer-server.ts:66-72`。
- raw TCP 对照确实走同一个服务进程、同一个 `/v1/messages` handler、同一 POST body 形状。会话记录中的命令直接启动未修改的 `q1-abort-observer-server.ts`，向 41941 发完整 HTTP/1.1 POST；git 对比显示 `d4d51658^` 与 `d4d51658` 的 server 文件 SHA-256 相同。`rawsocket.observations.json:8-21` 记录该 handler 在 `420101ms` 前没有 answer，直到裸 socket 自身 420s read timeout 后关闭才触发 abort。
- 420.1s 足以排除“Bun server 固定在约 300s 关闭连接”这一候选：它比客户端臂最大约 300.9s 多 119s。它不能证明服务端永不超时，但本次归因不需要证明无穷时长，只需排除约 300s 的共同服务端断点。
- 该对照还与 Bun 文档构成不同来源的双证，因此服务端 `idleTimeout` 不再是核心结论的缺口。原始 JSON 没保存裸客户端打印的 `still-open-at-420s` 字段，但 server 侧 `abortedAfterMs:420101` 已足以排除 server 在 300s 主动 close：若 server 先 close，`request.signal` 会在那一刻 abort，而不会等客户端 420s 后关闭。
- 代理环境/内核不构成当前 loopback 证据的 300s 候选：三臂 URL 都是 `127.0.0.1`，提交证据中的请求 Host 也均为 loopback；归因所依赖的裸 fetch 错误类型是 `UND_ERR_HEADERS_TIMEOUT`，而不是代理或 TCP reset 类错误。不过应把结论限定为本机 CC 2.1.220 所带 Node/undici transport 默认，而不是跨版本的“物理常量”。

## 已核检查项 3：A/B 数字与归因证据

- CC 四次 abort 数字可逐项在 `firstfail.observations.json:8-14,40-45,71-76,102-107` 找到：299667、300268、300280、300256ms。每次请求头都记录 `user-agent: claude-cli/2.1.220`、`x-stainless-timeout:1200`、runtime Node v26.3.0（同文件 `:26-36`，后续 attempts 同形）。
- SDK 控制数字可在 `sdkcontrol.observations.json:8-15` 找到 300001ms；其 1250s 自称值和 SDK/runtime 版本见 `:24-34`；客户端错误 `Request timed out.` 与总 elapsed 300022ms 见 `sdkcontrol.client.json:4-9`。
- `CLAUDE_STREAM_IDLE_TIMEOUT_MS=600000` 臂的 299813ms 可在 `idle-env-600s.observations.json:8-15` 找到；但原始 JSON 没有保存启动进程的 env，因此“该 env 确实注入为 600000”只能由标签/运行命令侧记录支持，不能由已入库 JSON 独立复核。源码读证仍表明该 watchdog 在 header 后才武装：参考 CC 2.1.207 `app.pretty.js:298119-298188`，`withResponse()` 返回后才调用 `he()`；版本漂移已在 FINDINGS 限定。
- **[major] bare-fetch 归因的客户端侧原始结果未入库。** `barefetch.observations.json:8-15` 只证明 server 在 300829ms 看见客户端离开；仓库内没有记录 `q1-bare-fetch-runner.ts:24-27` 打印的 `elapsedMs`、`cause.name`、`cause.code`。FINDINGS/spec/HANDOVER 使用的 `300887ms`、`HeadersTimeoutError`、`UND_ERR_HEADERS_TIMEOUT` 无法在用户指定的 `results/q1-firstfail/*.json` 找到。`q1-bare-fetch-runner.ts` 也没有被 `run-q1-firstfail.sh:56-66` 调用，故当前仓库缺少可审计的 invocation + client result。修复：把 runner stdout 写入 `barefetch.client.json`，记录 `process.version/process.versions.undici` 与全量 error cause，并给 shell 增加明确 barefetch arm；再用当前代码重跑一次。
- 机制侧独立证据支持该归因方向：本仓库安装的 undici 在 `node_modules/undici/lib/dispatcher/client.js:261-262` 把 `headersTimeout` 默认设为 `300e3`，其文档 `node_modules/undici/docs/docs/api/Dispatcher.md:202-203` 同样说明 300s。但这只能补强机制，不替代缺失的那次客户端原始结果。
- A 应收窄为“本机 CC 2.1.220、其内置 Node v26.3.0 transport 默认下，四个请求 attempt 的 pre-header 首次 transport abort 落在 299.667–300.280s”。“容忍度 = 300.0s”作为简写可用，但“物理上限”会把可配置/可升级的 undici 默认误写成协议常量。
- B 的精确表述应是“不是 Anthropic SDK 的 1200/1250s request timer，也不是 CC header 后才武装的 stream-idle watchdog；直接触发器与 undici 默认 `headersTimeout` 一致”。“不属于 CC”过宽，因为 undici/Node transport 本身就是 CC 2.1.220 的运行栈，而且版本或 dispatcher override 可改变默认。

## 已核检查项 4：推论 C/D 与当前代码语义

- **[major] `commit 在 T 秒 ⇒ 总预算 T+300s、天花板约 600s` 不是当前系统的成立不变量。** CC 的 post-header 300s 是 idle watchdog，不是 total timeout；CC 2.1.207 源码 `app.pretty.js:298187-298207` 在 header 后武装，并在每个非-ping event 调 `he()` 重置。历史实测 `exp/cc-idle-280s/REPORT.md:13-18,67-70` 也显示 ping-only 在约 300s 断，而空 content delta 能撑过 340s。
- 当前代理默认更直接地打破 `T+300` 算术：`src/lib/state.ts:410-424` 定义默认 200s 的 on-demand content escalation；`handler-v4.ts:1060-1112` 把它接入每条 Anthropic sink；`pipeline/delivery/session.ts:116-143` 到 content deadline 时发送匹配 open block 的 content delta，或在 pre-content 阶段注入 scaffold + 首个 content delta，并把 deadline 重新锚到该次写出。只要该机制正常工作，post-commit 300s 会被周期性重置，总预算不封顶于 `T+300`。
- 因而 C 只有在额外前提“commit 后始终只有 ping、没有任何可重置事件/内容升级、且上游也一直无非-ping 事件”下才成立；三份文档都把它写成无条件预算公式，进而得出“约 600s 天花板”，会误导默认值与架构取舍。修复：删除总预算/600s 断言；保留已证的较窄结论“无上限 pre-header 等待不成立，单个 attempt 必须在约 300s 前 commit 或接受 transport abort”。post-commit 可持续多久应另按实际 keepalive/escalation contract 描述。
- D 的机制分离成立：pre-header 触发器由 bare-fetch 错误类型与 undici 默认支持；post-header watchdog 有独立 CC 源码和历史真实 CLI 实测支持。数值相同可称“当前默认值相同”，但“数值巧合”属于因果解释，无法由两个样本证明；推荐改为中性事实“二者独立配置、当前默认均为 300s，不应合并预算”。

## 已核检查项 5：文档一致性检索

检索式：`rg -n -S '(≥125s|上界未知|首次失败点未测|Q1 未测|Q1 待测|pre-header 容忍度.*未测|真实 CC 300s watchdog|130s/150s/180s|130/150/180)' docs exp --glob '*.md' --glob '!docs/archive/**'`；另搜 `'(天花板 ~600s|总预算 T\+300s|当前 T=20.*320s|commit 在 T 秒)'`。范围为 worktree 内 `docs/` 与 `exp/` 的全部非 archive Markdown。

- **[major] 活计划总览仍把 Q1 写成开放门。** `docs/plan/2026-07-23-upstream-silence-recovery/README.md:5,77` 仍写 `Q1≥125s`、首次失败点未测、待 130/150/180s 阶梯；该 README 自称计划唯一总览/权威入口，会直接给实施者过时指令。
- **[major] 上一轮 handover 仍把补测列为剩余任务。** `docs/plan/2026-07-23-handover-h2-pool-and-silence-spec.md:7,15-20` 仍写 Q1 首失败点待补测，且明确要求阶梯；没有 superseded 指针。
- `docs/plan/2026-07-23-upstream-silence-recovery/plan-1-b1-widen-window.md:3-5` 虽加顶部订正，但正文 `:19-30` 仍保留“首次失败点未测/Q1 待测/补阶梯”的相反可执行步骤。顶部声明“下方多处过时”不足以让计划可执行，应该直接改正文与 checklist，避免 worker 按最近任务块执行旧步骤。
- spec 本身也有残留：`docs/spec/2026-07-23-upstream-silence-commit-timing.md:208,215` 仍把“真实 CC 300s watchdog”和“pre-header 容忍度未测”列为待验证/未测，与同文件 `:226` 的 Q1 已闭合冲突。
- 记忆/导航仍旧：`docs/memory/MEMORY.md:119`、`docs/memory/project-upstream-silence-commit-timing-spec.md:3,17` 仍写 `Q1=CC≥125s`；计划 README 与 handover 正会从这些入口被未来会话召回。虽非本轮点名的三份文档，项目要求全仓 grep 与 live-doc 同步，不能保留。
- FINDINGS 自身 `:5-28` 是带历史时间语境的上轮记录，可保留，但 `:28` 的“待续”应显式标注已由 `:30` 续测 supersede，避免搜索命中被误用。
- 三处 `T+300/~600s` 分别位于 `exp/silence-recovery-gates/FINDINGS.md:63`、`docs/spec/2026-07-23-upstream-silence-commit-timing.md:226`、`docs/plan/2026-07-27-keepalive-and-separator/HANDOVER.md:94,100`；它们一致地重复了同一个不成立推论，不是互相对账通过。

## 当前汇总

事实性发现计数：blocker 0、major 4 类（缺 bare-fetch 客户端原始证据；`T+300/~600s` 语义错误；活计划/交接残留开放 Q1；A/B 结论边界写得过宽）、minor 2 类（smoke 证据版本不可逐字复跑；raw/env invocation 元数据不足）。最终严重级别与 verdict 待最后一次交叉对账后冻结。

## 补充数字对账：CC 重试行为

- **[minor] “每次静默约 300s 后放弃、每次间隔约 2s”超出了原始记录。** `firstfail.observations.json:8-14,40-45,71-76,102-107,132-138` 只记录前四次分别在约 300s abort，第五次仅到达、没有被观察到 abort。由 `arrivedAtMs + abortedAfterMs` 计算的四个重试间隔约为 547ms、1047ms、2155ms、4057ms，呈增长序列而非固定约 2s。FINDINGS `:57`、spec `:226`、HANDOVER `:96` 应改为“观察到四个完整的约 300s timeout cycle，随后第五次 attempt 开始；重试间隔约 0.55/1.05/2.16/4.06s；最大尝试数未测”。
- 该问题不推翻 A/B，但会误导对重算频率、backoff 和“每次都已放弃”的理解。

## 补充探针代码审计与最终 verdict

- **[minor] `run-q1-firstfail.sh:56-59` 对 SDK control 的解释已被实测证伪。** 注释写“SDK 若和 CC 同时 bail，则 harness 在关连接、数字作废”；实际共同点是二者下层的 Node/undici transport，二者同在 300s bail 正是 B 的线索，不等于 harness。应把注释改为：SDK 臂排除 CC-only watchdog/request policy；共同 300s 仍需 bare fetch + raw socket 分层。
- **[minor] “精确首次失败点”混合了两个时间基。** 服务端 `q1-abort-observer-server.ts:98-110` 从 handler 已收到并解析请求后起算，而 undici `headersTimeout` 从客户端请求 dispatch/发送阶段起算；190100-byte CC body 使 attempt 1 的 server-side 299667ms 比 300000ms 早约 333ms。该探针能精确记录“server handler 视角的断开时刻”，不能单独给出 client-dispatch-relative 精确阈值。结合 `UND_ERR_HEADERS_TIMEOUT` 与 undici 300e3 默认，结论可写“约 300s 默认阈值”，不应把服务端毫秒值称作精确 CC 容忍点。

**总体 verdict：修复 major 后可进入下一阶段。blocker 0。** 核心方向中，A 在限定版本/运行栈后成立；B 的机制归因高度支持但仓库缺 bare-fetch 客户端原始 JSON；C 的“无上限 pre-header 等待不成立”成立，但 `T+300/~600s` 推论错误；D 的机制独立成立，“巧合”应改为中性事实。事实性发现：major 4、minor 5、nit 0。


# 复审：提交 `7ca4d23c`

## 复审结论

**verdict：仍需修复 major 后进入下一阶段。blocker 0。** 上轮核心机制错误已经被正确识别并在主要 spec/FINDINGS/plan-1 正文中订正，但提交存在两个确定的修复漏项：承重 `barefetch.client.json` 实际未入 Git；`T+300/~600s` 在 handover 与其源头 research 文档中仍有多处未标作废的活断言。另有当前记忆索引未同步。

## 事实性发现

- **[major] bare-fetch 客户端证据仍未入库。** 工作区能读到 `results/q1-firstfail/barefetch.client.json`，字段完整且与 server 侧对账，但 `git ls-files` 无该文件，`git status --ignored` 显示 `!!`，`.gitignore:27` 的 `exp/` 规则命中；`git show --name-only 7ca4d23c` 也只含 `barefetch.observations.json`。因此 fresh checkout 无法从仓库独立复核 `300986ms / UND_ERR_HEADERS_TIMEOUT / Node v24.16.0 / undici 7.25.0`。修复时须 `git add -f -- .../barefetch.client.json`；建议一并决定是否保存 final/server log，但承重必需项是 client JSON。
- **[major] `T+300/~600s` 并未全部删除。** 检索式 `rg -n -S '(头前预算 ~600s|预算 ~600s|总预算变 T\+300s|总预算 = T \+ 300s|钉死.*320s|T=250.*550s|静默 400s.*总 >550s)' docs exp --glob '*.md' --glob '!docs/archive/**' --glob '!**/review-q1-preheader.md'` 仍命中：`HANDOVER.md:102`；`research-keepalive-options.md:113-115,323,384,444`。其中 `research:310-317` 的订正是正确的，但上述位置仍以活结论、推荐矩阵、证伪步骤或证据分级出现相反断言，不能靠同文另一处订正消解。须逐处就地改写，尤其 `:444` 仍把错误的“头前预算 ~600s”标为“源码读证”。
- **[major] 当前记忆索引仍是旧状态。** `docs/memory/MEMORY.md:119` 仍写 `Q1=CC≥125s/Q2 未定论`，而 detail memory 已更新。该索引是项目规定的未来会话入口，不是历史审查记录；应同步成约 300s、有作用域的当前结论。
- **[minor] smoke 与 idle-env provenance 缺口仍在。** smoke JSON 仍来自 `/api/hello` 被计入 attempt 的旧探针形状，idle-env JSON 仍未持久化实际 env override。它们不推翻结论：smoke 的 `/v1/messages` 客户端成功结果与 server 标签双侧一致；idle-env 还有“watchdog 在 headers 后才武装”的源码证据。但 fresh checkout 不能逐字复现 smoke evidence-producing revision，也不能只凭 JSON 证明 600000 env 确实注入。建议补元数据或重跑，严重级别仍为 minor。
- **[minor] “undici 一段时间内的稳定默认”略越过证据。** `FINDINGS.md:56` 只直接观察到 Node v24.16.0/undici 7.25.0 的具名 `UND_ERR_HEADERS_TIMEOUT`，以及 CC 自报 Node v26.3.0 下与之吻合的约 300s 行为；CC 未暴露其 undici 版本，第二点仍是机制归因而非另一个具名 undici default 样本。建议写成“该默认在两个不同 Node runtime 的观测中一致”，不要从两个点概括“持续一段时间稳定”。这不影响当前版本归因。
- **[minor] bare-fetch arm 默认 label 会覆盖 firstfail 路径。** `run-q1-firstfail.sh:18,63-76` 新增了显式 arm，但 `Q1_CLIENT=bare-fetch` 若未同时指定 `Q1_LABEL`，仍写默认 `firstfail.client/observations`，会覆盖另一臂的本地证据。建议按 arm 派生默认 label，或拒绝非 cli arm 使用 `firstfail` 默认名。

## 已确认修好

- FINDINGS、spec Q1、plan README、plan-1 主体已删除无条件 `T+300/~600s` 推论，并正确说明 post-header watchdog 可重置。
- `spec:208` 已正确写成 post-header watchdog 由更早的 `exp/cc-idle-280s/` 实测，不再冒充本轮 Q1 结果；本轮新增主文中未发现第二处同类来源混淆。
- “单个 pre-header attempt 必须在约 300s 前 commit，否则接受该 attempt 被中止”在明确限定“本机 CC 2.1.220/当前 transport default”的上下文中成立，不越界；它是 avoid-abort 条件，不是协议常量或总预算。
- A/B 已收窄到当前版本/运行栈，且不再声称 undici“不属于 CC”。
- 重试周期、backoff、最大次数未知、server/client 时间基均已正确订正。
- shell 对 SDK control 的分层解释已修正。
- `spec:208` 的 post-header watchdog 引用正确指向旧实验。
- `plan-2:264` 与 `deferred-backlog.md:1006` 的“上界未知”确实指 GHC deferred-header 到达时间，不是 Q1 客户端 timeout，保留正确。
- `README.md:7` 的 `≥125s` 位于 2026-07-23 审查历史叙述，且明确描述当时更新，保留正确。
- patch `git diff --check` 通过，修改后的 `q1-bare-fetch-runner.ts` 单文件 TypeScript 检查通过。
