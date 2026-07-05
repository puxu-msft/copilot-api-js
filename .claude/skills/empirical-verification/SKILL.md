---
name: empirical-verification
description: 当需要在 copilot-api-js 实测裁决而非凭推断时使用——4141 history API 探针、ss 看内核 keepalive timer、metronome 测事件循环阻塞、SQLite 膨胀查 freelist/dbstat、流完整性看协议终止符、prompt-cache 命中率诊断、记录消失取证、探针 harness 须复制生产接线；以及 subagent「PASS 但有 WARN」当黄灯顺因果链、声音权威（subagent/reviewer）复核实证案例（0消费者实3、jsonrepair 真实字节复跑推翻 CRITICAL、连跑 25 次）。可信度：亲手实测 > 文档 > 单方声称。
---

# 实证诊断手法

裁判前先实测：dispatch 被调/请求 200/wall 变快/测试绿/grep 空 **都不自证**（pass-null 盲点）。探针 harness 必须复制生产全部接线（中间件/序列化前缀）否则结论反向。判断「该不该信某条声音权威主张、用哪种独立裁决」的通用决策法见 user-level skill `verifying-authoritative-claims`——本 skill 是其在本项目的探针落地（4141/ss/metronome…）。

## 4141 探针（上游/协议主张）

`curl :4141/health` 确认在跑（别自启/kill）→ `GET /history/api/entries?limit=N` 列表 → `:id` 全量（inboundRequest/sseEvents/outbound*，含真实 thinking signature）。jq `--slurpfile` 拼最小请求、`max_tokens` 小 → POST `/v1/messages`。**无损取字节**勿 `tr -d '\n'`。验新代码用 exp 脚本喂真实 entry（live=旧码 + 自洽测试两盲点）。

## keepalive 落内核

唯一证据 `ss -tno | grep <port>` 见 `timer:(keepalive,Nsec)`——dispatch 调/200 不算。慢/保活端点在途时抓、多抓排假阴；用生产函数发；区分 L7 池复用 vs L4 SO_KEEPALIVE；delay 15s 应见 ~14s 倒数非 7200s。

## 事件循环阻塞

`setInterval(记 nanoseconds gap,1)` metronome：max-gap≈wall=冻结。静态直觉必被反转——代理真热点是请求末同步持久化（zstd~6MB+索引 ~164ms），非逐帧（~6ms）。CPU 重活：库调用(zstd/zlib)走 libuv 异步、纯 JS 循环 `await sleep(0)` 让出；bun:sqlite tx 回调必须同步。探针须含 stringify 同步前缀，别预喂 Buffer。

## SQLite 膨胀

先 freelist 不先疑压缩：`PRAGMA page_count;freelist_count;auto_vacuum`，`freelist×page/page_count` 占比；VACUUM 救（auto_vacuum=INCREMENTAL 须早于 WAL）。第二轴：freelist 小文件大→dbstat 查逐表字节找孤儿表（VACUUM 救不了，须 DROP/迁移）。

## 流完整性 / 缓存 / 记录消失

- 流完整性看**协议终止符**非传输 EOF（message_stop/finishReason/status===""/Gemini flush 前判）；平行 handler 全枚举。
- prompt-cache：同 session 多 turn 看 cache_read 是否冻结；inbound vs wire 断点数差定位；热切 cacheControlMode 对照（3%→99.7%）。
- 记录消失先证伪 durability/重启/reaper/clear-delete 再归因；live-churn 库直读 torn，走运行进程 API；破坏性 bulk 须高声 WARN。
- 失败查不到→查 finalize 的 catch→warn + 无条件 cleanup（吞错+有损 fallback=蒸发），靠日志 swallow 证据非 DB 快照裁决。

## 客户端 SDK oracle（协议/累积/客户端解析主张）

wire/协议正确性别用自洽（自己 encode↔decode，两端共享同一错误假设→假绿），也别只用服务端 4141 探针——用**真实客户端库**（`@anthropic-ai/sdk` = Claude Code 同款累积逻辑）消费受控 mock 流,直接验证「客户端如何解析/累积」。`client.messages.stream(...).finalMessage()` 取累积结果断言(baseURL 指 mock,`defaultHeaders:{"x-mock-mode"}` 切场景)。活案例 exp/tool-keepalive-safety(空 keepalive delta 拼进真实 tool_use 流 → SDK 累积的 input/thinking/signature 全对,证明「空 partial_json 拼接无害」是**实测非推理**);exp/q2-oracle(真实 `claude` CLI 作更高层 oracle,`--settings` 盖 baseURL)。比服务端探针更聚焦客户端侧解析,比 spec 推断更权威。

