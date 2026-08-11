# KICKOFF — A4-2：把 H2 stream 终止观测接到显式 dispatch 并落进 History

> 本文是**派发件**，不是计划。范围与验收的最终权威是 [`docs/plan/2026-08-06-history-read-path-and-h2-diagnostics.md`](../2026-08-06-history-read-path-and-h2-diagnostics.md) 的 A4 节；进度与批次状态的权威是 [`HANDOVER.md`](HANDOVER.md) §B.5.2。**本文与它们冲突时以它们为准**，但下面「已完成的对账」一节记录的是**它们写作之后才查清的代码现状**，那部分以本文为准（并请顺手回填计划）。

## 0. 一句话任务

生产路径上，H2 流的终止观测（`TransportTerminationSnapshot`）**已经被算出来、然后被丢掉**。本批次把它接到 A4-1 建好的显式 `DispatchHandle` 上，落进最终持久 History record，并用确定性 h2c 双控证明它能区分 **peer RST_STREAM(CANCEL)** 与 **local abort**。

## 1. 环境与硬门

- 仓库：`/home/xp/src/copilot-api-js`。**base commit：`11558f812a31e61669c6c5495ee13b80d64dfec5`**（`master` 当时的值；开工时用 `git log --oneline 11558f81..master` 看已前进多少，别假设没变）。
- **代码改动走隔离 worktree**，放 `.claude/worktrees/<name>` 或 `.worktree/<name>`；交接件与 `docs/` 入口改在主树。新建 worktree 默认从 `origin/master` 分叉（**落后本地 master 数百提交**），建完立刻 `git merge --ff-only master` 拉齐。
- 🚫 **绝不 kill／停止／重启 4141 端口的用户主服务器**，不用 `kill`/`pkill`/`killall`。测试服务器只用非 4141 端口，按 PID 精确清理自己起的那个。
- 🚫 **不推送**。提交留本地，发布是用户的事。
- 提交用显式 pathspec，conventional commits，不加模型署名。
- 进度文件（多语义提交／需试错时必须先建）：`docs/tmp/2026-08-09-a4-2-progress-<slug>.md`。

## 2. 已完成的对账（**不要重查**，直接用）

这一节是 2026-08-09 实测的代码现状。计划写于 2026-08-06，此后 `http2-client.ts` 已被多次改动（重取：`git log --oneline --since=2026-08-06 -- src/lib/transport/http2-client.ts`），**计划对本批次的描述已部分过时**。

### 2.1 最重要的一条：观测层已经存在，缺的只是接线

`src/lib/transport/http2-observation-types.ts` 已定义 **`TransportTerminationSnapshot`**，字段包含：

- `firstObservedSignal`: `"end" | "error" | "close-before-end" | "local-cancel"` ← **这就是 A4 要的「区分发起方」**
- `rstCode: number | null`、`streamId: number | null`、`headersReceived: boolean`
- `localCancel: { source: "body-cancel" | "post-response-signal-abort" | "other-local" | null; reason }`
- `error: { code, message }`（都是有界文本 `BoundedObservationText`）
- `trailers` / `physicalClose`: `ObservationAtSnapshot`
- `goaway: GoawaySnapshot`（含 `errorCode`、`lastStreamID`、`lastStreamIdOrder`、`opaqueDataLength`、`evidence`，以及 `GoawayProtocolViolation`）

配套已存在：`http2-goaway-ledger.ts`、`http2-termination.ts`、测试 `tests/transport/http2-termination.unit.test.ts` 与 `tests/transport/http2-client.it.test.ts`（后者已有真实 h2 server 与 `/termination`、`/termination-trailers` 路由）。

**这套东西的可观测性设计比计划里 `H2StreamDiagnostic` 的字段清单更完备**（它带 availability 语义：`observed` / `not-observed-before-snapshot` / `unavailable-at-source`，能区分「没发生」与「发生了但取不到」）。

### 2.2 生产接线的确切缺口

`onTermination` 这条回调在传输层**端到端存在**，但**生产代码从不提供它**：

| 位置 | 角色 |
|---|---|
| `src/lib/transport/upstream-fetch.ts:65` | `UpstreamFetchInit.onTermination?: (snapshot) => void` 声明 |
| `src/lib/transport/http2-termination.ts:99` | recorder options 上的同名声明 |
| `src/lib/transport/http2-termination.ts:212` | **唯一的调用点**：`options.onTermination?.(committedSnapshot)` |
| `src/lib/transport/http2-client.ts:1152` | **唯一的转发点**：`onTermination: init.onTermination` |

`rg -n 'onTermination:' src/ --glob '*.ts'` 只有 `http2-client.ts:1152` 一条 —— 即**没有任何生产调用方设置它**，只有测试设置。所以生产上快照算完即丢。

