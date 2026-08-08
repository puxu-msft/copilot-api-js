# 上游传输 Provider 化 + Rust/napi-rs 实现 交接

> **状态**：**草稿·评审中（已收到 2 BLOCKER + 7 MAJOR，正在处置）** —— 因「上下文将满」走 skill `session-closeout` §6 的紧急路径落盘。**过完评审闭环后必须改成正式状态**（见 T1）。
> **核验基线**：`0a2e3bdf`（2026-08-03）——晚于此且触及相关路径／契约／测试基础设施、造成异常 merge／integration，或改变环境／版本／运行实例前提的 peer 提交可能影响下面的结论；无关 HEAD 前进本身不使证据失效。⚠️ **`0a2e3bdf` 是 peer 会话的提交**（inter-block anchor allocator 线），本轮最后一个自有提交是 `36dafc48`。
> **工作区**：分支 `master`（**共享 worktree，有并发 peer 会话**）/ 无独立 worktree；**未提交改动与未追踪文件全部属于 peer**（`src/lib/*/tool-name-sanitize.ts`、`tests/*tool-name-sanitize*`、`docs/memory/*`、`docs/tmp/2026-08-03-*` 等）——**本轮零改动留在工作区，全部已提交**。
> **已跑门禁**：`exp/napi-http-spike/run-all.sh` → exit 0（2026-08-03）；主会话独立复跑 h2 PING 探针 → `rustPings:5 / controlPings:1`（2026-08-03）。`bun run test:backend` / `typecheck` / `lint` **未跑**——本轮**零生产代码改动**，只有 `docs/` 与 `exp/`。

## 0. 入口指引

1. **先读** [docs/spec/2026-08-01-upstream-transport-provider.md](../../spec/2026-08-01-upstream-transport-provider.md)（v3）——**唯一权威**。§0 是最新裁决，与下文冲突时以 §0 为准。
2. **要动手实现前再读** §4（三层契约）、§7（冻结的实现契约）、§10（约束→测试追踪表）。
3. **只在需要复核选型时读** `exp/napi-http-spike/FINDINGS.md`（选型实证）与 `exp/upstream-client-survey/`（七候选穷举）。
4. **只在有人质疑「为什么不用 curl」时读** `exp/curl-transport-{exe,libcurl,rst-arbitration}/`（已否决路径的取证）。
5. **不必读** 本轮的评审往返细节——结论已折进 spec §12 / §12.1 处置表。

## 1. 本轮做了什么

| sha | 内容 |
|---|---|
| `5f5923fb` | 三份 PoC：curl exe / 进程内 libcurl / 截断裁决 |
| `cc12bc64` | spec v1（当时选型为 curl） |
| `7d0776b1` | **勘误 RFC** `upstream-http2-transport.md` 里被夹具伪造的半条 CRITICAL 断言 |
| `89d2d22c` | 补回忠实 RST oracle（评审指出只留了结论没留脚本） |
| `b72c5c28` `0083baaa` `5d1b1ebe` `7ef99722` `29a7f870` | v2 系列：冻结六项契约 + 两轮评审 21/22 采纳 |
| `02d2af36` `a16bcc68` `549b1457` `dd6476ed` | 选型改 Rust、去掉文件名里的 curl、分发改可选包、默认改 auto 探测 |
| `db284175` | **napi-rs spike**：四门槛实测 + mutation 正控 |
| `36dafc48` | **spec v3**：§3.2/§5/§6/§7 从 curl 重写为 Rust provider |

## 2. 已确证的硬事实（**别再重新推导**）

