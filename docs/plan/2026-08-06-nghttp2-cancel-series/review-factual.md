# 事实证伪评审

- **评审范围：** `/home/xp/src/copilot-api-js/docs/plan/2026-08-06-nghttp2-cancel-series/{HANDOVER.md,KICKOFF.md}` 及指定 Supporting evidence；核验 H1–H8。
- **总体 verdict：** 修复 major 后可进入下一阶段。
- **blocker 数：** 0。
- **基线／漂移：** 首次成功读取主树 ref 为指定 draft base `17a7f612ba2cfda5c4c212555643b8626eb101d0`；评审期间 `refs/heads/master` 前进到 `0840b929b0d0494b64c2a9ec532d0e859b159d14`，该增量仅提交本交接目录 8 个文档文件，未改变 A3／A4 代码事实。隔离护栏拒绝直接执行指定的共享 checkout `git -C` 命令；改从同一 object database 与主树 ref 文件取证，未把 reviewer 隔离 worktree HEAD 冒充主树 HEAD。
- **双视角覆盖证据——机械核对：** 对账四会话 ID／job／承接与中止状态、A0–A3 commit ancestry、`fa2bfd2d..17a7f612` 与后续 master 漂移、A3 六条 finding、transport path commit history、Supporting evidence 路径及数字口径；另查 Node 官方 `node:http2` 契约。
- **双视角覆盖证据——第一人称执行：** 按 KICKOFF 从现场刷新、A3 尾项、A4 h2c 双控到 Phase B 的先后顺序走查；分别尝试正确 peer CANCEL／local abort、正确旧 cursor／错误 index、健康正常流与错误输入是否会被 gate 正确接纳／拒绝。

## 事实性发现

[major] `/home/xp/src/copilot-api-js/docs/plan/2026-08-06-nghttp2-cancel-series/HANDOVER.md:129` — A4 正控指定用 `stream.destroy(err)` 制造“忠实 RST”，并称 `stream.close(code)` 已知会假绿，恰好写反 Node `http2` 的协议语义。
证据／失败场景：Node 官方文档明确 `Http2Stream.close(code)` 会向 peer 发送带指定 code 的 `RST_STREAM`；`destroy(error)` 在未预设 code 时使用 `NGHTTP2_INTERNAL_ERROR`，不能制造 peer `NGHTTP2_CANCEL`。执行者照文档会测到 INTERNAL_ERROR 而非 CANCEL，A4 的 peer/local 分型核心正控不可执行。`mainline-evidence.md:39` 复述同一错误，KICKOFF 又要求遵循 HANDOVER。
修复建议：用对端 `stream.close(NGHTTP2_CANCEL)` 作为 peer CANCEL 注入；另用被测客户端本地 `req.close(NGHTTP2_CANCEL)` 注入 local abort，并以两端 `rstCode`／事件序列校准。保留 `destroy(error)` 只作 INTERNAL_ERROR／session destruction 分支。官方契约：https://nodejs.org/api/http2.html#http2streamclosecode-callback 。

[major] `/home/xp/src/copilot-api-js/docs/plan/2026-08-06-nghttp2-cancel-series/KICKOFF.md:4` — 接手第一入口仍指向 job tmp 中的临时 HANDOVER，而非已提交的同目录 canonical HANDOVER；仓库自包含交接会在 tmp 清理／迁机后直接断。
证据／失败场景：`0840b929` 已把 HANDOVER 与 6 份 Supporting evidence 提交到本目录，但 KICKOFF 要求先读 `/home/xp/.claude/jobs/2684f077/tmp/NGHTTP2-HANDOVER.md`；`HANDOVER.md:25` 又仍称“后续建议归档”，并把 tmp 说成当前来源。路径此刻存在只证明当前机器未清理，不证明未来接手可达；正确的仓库状态反而会被文档误判为“尚未归档”。
修复建议：KICKOFF 第一入口改为本目录 `HANDOVER.md`；HANDOVER 的 Supporting evidence 改列同目录文件为 canonical 路径，tmp 仅保留为历史来源注记，并把“建议归档”更新为“已由 `0840b929` 归档”。