⚠️ **复核这条时别用 `rg -r`**：`-r` 是 replace 不是 recursive，`rg -rn 'onTermination' src/` 会把命中替换成 `n` 输出，看起来像字段叫 `n`。本会话在这里踩过。

### 2.3 handle 到哪一层为止（A4-1 的边界）

A4-1 让 `TransportDispatchOptions.dispatch` 必填并送到了**传输适配器**，但**没有再往下**。实测 `http2-client.ts` 里 `dispatch` 只出现在注释中，`DispatchHandle` 零命中。

现有调用链：

```
http-transport 的 send(wire, env, options{dispatch})      src/lib/transport/http-transport.ts:55
  → sendUpstreamHttp(params)                          src/lib/transport/send.ts:242
    → upstreamFetch(url, init)                        src/lib/transport/send.ts:253
      → runHttp2Fetch(u, init)                        src/lib/transport/http2-client.ts:1101
        → http2-termination 构造并 commit 快照        src/lib/transport/http2-termination.ts:212
```

> 上面这些 `file:line` 核验于 base commit `11558f81`；**行号会随任何一次编辑整体漂移**，接手时按符号名重新定位（`rg -n 'async function runHttp2Fetch'` 之类），别直接跳行号。

**所以本批次的接线工作是：把「拿到快照后要做什么」从 `http-transport` 一路带到 `upstreamFetch` 的 init。** 注意这条缝是 **fetch 形状**的（`UpstreamFetchInit` 是类 RequestInit 的普通对象），计划里那句「stream 事件经 `onTransportDiagnostic` callback 到显式 dispatch」**没有说它怎么跨过这条缝**——那是你要设计的部分，别当成已经定好的。

### 2.4 A4-1 已经给你的东西

- `ctx.recordGenerationDispatchDiagnostic(dispatch, { kind, severity, data?, message? })` —— 按**显式 handle** 记录，**不动 ambient 当前 attempt**；未知 handle 在 record 未封口时抛错，封口后静默丢弃。定义见 `src/lib/context/types.ts`，实现见 `src/lib/context/request.ts`。
- 诊断最终落在 record 的 `dispatch.diagnostics[]`（`AttemptDiagnostic`），随 manifest/timeline 持久化。
- 测试里如果需要一个不带归属的 handle：`tests/helpers/dispatch-options.ts` 的 `compatDispatchOptionsForTests()`（**故意不注册**，用它记录会抛错——别拿它做归属断言）。

## 3. 开工第一件事：一个需要裁决的设计分叉

**不要自己拍板，先给出方案与推荐、拿到裁决再写代码。**

计划 §Transport event schema 要求新增 `H2StreamDiagnostic`。但 §2.1 显示 `TransportTerminationSnapshot` 已经覆盖了它列出的绝大部分字段，而且多带 availability 语义。于是有三条路：

- **A｜直接承载**：诊断的 `data` 就放 `TransportTerminationSnapshot`（或其投影），不新建并行类型。省一份实现，天然不会漂移；代价是 History 的诊断 schema 被传输层的类型形状绑住。
- **B｜新建 `H2StreamDiagnostic`，从快照投影**：History 侧有自己的稳定契约，传输层可独立演化；代价是**两份 schema 要手工保持同步**——本仓已有「同一件事写两遍、其中一遍弱一档」的账（见 backlog 里 overlay/Tantivy 双实现那条）。
- **C｜折中**：诊断顶层放少量稳定标量（`firstObservedSignal`、`rstCode`、`streamId`、`headersReceived`），完整快照原样放在 `data` 里。

**我的推荐是 C**：稳定的判据字段独立于传输层类型（查询与断言用它们），完整快照按 `richest-data-flow` 原样留存不裁剪。但**这是推荐不是结论**，请按 CLAUDE.md 的 `necessity-claim-must-be-falsifiable` 把三条都摆给裁决方。

⚠️ 无论选哪条，**别把 H2 连接身份塞进 `sessionId`**：那是客户端 conversation 维度（`EntrySummary.sessionId` 在 `src/lib/history/core-types.ts`、`HistoryEntry.sessionId` 在 `src/lib/history/types.ts`），与 H2 session 是两个身份域。

## 4. 本批次范围

**做：**

1. 把「记录终止快照」的能力从 `http-transport` 接到 `upstreamFetch` 的 `onTermination`，归属到 A4-1 的显式 `dispatch`。
2. 按第 3 节裁决结果确定诊断形状，写进最终持久 record。
3. h2c 确定性双控（第 5 节）。
4. 同步 `HANDOVER.md` §B.5.2 批次表与 `docs/API.md`（若诊断字段对外可见）。

**不做（属别的批次，别顺手扩）：**