| # | 事实 | 证据等级 | 证据 | 适用问题 / 边界 |
|---|---|---|---|---|
| 1 | reqwest 能对**活跃但静默**的 h2 流周期发 PING | **实测**（主会话独立复跑） | `bun exp/napi-http-spike/run-h2-probe.cjs` → `{"totalPings":6,"controlPings":1,"rustPings":5}`；双层正控（Node client ping 证 oracle 可见；interval 设 `None` 则 rust 计数归零） | **只覆盖本地直连 TLS h2**。未证明经代理隧道时 PING 仍到达真上游 |
| 2 | curl（exe 与进程内 libcurl 两形态）**都发不出**周期 h2 PING | **实测** | `exp/curl-transport-exe/FINDINGS.md` §6（五条独立证据 + 正样本对照）、`exp/curl-transport-libcurl/FINDINGS.md`（66 次 upkeep / 0 帧） | 回答的是「**当前受支持的 curl CLI 公共接口 + 本机 libcurl API 表面**能否配置周期 PING」。**排除**：未来版本、私有 patch、直调 nghttp2、改 curl 源码 |
| 3 | Bun 1.3.14 支持 napi-rs 的 TSFN 跨线程回调 | **实测** | `exp/napi-http-spike/`，Node 与 Bun 各 5 次按序回调；正控=预期改 4 次即变红 | **主会话只独立复核了 Node-host 腿**；Bun-host 腿沿用 spike 报告 |
| 4 | 「Bun 的 node:http2 对 clean server RST 交付合成 clean end」**不成立** | **实测** | `exp/curl-transport-rst-arbitration/FINDINGS.md`：`stream.close(code)` 不放 RST 帧；改 `stream.destroy(err)` 后**四客户端全部**检测到 `rst=2` | 只废 **RST 那半**。**「整连接 drop」那半仍成立**（原探针用 `session.destroy()`，忠实） |
| 5 | 注释里的「唯一明文 `http://` 上游（本地 SearXNG）」**不存在** | **源码读证** | `src/`+`packages/` 的 `rg -i searxng` 命中全是注释（`state.ts:751,1500`、`schema.ts:1099`、`proxy.ts:7,12`、`upstream-fetch.ts:62,83`、`timeout-resolver.ts:13`）；**无上游请求实现**。⚠️ **「全仓全部是注释」是错的**（评审证伪）：`tests/config/config-compat.unit.test.ts:242` 有 `backend:"searxng"`，即**配置兼容层仍有残留表面** | 回答「是否存在**发往 SearXNG 的上游请求实现**」。**集合边界**：`src/`+`packages/`（**不含** `tests/`——那里有 config-compat 残留）。**排除**：① 配置兼容层的 legacy `web_search.backend` 键；② 用户自行把 `ghc_api_base_url` 配成 `http://`（仍可能产生明文上游，且它是**启动期字段**） |
| 6 | `TransportErrorReason` **没有** unknown 成员，且 `classify.ts:151` 会把未识别 Error 判为可重试 | **源码读证** | `packages/foundation/src/error/transport-reason.ts:38` 只有四值；`classify.ts:151` 宽泛 `isNetworkError` → `network_error` → `network-retry.ts:27-41` 重试 | 决定 spec §7.5 的 `unknown-transport` **必须是结构化成员**，否则该条契约不可执行 |
| 7 | 本机 Rust 在**非默认位置** | **实测** | `RUSTUP_HOME=/home/xp/.local/rustup` → `stable-x86_64-unknown-linux-gnu`，rustc/cargo 1.97.1；已装 target **仅** `x86_64-unknown-linux-gnu` | ⚠️ **不继承交互 shell 的进程会看到 `no installed toolchains`**，本会话踩过一次假阴性 |
| 8 | `bun x` 会解析并安装平台专属 `optionalDependencies` | **实测** | `bun x esbuild --version` → `0.28.1`（esbuild 的 bin 是 JS shim，无原生二进制打不出版本） | 回答「`bun x` 是否支持 per-platform 可选包模型」。未测**缺失**该平台包时 `bun x` 的行为 |

## 2.5 与冻结上游文档的对账

- **候选上游文档逐份 disposition**：
  - `docs/spec/upstream-http2-transport.md`（RFC）—— **有冲突，已处理**：其 CRITICAL 断言的 RST 半被证伪，已就地划线 + 勘误注解（`7d0776b1`），**未删除**（记得旧结论的人需要知道它被撤回）。
  - `docs/decisions/2026-07-14-transport-config-three-axis-organization.md`（ADR）—— **无冲突**：本 spec 在 `upstream_transport.*` 下新增 `provider` / `curl`→`rust` 子节，属该 ADR 三轴组织的**延伸**而非推翻。
  - `docs/todo/deferred-backlog.md` —— **需新增条目**（见 T5）：进程内 libcurl 属**暂缓非否决**，未来若出现 Bun/Node 双可用绑定或 libcurl 侧 PING 成立应重评。
  - `CLAUDE.md`「文档路由」—— 无冲突，spec 落点正确。
- **检索词与范围**：`upstream_transport` / `http2.favor` / `h2 ping` / `keepalive` / `searxng` / `pool-closed` / `TransportErrorReason`，范围 `docs/` + `src/` + `packages/` + `ui-v4/`。

## 3. 待办

### T1 过评审闭环，把状态从「草稿·未评审」改掉　【已裁决 —— skill `session-closeout` §6 强制】