## 活路径证明 + 分层验证（改代码后必做）

改代码后先证明「这条路径**真被执行**」(不是 dead code/被绕过/只活在测试):静态追踪 route→handler→sink→driver(确认调 `runResponseSink` 非 dry-run `runResponse`)+ 端到端正样本(改后的帧真出现在响应)。是 pass-null 的正向版——「改的代码触达目标了吗」,非只「逻辑正确」。**分层意识**:应用层对 ≠ 到达消费者;验证到真正起作用的那层(keepalive 要验到 TCP flush/客户端真感知,不止 `sink.write` 被调;curl -N 看实时字节、ss 看内核 timer)。**mid-stream 时序技法**(测流式 heartbeat 等异步注入):http 测试用 `FakeClock`(拦 setTimeout)+ **test 持有 `ReadableStream` controller** 精确控帧——`ctrl.enqueue(block_start)` → `await Promise.resolve()×N` drain microtask 让 pump 消费到(openBlock 设)→ `clock.advance` 触发 heartbeat → 断言注入帧。**坑**:首跑若 keepalive 落在 block_start **之前**=drain 不够(pump 还没 write)、非 bug;drain 步进后即对(生产中静默发生在 block 已 write 之后)。活案例 tests/anthropic/keepalive-e2e.http。

## 「PASS with WARN」当黄灯,顺因果链

subagent 审计常以「PASS 但有 1 个 WARN」或「WARN 低优先级」收尾。默认诱惑是直接交付——**别这么做**。把 WARN 再往深挖一层,它往往是 subagent 只抓到一半的真实回归的可见冰山一角。subagent 擅长表层检查(grep/type/lint/基础 test),在多步因果链上弱:它标记的某个「死导出」之所以死,可能因为你破坏了调用契约——而调用契约被破坏就是一个回归,只是 subagent 没回溯到。

**因果链范例(可观测性重写 commit 4,一步步深挖):**
- subagent:「PASS——可交付。WARN:`notifyShutdownPhaseChangedAndFlush` 是死导出(无调用者),建议删。」
- 深挖①:该函数死掉因为 `shutdown.ts:setPhase` 现在调 `bus.publishAndFlush`。没问题。
- 深挖②:`bus.ts` 里 `bus.publishAndFlush` 返回硬编码占位 `pendingWsBuffer: 0`。WsSink 对 `system.shutdown_phase_changed` 的 handler 是同步的——bus 不 await 它的工作。
- **真实回归**:shutdown 的 phase frame 已发送,但 WS TCP drain 没被 await。socket 可能在 phase frame 离开本机前就关闭。旧的 `notifyShutdownPhaseChangedAndFlush` 有这个 drain 语义,迁移悄悄丢了它。
- 修复:WsSink handler 改 `void | Promise<void>`,`needsFlush` 时返回 `broadcastAndFlush()` 的 promise;`bus.publishAndFlush` await 异步 handler,链路端到端重新接上。

**怎么用:** subagent 以「PASS 但有个小 WARN」结尾时,当 YELLOW 不当 GREEN。提交前花 5-15 分钟顺 WARN 因果链走一遍。具体问:「这个被标记死/孤儿的代码在保护遗留代码做的什么事?我的迁移保留了吗?」重新 grep 该保护机制的**目的**而非只是它的存在(`broadcastAndFlush` 听着不危险;「强制关闭前的 WS TCP drain」听着就危险)。发现真实回归就提交前修掉,别甩后续补丁。

## 声音权威复核:主动时机 + 项目实证案例

主动时机(不等催):executor → reviewer 验收 → 主线再 sanity check;**任何重大产出(计划/设计/命名)在 ExitPlanMode/交付/报告前主动跑一轮 subagent audit**,把发现回填再请批准。门槛不设下限——连翻译/改记忆这种琐碎也不跳(简单改动的回归正因没人审才漏)。subagent 报告本身也是声音权威,**行动前读它引用的每个 file:line**,绝不整份照搬。通用裁决手法见 user-level skill `verifying-authoritative-claims`;always-on 原则见 CLAUDE.md `subagent-explicit-rubric`+`empirical-verification`。

