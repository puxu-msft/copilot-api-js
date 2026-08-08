# History Worker Batch 1b 评审转录与处置

> 状态：全部代码、判据与文档复审已达 0 blocker／major；已于 2026-08-08 fast-forward 合入 `master@d3b4ac77`。
> 评审基线：`661e1792`；合并态基线：`51f0e57e`；最终代码复审基线：`df0c7bf4`；最终实现候选：`94205e89`；文档闭合与主线落地：`d3b4ac77`，基于 `master@44457047`。
> 来源：生命周期 reviewer、overlay／判据 reviewer、lossless shutdown 合并态 reviewer 的工具回传；主会话转录并按 C 级代码裁定处置。

## 发现与处置

| ID | 严重度 | 发现 | 处置 |
| --- | --- | --- | --- |
| R1 | major | `createRequestContext()` bind 后，codec parse 中途抛错时 `getContext()`仍为 undefined，reservation 可永久占用。 | **采纳（C）**。四个 codec 在 `manager.create()`成功后立即发布 context给 `getContext()`；真实 malformed CC请求回归等待 admission quiescence后断言 `reserved=0/unacked=0`。 |
| R2 | blocker | pending／ack-recent overlay只覆盖 list／stats，session summaries、session entries与status memory漏掉。 | **采纳（C）**。先新增共享overlay helper，最终因B1收回既有SCC成员`history/queries.ts`；sync list、stats、session两表面、status统一消费；session summary SQL用overlay JSON CTE并按operation ID排除DB重复。新增pending可见与ack-recent＋DB＋pending三源去重回归。 |
| R3 | major | 入口AST guard只数函数体中的同名调用，不能证明wrapper包围真实operation，豁免表面也缺饱和负控。 | **采纳（C）**。饱和controller动态驱动7个HTTP operation route，逐路径要求`waiting=1`；client abort后归零。liveness／History／status／metrics／dry-run在同一饱和状态保持`waiting=0`。Responses WS保留真实饱和＋close abort测试。 |
| M1 | major | lossless shutdown在reservation已grant、async continuation尚未bind时可先读空operation registry；迟到finalizer失败可能越过一次性join而被漏报。 | **采纳（C）**。新增acquire→bind/release handoff barrier；manager先将context放入operation registry再bind；shutdown Step 1 stop后、首次registry snapshot前drain handoff。真实controller＋manager成功双控与迟到finalizer失败双控均已通过。 |
| R3.1 | major | R3整改后的History豁免负控请求不存在的`/api/history`，且`status >= 200`让404通过，不能证明真实History查询绕过admission。 | **采纳（C）**。改为真实`/history/api/entries`，精确要求200、`entries`数组与numeric `total`，并继续断言饱和controller的`waiting=0`；dry-run空payload按自身契约精确要求400，不放宽全部状态。 |
| R2.1 | regression | status改走summary查询后会解析payload；损坏`summary_json`的canonical operation被漏计。 | **采纳（C）**。新增只数`v3_operations`且排除overlay IDs的专用COUNT；status使用去重overlay数量＋canonical DB行数。损坏summary回归与pending／ack-recent／DB三源去重均已通过。 |
| B1 | regression | 新建`history/overlay.ts`被`queries.ts`引用后加入core SCC，违反只减不增ratchet。 | **采纳（C）**。把共享overlay helper收回既有SCC成员`queries.ts`并删除双实现；SCC守卫2 pass／0 fail，未重冻baseline接受新增环。 |
| B2 | regression | 同步`getHistorySummaries({search})`的overlay分支只做结构filter，没有按normalized inbound messages做全文过滤，model／system／error会误匹配。 | **采纳（C）**。in-flight与pending／ack-recent都先保留完整entry，再复用`extractInboundSearchText`过滤；message正样本与model／system／error负样本均通过。 |
| B3 | regression | backend discovery baseline仍列两份已删除shutdown测试，且漏列Batch 1b新增的8个tracked测试。 | **采纳（C）**。按物理unit／it／http人口机械同步8增2删，保持runner blob与当时的executed floor不变；schema守卫5 pass／0 fail。 |
| B4 | false-red gate | lossless shutdown合法收敛测试人口后，两次完整backend均为7255 executed，而冻结floor 7258让正确状态无法通过后继evidence producer。 | **采纳（C），复审通过**。两组16份JUnit均为7285 testcase－30 skipped＝7255 executed；同一集合对7256返回非零、对7255返回零；`94205e89`只校准floor，不改文件人口、skip身份或runner blob。原reviewer判可合、0 blocker／major。 |
| D1 | major | DESIGN同一架构行前段正确写在线overlay，末段却称生产History list只显示终态，与代码和D-2权威backlog冲突。 | **采纳（C）**。按`docs/todo/deferred-backlog.md`正文的权威口径改为：在线REST／WebSocket可见in-flight，真实缺口是进程崩溃或SIGKILL时在途operation不落盘、不可恢复发现；同轮全仓审计并同步修正`DESIGN.md`另一处复述、`history.md`两处活口径及backlog的陈旧标题，历史计划／归档保留当时结论。 |
| D2 | major | 进度文档的接力历史仍以当前时态写“尚待复验”，与下文已闭合证据和只剩master集成的清单冲突。 | **采纳（C）**。改为“接力当时尚待复验”，明确旧证据未直接继承，并指向下文当前worktree的复验与最终闭合记录。 |

## 整改验证

- `bun run typecheck`：通过。
- 首轮四项整改联合目标集：91 pass／0 fail，14 files，289 assertions。
- Overlay性能／行为：`summary-query-performance`保持summary-only读取，128 MiB manifest下large read约22 ms，legacy scan约186 ms；相关两文件全绿。
- Handoff：成功路径与迟到finalizer失败路径均进入真实controller／manager；失败路径使shutdown返回`Shutdown persistence failed`并释放reservation。
- `cca342ff`定向入口／status／overlay集合：24 pass／0 fail；原overlay／判据reviewer复审判0 blocker／major。
- `df0c7bf4`搜索／overlay／SCC／discovery联合集合：57 pass／0 fail；最终代码重写复审判0 blocker／major。
- `94205e89`精确Batch 1b计划门：44 pass／0 fail；完整backend：16 shards、7255 executed、30 skipped、0 fail、52.45s；build成功。

## 复审结论

1. 生命周期 reviewer：R1及四codec相邻成功／失败路径可合，0 blocker／major。
2. Overlay／判据 reviewer：R2、R3、R3.1、R2.1及`df0c7bf4`重写可合，0 blocker／major。
3. 合并态 reviewer：M1与lossless shutdown handoff可合，0 blocker／major。
4. B4 floor校准：两次正确样本、独立JUnit求和与边界双控均成立；原reviewer复审判可合、0 blocker／major。
5. D1／D2及同形全站点文档同步：原reviewer复审判可合、0 blocker／major；独立复跑DESIGN路径守卫与REST／summary in-flight行为测试共69 pass／0 fail。