- **要做什么**：按 skill §1 派**两个正交视角**评审本 HANDOVER + KICKOFF + `docs/` 入口（判据证伪 / 接手方第一人称走查），派活时给 `REPORT_FILE` 绝对路径并要求**每条 finding 闭合即追加落盘**；整改后 `SendMessage` 恢复原 reviewer 复审。
- **验收判据**：两视角均无 BLOCKER/MAJOR；HANDOVER 头部状态行改为「进行中」；评审报告与入口一次精确 pathspec 提交。
- **鉴别力正控**：**在副本上做，绝不改权威文档**——`cp HANDOVER.md /tmp/ho-mutant.md` 后在副本里植入一处已知错误的 `file:line`，派一个一次性 agent 只审该副本，确认「走查」视角能抓出；**跑完删副本**。⚠️ v1 曾写成「在 HANDOVER 里植入」——那会污染权威文档且无清除闭环，已撤回。
- **证伪方式**：reviewer 只给措辞建议、未逐条实地核对 `file:line` ⇒ 该轮不算完成（skill §1 的退化判据）。
- **已知约束**：本轮 reviewer 连续四次被后端 API 错误掐断，**必须**要求逐条落盘 + 只回摘要。恢复一律 `SendMessage`，**绝不重派**。

### T2 建 `docs/` 权威入口　【已裁决 —— skill §6 强制】

- **要做什么**：在 [docs/DESIGN.md](../../DESIGN.md)「活的架构现状」表建立 provider 化的权威写入点，状态标 `[wip]`，指向本交接与 spec。其它相关文档可按各自读者语境完整复述并引用该权威行；复制 `[wip]`、owner、下一步、数字等易变状态时必须沿用同一核验基线并纳入同步检查，只有无法可靠同步的 high-churn 部分才缩成精确指针。
- **验收判据**：**不是**「grep 到字符串」（那只证明字符存在）。判据是：① DESIGN.md「活的架构现状」表存在该权威行且状态为 `[wip]`；② 该行的相对链接 `docs/DESIGN.md` → spec、→ HANDOVER **实际可解析**（用 markdown link checker 或逐个 `test -f`）；③ 「上游 fetch / keepalive」等相关复述明确引用该权威行、语义一致，复制的易变状态携带同一基线；不能以“内容完整”为失败，也不能让它们成为独立状态写入点。
- **鉴别力正控**：**待执行期正控**。
- **证伪方式**：按 `docs/` 常规路径读进来的人读到的仍是旧方案（h2-only）⇒ 入口没建对。
- **已知约束**：**不存在的条目不新造占位**。

### T3 §11 七条待证伪断言的取证轮　【已裁决 —— spec 状态行明写未达「可进入计划阶段」】

- **要做什么**：跑 spec §11 的七条（其中三条已随 v3 改写，需先按 v3 重列）。
- **验收判据**：每条给 成立/不成立/部分成立/未能取证 + `file:line` 或命令输出。
- **鉴别力正控**：**待执行期正控** —— 用一条已知不成立的断言做正样本，确认取证流程会判它红。
- **证伪方式**：出现「未能取证」但没写清试过什么 ⇒ 该条不算完成。
- **已知约束**：§11/§12 目前仍是 **v2 视角**，未按 v3 更新（见 T4）。

### T4 §11/§12 按 v3 更新　【我的建议】

- **要做什么**：§11 的七条断言里，与 curl 相关的（如「curl 无 h2 PING 是否穷尽」）已随选型作废，需替换为 Rust 路径的待证伪项（reqwest 默认注入哪些 header、trailers 时机与 API、错误分类映射、代理隧道内 PING 是否保留）；§12 补 v3 处置行。
- **验收判据**：`rg -n "curl" docs/spec/2026-08-01-upstream-transport-provider.md` 的**每一条命中**都能归入以下两类之一：§3.2/§6 的**否决记录**、§12 的**历史处置表**。出现在 §4/§7/§8/§9/§10/§11 的即为残留。（v3 首轮正是漏了 §8/§9/§10/§11，被评审判 BLOCKER。）
- **鉴别力正控**：**待执行期正控**。
- **证伪方式**：更新后仍能在 §11 找到 curl 专属断言。

### T5 backlog 记录「进程内 libcurl 暂缓非否决」　【我的建议】

- **要做什么**：`docs/todo/deferred-backlog.md` 加条目（根因/当前行为/理想架构/为何暂缓/若做需改什么）。
- **验收判据**：条目含五要素（根因 / 当前行为 / 理想架构 / 为何暂缓 / 若做需改什么）**且**写明**可观测的重评触发条件**（如「出现 Bun+Node 双可用绑定」或「libcurl 侧 upkeep 能触达在途 transfer」），而非「以后再看」。
- **证伪方式**：条目只写「暂缓」而无触发条件 ⇒ 等于永久搁置，不算完成。

### T6 实现期必须闭合的实测项（**spike 明列未覆盖**）　【已裁决 —— spec §3.3】