[major] `/home/xp/src/copilot-api-js/docs/plan/2026-08-06-nghttp2-cancel-series/HANDOVER.md:79` — 两条“长尾静默型”样本的 3509／5013 events 与约 107.9／114.2 秒缺少可定位对象，数字无法按 H6 复跑。
证据／失败场景：HANDOVER 只说“另两条旧一代样本”；被引用的 `mainline-evidence.md:26,61` 也只给旧 PID `3509159` 和通用 `GET /history/api/entries/<id>` 模板，没有两条 entry/request ID。PID 下可能有多条记录，执行者无法知道 `<id>` 应替换为什么，也无法独立核对事件数与 tail silence；错误数字会原样通过文档链。
修复建议：为两条样本各补 entry/request ID、observedAt、字段路径与完整可复跑查询；若原 ID 已无法恢复，则将四个数字明确降为不可复验的 E3 历史记录，不作为“两型存在”的独立 E1 证据。

[major] `/home/xp/src/copilot-api-js/docs/plan/2026-08-06-nghttp2-cancel-series/HANDOVER.md:145-151` — Phase B 的因果裁决要求“足够样本／显著差异”，却没有要求实验前冻结统计方法、样本量或停止规则，验收门可在看见结果后自定。
证据／失败场景：HANDOVER 验收只转引计划 B3；计划 `2026-08-06-history-read-path-and-h2-diagnostics.md:205,209-214` 同样只写“足够样本／显著消失／统计显著性”。错误状态可用一次有利波动事后宣布显著，正确但稀有的改善也可能因任意停止被误判无效；“不得一次成功裁决”没有给两方向可执行 oracle。
修复建议：在首次真实 A/B 前预注册 population、主要指标与分型、效应量／置信区间方法、最小样本或序贯停止规则、失败／丢样本处置；正控用可注入的已知 effect 验证 gate 能检出，负控用同配置双臂验证不会制造差异。

## H1–H8 核验结论

- **H1：通过。** 四个 full session ID、标题、承接链和 context overflow／active 状态与 `session-inventory.md` 及当前 job state 对得上；没有重扫全 history。
- **H2：通过。** A0–A3 所列 commits 均可由 draft master 到达；相关三分支相对当前 master 无增量；计划后 transport 路径无提交，支持“没有修 CANCEL”。
- **H3：通过。** `fa2bfd2d..17a7f612` 只改 memory／todo，`17a7f612..0840b929` 只加交接文档；A3 六条 finding 的四个核心实现文件均未变，current master 仍是 0 blocker／6 major。
- **H4：通过。** 既有 TCP keepalive、H2 PING、N=1 与 REFUSED／pre-response retry 的证据有运行态／源码边界；A4 与 Phase B 均诚实标为未开始。
- **H5：通过。** 4141 listener 仍是 PID `3575452`；文档把延迟点探针限定为间歇性 stall／排队现象，没有把时间相关性写成 History、event-loop 或 CANCEL 因果。
- **H6：未通过。** 见旧一代两条样本不可定位的 major；其余关键数字总体携带对象／时间边界／commit 或命令，并正确区分 E1／E2／E3。
- **H7：未通过。** 当前列出的仓库与 tmp 路径均存在，但 canonical 接手入口仍错误依赖 tmp，见 major；HANDOVER／KICKOFF 没有 Markdown 相对链接可供链接扫描。
- **H8：未通过。** A3／A4 大部分验收、证伪和正控写得具体，但 peer CANCEL 注入 oracle 写反，Phase B 统计裁决仍不可执行，见两条 major。

## 主观建议

未提出。

## 结构怪味与方法反思

- `/home/xp/src/copilot-api-js/docs/plan/2026-08-06-nghttp2-cancel-series/KICKOFF.md:4` — **真相源错位／临时路径泄漏**；处置：本轮列 major，改由仓库内 HANDOVER 作为入口。
- `/home/xp/src/copilot-api-js/docs/plan/2026-08-06-nghttp2-cancel-series/HANDOVER.md:129` — **测试 oracle 与依赖契约相反**；处置：本轮列 major，按官方 `node:http2` primitive 校准，不另手写协议注入器。
- **更好的内部替代：** peer RST 与 local abort 分别从连接两端调用同一成熟 `node:http2` primitive，优于用 `destroy(error)` 猜 reset code。
- **判据判别力：** A3 六条 finding 的双控较完整；Phase B 统计门与旧样本复跑门不足，已列 major。
- **成熟第三方方案：** 使用 Node 原生 `http2` 契约与 nghttp2 code，不需要引入新的第三方库或自制 HTTP/2 帧实现。