**项目实证(反复踩的坑,知道往哪查):**
- Executor 误判:「0 个消费者」实有 3 个;bugfix subagent 跑 3 次声称修好 flaky,独立连跑 12 次抓出 3 次失败。
- Reviewer 误判:基于不全 grep / 设计意图偏差;或基于**过时文档**——曾提 CRITICAL「Bun 不支持 fake timers」,最小探针验证 bun 1.3.8 实际支持,推翻该 CRITICAL。
- **Reviewer「我亲测了」但喂合成样本**:审 spec 时 reviewer 跑 `jsonrepair` 得 CRITICAL「修成合法但语义改坏」,但它测的是**自己捏造的** `{"q":"\\u67b6"}`;主线用**真实 history 字节**(entry `req_1782740067043_965`)复跑证明 jsonrepair 正确补 `]}`、中文语义保真 → 推翻该 CRITICAL(同会话另 3 个 CRITICAL 复跑全确认)。教训:声音权威的「empirical demo」也是声音权威,**先查它测的是真实工件还是合成代理**——empirical≠可信若输入失真;用真实样本(history sqlite 原始字节)复跑才裁决。
- 逐条核 subagent 抓真 bug:commit 审计标「main.ts 与 ConsoleSink double consola hijack」,`grep -n setReporters` 确认 `initConsolaReporter()`+新加 `attachConsoleSink` 都调 setReporters → 真问题,`hijackConsola:false` 修;没查验就会当「过度警惕」跳过。
- 第一个 review agent 把 rate_limiter 单位换算判「识别了但低估」,第二个 agent 才挖出 `recoveryTimeoutMinutes`+`DEFAULT_CONFIG` 双默认值全链路——**必要时发起任意多次新 subagent 交叉核实,次数不设上限**。
- 连 subagent「跑了 20 次全过」也自复跑 25 次才采信。

**价值观冲突:** reviewer 默认持 ROI/YAGNI,与本项目「长远正确+完整」冲突,其「可安全删除/无影响/无消费者」结论尤其要对照本项目裁判轴复核(「无消费者」常是没接线非真无源,该建而非删)。报告标注每条是「经我复核 confirmed」还是「仅 reviewer 声称」。依赖随机+真实时序的测试,fake timers+mock 随机源是正确根因修复不是症状掩盖。

## 声称「完备/没问题」前主动过多维度自审

功能正确只是完备性的**一个**维度。keepalive 任务功能实现得对，却经历 ~5 轮反复：功能正确 → tool 场景安全 → 活路径（改的代码真被执行?）→ 传输层（keepalive 真发出到 TCP?）→ 可观测性（合成心跳污染 history?）。**几乎每层都是被用户推着才去验证**，我每层都先声称"完备"，用户指出下一个没覆盖的维度。用户最后点破："其实你的实现是完备的，我批评你其实是逼你验证。"反复的根源是**过早声称"完备"、缺乏主动的多维度自审**；防御性反应（"我有 SDK oracle / 实测证明我对"）那些证据本身对，但**用户指的从来不是我已覆盖的、而是我没覆盖的新维度**。

**交付非平凡实现前主动过一遍完备性维度清单**，别等用户逐维度推：
- ① **活路径**——改的代码真被执行吗（非 dead code/被绕过/只在测试里）?用端到端或正样本证明触达目标，不只"逻辑正确"（呼应本 skill「活路径证明」+ pass-null 通过不自证）。
- ② **传输/分层**——应用层对 ≠ 到达消费者;验证到真正起作用的那层（keepalive 要验到 TCP flush/客户端真感知，不止 `sink.write` 被调）。
- ③ **可观测性**——合成 vs 真实可区分吗?运维/history/log 能看出真相吗（richest-data-flow）?**最易漏的设计盲区**（只想功能对、没想合成数据污染 history）。
- ④ **副作用**——这个改动污染/影响了哪些下游（history/log/UI/diff/其他消费者）?

**被质疑时**：别防御性重申已有证据——先假设"用户看到了我没看到的维度"，去找它、亲手实测它。用已覆盖的证据回击一个指向盲区的质疑，只会拖长反复。这条与本 skill 其余角度的差异 = **主动多维度、别被推着一层层验证**。