- **要做什么**：跨请求连接复用、真实 GHC 上游、**代理隧道内的 h2 PING**、reqwest 默认注入的 header 逐项、trailers 时机与 API、错误分类映射、并发与池容量、shutdown barrier、addon unload 与 TSFN closing 竞态。
- **验收判据**：spec §10 的「约束→测试」追踪表逐行有对应测试且绿。⚠️ **该表须先随 T4 改写为 Rust 路径**——v3 首轮它仍绑 curl 专属约束（`-D` fd、argv、exit code），照它实现会做错东西。
- **鉴别力正控**：每条 `unsupported`/`supported` 的能力声明**都要正反双向 oracle**（spec §10 已写死；`true` 一样会假绿）。
- **证伪方式**：任一条只有「推理安全」而无实测 ⇒ 不算闭合。
- **已知约束**：⚠️ **本条曾写错并已撤回**——`exp/http2-refused-retry/` 早已存在且实测闭合（Node 服务端 pre-response `stream.close(REFUSED)` 发真帧，Bun 客户端 `rstCode=7`、message 与生产日志逐字一致）。**真正未闭合的是 reqwest/hyper 侧如何 surface REFUSED**，别去重建已有探针。两条沿用约束：`err.code` 区分不了 REFUSED 与 INTERNAL_ERROR（须按 message 子串）；服务端夹具必须是真 Node h2 server，跑在 `bun test` 进程内的 Bun server 会退回「不发真帧」陷阱。

## 4. 我犯过的错与成因

| 我当时的结论 | 错在哪 | 根因 | 正确说法 | 复发点 |
|---|---|---|---|---|
| 「curl 与 node:http2 都测不出 h2 RST」 | 服务端 `stream.close(code)` 根本没在 wire 上放 RST 帧 | **夹具不忠实而未验夹具**——两个 PoC 加我自己三方同错 | 造 h2 RST **必须** `stream.destroy(err)` | **T6** 写任何 h2 故障测试时 |
| 「settle 后写 trailers 会撞 `assertWritable` 并崩进程」 | 该 setter 是裸赋值，无 guard；`assertWritable` 在另一个 recorder | **把两个不同写入路径当成同一条** | 后果是 trailers 静默不进已封存快照，**不是崩溃** | **T6** 接线 trailers 时 |
| 「h2 耦合点只有四个」 | 漏了 UI 逐字段消费、`pool-closed` 已进 foundation、HTTP 测试断言等五类；且把模块**自订阅**的 `reconcile*` 误列为对外耦合 | **否定性/完备性结论把搜索范围当全集** | 见 spec §1.1 九类 | **T3/T4** 下任何「全部/只剩/无」结论时 |
| 「这台机器上没有任何 Rust 工具链」 | 只搜了 `~/.rustup`、`~/.cache/rustup`、`/usr/bin`，**没搜 `~/.local`**，且工具 shell 不继承 `RUSTUP_HOME` | **同上——搜索范围当全集**，两小时内第二次 | 正确说法是「在我的 shell 环境和我搜过的路径里找不到」 | **T6** 任何构建/CI 脚本 |
| spec v1 把六项契约写成「实现期再决定」 | 终止时序、配置优先级、错误分类、wire parity、关机时序、status 形状**都该在 spec 冻结** | **把「我还没想清楚」包装成「留给实现期」** | 见 spec §7 | **T4** 补写 §11 时别再留活口 |

## 5. 产物清单

| 产物 | 路径 | 已提交? | 它**没有**证明什么 |
|---|---|---|---|
| spec v3 | `docs/spec/2026-08-01-upstream-transport-provider.md` | ✅ `36dafc48` | §11 取证轮未跑、v3 未复评 |
| napi-rs spike | `exp/napi-http-spike/` | ✅ `db284175` | 见其 FINDINGS「没有证明什么」（连接复用、代理内 PING、trailers、并发、非 linux-x64 产物…） |
| 七候选穷举 | `exp/upstream-client-survey/` | ✅ `396e9b1f` | **无 FINDINGS.md**（agent 只把结论回在正文，主会话已折进 spec §0.1/§6）。含一个我未点名的 .NET sidecar 候选，其结论未被独立复核 |
| curl 两 PoC + 截断裁决 | `exp/curl-transport-{exe,libcurl,rst-arbitration}/` | ✅ `5f5923fb` `89d2d22c` | 各自 FINDINGS 有「没有证明什么」节 |
| RFC 勘误 | `docs/spec/upstream-http2-transport.md` | ✅ `7d0776b1` | 未重测「整连接 drop」半（沿用原探针差分对照） |

## 6. 环境与禁区

- **`RUSTUP_HOME=/home/xp/.local/rustup`** 必须显式设，否则假阴性（核验于 2026-08-03 / `0a2e3bdf`）。
- **共享 worktree**：工作区里所有未提交改动与未追踪文件**都是 peer 的**（tool-name-sanitize 那条线等）。**一律显式 pathspec 提交，绝不 `git add -A`**。
- **绝不 kill 4141 端口的服务器**（用户主实例）。
- 本轮**零生产代码改动**，`test:backend` / `typecheck` / `lint` 未跑（核验于 2026-08-03）。**接手第一件事是复验而非采信**。