- session ring / 真实 PING ACK/RTT → **A4-3**。（`http2-client.ts:264` 现在是 `session.ping(NOOP_PING_ACK)`，本批次**不要动它**。）
- teardown barrier、`open → forcing → sealed` sink 状态机、exactly-once `releaseStreamSlot()` → **A4-4**。（现状：`releaseReservation()` 在 `http2-client.ts:482`，但 `activeStreamCount -= 1` 在 `1170` 还有一处散落——计划对这点的描述**属实**，留给 A4-4。）
- `EntrySummary.transportFailure` → **A4-5**。
- 不改 transport 行为。**诊断只观测，不得改变重试、取消、池化或 cadence**。

## 5. 验收与双控（**每条都要两个方向**）

判据必须从**最终持久 record** 读，不能只断言内存回调被调用过。

| 场景 | 期望 |
|---|---|
| 正常 end | 记录 `firstObservedSignal: "end"`，无 RST |
| peer `RST_STREAM(CANCEL)` | 对端 `stream.close(NGHTTP2_CANCEL)`；记录 peer 侧 rstCode，**不得**被标成 local |
| local abort | 本地 `req.close(NGHTTP2_CANCEL)` 或 body cancel；记录 `firstObservedSignal: "local-cancel"` + `localCancel.source`，**不得**被标成 peer |
| GOAWAY | 记录 errorCode / lastStreamID；**不得**误归给无关 sibling stream |
| 无诊断消费者时 | 行为与接线前逐字节一致（诊断不改行为） |

⚠️ **`stream.destroy(error)` 不预设 code 时属于 INTERNAL_ERROR／destruction 分支，不能用来制造 peer CANCEL**（计划已写明，这里重述是因为最容易搞错）。

⚠️ **上表故意没有写死 peer-RST 场景下 `firstObservedSignal` 应该等于什么。** 本会话只读了 `TransportTerminationSnapshot` 的类型定义，**没有实跑**确认各场景下它取哪个值——按「别跨一条你没读过的缝规定行为」，写一个我没验证过的期望值比留白更坏。**先用 `tests/transport/http2-client.it.test.ts` 已有的 h2 server 跑一遍、把四个场景的实际取值记下来，再据此写断言**；若发现实际语义与「区分发起方」的需要对不上（例如 peer RST 与某类 local 落到同一个值），那本身就是一条要上报的发现，不要靠加字段绕过去。

**变异对照（必做，且要核对红的原因）：**

- 删掉／错绑 `dispatch` → 目标 History 断言必须红。
- 把 local-cancel 与 peer-RST 的分类**对调** → 对应两条断言必须**各自**红。这条是本批次的核心判别力：只验「有记录」没有判别力（A4-1 已经踩过一次——归属断言在变异下仍绿）。
- 变异后**确认失败来自目标机制**，不是旁路断言。
- 恢复变异用**重新编辑**，不要 `git checkout` 整文件；恢复后 `git status` + `git diff` 复核为空。

**测试落点**：`tests/transport/http2-client.it.test.ts` 已有真实 h2 server 与 `/termination` 路由，优先复用，别另起炉灶。History 侧断言归 `.it.test.ts`。

## 6. 交付前

- `bun run typecheck`、`bunx eslint --no-cache .`（`bun run lint` 带 `--cache`，可能假绿）、`bun run test:backend`（**只有 0 fail 可引用，总数不稳定别追**）。
- 派**独立 reviewer**（跨模型，`gpt-souls:reviewer` 或 `reviewer`）审代码；派活时**显式写裁判轴：长远正确 + 完整，不许以 ROI/YAGNI 建议砍范围**，并列出可核验断言清单让它逐条给证据。
- 按 HANDOVER §B.5.2 的验收边界，**独立 verifier 与 merged-state review 在 A4 最终 commit 上闭合**，不是每批一次——本批不做不算漏门，但要在交接件里如实写明。
- 更新 `HANDOVER.md` §B.5.2 批次表（**带完整 SHA 锚点**，并保留「空 grep 不单独证明未开始」那条告诫）。

## 7. 容易踩的坑（本仓实测）

- **`rg -r` 是 replace**，会静默改写输出（§2.2）。
- **新建 worktree 从 `origin/master` 分叉**，落后数百提交；且它向上解析主树 `node_modules`，缺 gitignored 构建产物会造成稳定假红。
- **`bun test` 默认单测超时 5000ms**，h2c 集成用例请显式给预算（`}, 120_000)`）。
- **`docs/tmp/` 下 reviewer 写的报告可能是未追踪文件**，合并主线时会挡住 fast-forward；先 `cmp` 证明逐字相同再移开。
- 判成败的退出码要来自被测命令本身，别让 `| rg` / `tail` 把退出码换成过滤器的。
