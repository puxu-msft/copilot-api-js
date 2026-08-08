# HTTP/2 CANCEL spec/plan 评审处置

- 评审范围：`995c1047..399bb802`
- 首轮 reviewer：异模型对抗审
- 状态：前九轮累计 39/39 个独立 findings 已采纳；第十轮局部复评待完成（重复上报已合并进原 ID）
- peer wire oracle：公开 `stream.destroy(error)` 实测产生 `rstCode=2`，用于真实 wire→Bun production 接线；collector 单测独立验证 `code=8` 字段保真。已撤销私有 `kHandle` 必过门。
- 评审运行备注：第二轮计划执行 reviewer 连续两次因 `Server error mid-response` 中断，未形成 finding/verdict；当前稿已再次重写，旧轮不再适用。

| ID | 级别 | 发现 | 处置 | 证据与理由 |
|---|---|---|---|---|
| R1 | C | first-writer local intent 不能证明 wire 上真实发起方 | 采纳 | peer RST 可已到 socket但 JS listener 尚未运行；随后 local cleanup 先写 local。单一来源会过度声称。改为 additive evidence；local+peer/session 并存派生 `ambiguous`。 |
| R2 | C | stream unknown 首写会吞后到 session evidence | 采纳 | `http2-client` 的 stream/session event 次序没有提供全序保证。`unknown` 改为 quiescence 后无结构证据的派生 attribution，不作为 evidence；session evidence可追加。 |
| R3 | C | Node JSON→纯 classifier 没覆盖 production wiring | 采纳；初版修法后被R15替代 | 当前 Bun 测试已明确 RST可能塌缩为clean end。首版改Node server+Bun client；R15进一步删除私有ABI/Node硬依赖，终态为Bun内本地h2c公开rst2 wire→production接线。 |
| R4 | C | 只改 disposeDispatch 漏 scheduler.settle | 采纳 | `src/lib/pipeline/generation/dispatch-scheduler.ts:324-331` 的正常 settle 直接 `recordSettlement`。两条路径统一用 `settlementWithTermination()`，都在 `quiesced` 后取 accessor。 |
| R5 | C | 一等 canonical 字段的必要性 claim 过强 | 采纳 | typed diagnostic/settlement extension也可闭合但类型约束弱。保留一等字段作为长期类型安全最优方案，改为择优论证并记录未采纳替代方案。 |
| R6 | C | `Bun.spawn([process.execPath,...])` 实际仍启动 Bun | 采纳；后被R15简化 | 实测Bun `process.execPath`是`bun.exe`。首版改显式Node；终态主oracle改为Bun内本地h2c公开rst2，Node仅capability-gated可选校准。 |
| R7 | C | `stream.destroy(error)` 只能产生 INTERNAL_ERROR=2，不能作为peer CANCEL=8正控 | 采纳（blocker）；私有injector后被R15撤销 | 探针实测close(CANCEL)假绿rst0、destroy为rst2。中间版用私有rst8，R15指出ABI false-red；终态将真实nonzero peer wire接线与code8字段保真拆成两条独立判据。 |
| R8 | C | session与bare close混写且缺事件反序矩阵 | 采纳 | 拆为bare close→unknown、session-first、stream-first/session-later、local+session→ambiguous、GOAWAY+clean end五格；unknown改为派生值而非首写evidence。 |
| R9 | C | dispatch lifecycle缺external reason与explicit cancel双向测试 | 采纳 | 指定现有`tests/transport/dispatch-lifecycle.unit.test.ts`，覆盖external identity、显式cancel/dispose=dispatch-cancel及先后顺序。 |
| R10 | C | header/deadline同tick与timer/listener单次释放未覆盖 | 采纳 | Task1加入FakeClock两种注册顺序、external-abort、settlement计数、liveTimerCount、listener add/remove和H2 onStreamClosed/reservation门。 |
| R11 | C | Node JSON回灌纯classifier不覆盖Bun production wiring | 采纳；终态由R15进一步简化 | 删除JSON→classifier。最终主oracle在Bun内以本地h2c公开rst2驱动production http2Fetch/evidence callback，Node仅可选交叉腿。 |
| R12 | C | 最终logical terminal可绕过scheduler settlement | 采纳 | 除dispose/normal scheduler两路统一enrichment外，RequestContext在dispatch begin保存runtime provider；`recordGenerationLogicalTerminal`不再当场settle，改到`whenOperationQuiesced()`之后的`commitGenerationObservabilityTerminal()`冻结provider/error最终observation。 |
| R13 | C | peer+session共现单值归session仍伪造因果 | 采纳 | 三类机制local/peer/session恰一类时单值归因；任意两类以上共现统一ambiguous，全部evidence保留，retry不接受ambiguous。 |
| R14 | C | 单次setImmediate不是session因果边界 | 采纳 | 删除延迟窗口和事后session.closed推断。session只通知当时active observer；stream close同步解绑，后到session event不归当前stream。 |
| R15 | C | 私有kHandle oracle造成Node ABI false-red | 采纳 | 删除私有ABI依赖。主oracle在Bun测试进程内用本地h2c `stream.destroy(error)`产生真实rst2并由production `http2Fetch`消费；collector独立单测code8保真。可选Node交叉腿capability-gated skip，不阻断Bun-only环境。 |
| R16 | C | terminal fallback在quiescence前读旧snapshot | 采纳 | logical terminal只seal/存pending；finalizer await operation quiescence后才settle未settled final attempt并读取provider。新增tracked child后到evidence回归与反向mutation。 |
| R17 | C | header-timeout路径不可能有post-response listener，1/1计数会false-red | 采纳 | 分开pre/post-response listener oracle：pre-header timeout的post listener=0/0；natural end和post-header external abort才各1/1。 |
| R18 | C | local CANCEL测试接受local或ambiguous会漏“已有local就跳stream append” | 采纳 | 先探针确认Bun raw echo存在，再强断production保存local+stream两侧并严格归ambiguous；增加条件跳过stream append mutation。 |
| R19 | C | Promise `settlements===1` 看不到内部双finalize | 采纳 | 最终修法：header deadline抽成`{signal,complete():boolean}`幂等primitive；FakeClock断言首个true/后续false、timer归零，mutation删幂等门必红。 |
| R20 | C | helper重命名漏 `tests/infra/fetch-utils.it.test.ts` | 采纳 | Task2补该文件到Files、迁移、命令和精确pathspec，保持WS first-event语义断言。 |
| R21 | C | operation quiescence不保证dispatch lifecycle quiescence | 采纳 | runtime provider扩为`{getObservation,quiesced}`；finalizer先等operation barrier，再等final dispatch barrier，production race test用真实cleanup。 |
| R22 | C | `snapshotForRecorder`丢Symbol termination tag | 采纳 | pending terminal分存runtime raw error与持久化snapshot；finalizer用raw error读tag，commit仍写snapshot。 |
| R23 | C | 阶段2 review越界要求阶段3 settlement | 采纳 | 阶段2只验live accessor在quiescence后稳定；三settlement路径移回阶段3门。 |
| R24 | C | 目录pathspec/漏foundation stream等会漏改或卷并发WIP | 采纳 | 所有git add展开精确文件；Task4补foundation/stream、error/forward、post-commit-error及对应tests。 |
| R25 | C | Tasks4–7/9–11缺首跑red，Task9测试落点不明 | 采纳 | 每Task重排为完整测试→首跑red→实现→绿门→mutation；Task9指定generation-finalization/candidate-runtime；Task10/11新test先red。 |
| R26 | C | code8测试归属/执行遗漏 | 采纳 | code8保真固定归Task4 foundation单测；Task5红/绿命令同时运行该文件，阶段2总门覆盖。 |
| R27 | C | Task3 H2测试修改未提交 | 采纳 | Task3新增独立代码+测试提交，再review与状态文档提交。 |
| R28 | C | buffered recovery在lifecycle quiescence前读peer snapshot | 采纳 | `isBufferedTransportCut`改async并先await `upstream.lifecycle?.quiesced`；新增peer→late local/session→ambiguous不重试回归与mutation。 |
| R29 | C | Task3要求listener移除但未修改/提交http2-client | 采纳 | Task3明确把匿名post-response listener改成具名幂等detach；production+test精确提交改为`fix: clean up HTTP2 header deadline listeners`。 |
| R30 | C | 三settlement测试未覆盖production recording port→RequestContext接缝 | 采纳 | 新建`tests/pipeline/dispatch-termination-recording.it.test.ts`，真实createDriverRecordingPort+scheduler+RequestContext覆盖settle/dispose/terminal fallback；进入red/green命令与pathspec。 |
| R31 | C | Task3 production+test同写后直接PASS，无旧实现红门 | 采纳 | 重排为只写listener测试→旧匿名listener FAIL→实现具名幂等detach→PASS→删detach mutation→精确代码+测试提交。 |
| R32 | C | recovery只等iterator lifecycle，physical stream evidence可后到 | 采纳 | UpstreamStream新增`terminationQuiesced`；recovery、scheduler两路、terminal fallback均依次等iterator+physical双barrier；late evidence变ambiguous不重试测试。 |
| R33 | C | diagnostics声称读live accessor但未贯穿caller | 采纳 | `ResponseOutcome.stream-error`新增冻结`transportTermination`，driver iterator+physical双barrier后附值；共享outcome diagnostics优先读该字段，handlers已传整个outcome，无需另传accessor。 |
| R34 | C | undici/favor:false无onStreamClosed，错误创建physical deferred会永久等待 | 采纳 | `onPhysicalTransport`显式报告实际选路；仅H2携带requestClosed barrier，undici/legacy为undefined；补favor:false/plain-http不挂正控。 |
| R35 | C | Task7修改ResponseOutcome类型却漏pipeline/types pathspec | 采纳 | Task7 Files与精确git add补`src/lib/pipeline/types.ts`。 |
| R36 | C | merge复验错误重跑预期FAIL的Task3红门 | 采纳 | merge后先跑Step4绿门观察实际失败，修冲突后重跑Step4–5；不以Step2红门作为交付复验。 |
| R37 | C | Task6新增physical selector接线漏upstream-fetch/http2-client pathspec | 采纳 | Task6 Files与精确git add补两文件；actual transport由onPhysicalTransport显式报告，undici/favor:false不创建悬空barrier。 |
| R38 | C | frozen ResponseOutcome字段缺production断言 | 采纳 | late peer→ambiguous测试同时断言最终stream-error.transportTermination深冻结且evidence完整；删除附值mutation必须红。 |
| R39 | C | Gemini已有完整outcome却仍只传early raw error给diagnostics | 采纳 | Task10纳入Gemini direct/reverse两处，改传`logUpstreamStreamOutcomeError(outcome,ctx)`；Gemini HTTP测试断late outcome优先且与canonical一致，精确pathspec包含。 |
