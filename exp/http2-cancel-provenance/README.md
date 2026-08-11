# HTTP/2 CANCEL 来源归因：探针、事故分析与阶段 1 门禁变异

本目录保存 2026-08-06～08 期间为 [spec/2026-08-06-http2-cancel-provenance-and-header-deadline.md](../../docs/spec/2026-08-06-http2-cancel-provenance-and-header-deadline.md) 做的实验产物。**归档理由**：spec §6「测试夹具与实证纪律」把这些探针的实测结论写成了冻结约束（哪种服务端 API 忠实、哪种不忠实），阶段 2 要照着搭 peer RST 夹具；结论留在文档里而产生它的探针留在临时目录，下一个人无法复核也无法复跑。

## wire-oracle/ —— 回答「怎样在测试里造出忠实的 peer RST」

**问题**：Node/Bun 的 `node:http2` 服务端有多种「砍断流」的写法，哪一种在客户端侧产生的 wire 事件与真实 GHC 的 `RST_STREAM(CANCEL)` 一致？

**结论（已写入 spec §6.1／§6.3，此处只记来源）**：
- `stream.destroy(error)` **忠实**——客户端观测到非零 `rstCode`（INTERNAL_ERROR=2），可被 production `http2Fetch` 正常观测，故 spec 选它作 peer wire oracle。
- 公共 `stream.close(code)` 在**已发 respond 之后**的形态下**不忠实**（客户端侧不呈现预期的非零 RST 观测），故不能用它伪造 post-header 的 peer CANCEL。`probe-public-peer-cancel.mjs` 的四个 variant（before-respond / after-respond-no-data / after-respond-flush-headers / after-data）就是为定位这个位置依赖性而写。
- 私有 `kHandle.rstStream()` 能更直接地发 RST，但依赖 Node 内部 ABI，**spec 明确禁止把它作为必过门**（`probe-peer-cancel-oracle.mjs` 的第三个 variant 会打印 `serverSymbols`，用来确认该符号是否存在——它的存在性本身就是易碎信号）。
- `probe-client-abort-race.ts` 走 **production** 接线（`http2Fetch` + `guardSseIterable` + `createDispatchLifecycle` + `ownedResponseEvents`），用于区分「客户端取消」与「上游 RST」在同一错误表面上的表现。

**它没有证明什么**（必读，别把窄探针当全覆盖）：
- **没有重放过真实 GHC 的 CANCEL=8 wire。** 这些探针用的是本地 h2c server，产生的是 INTERNAL_ERROR=2。spec §6.2 因此把「peer CANCEL=8」拆成两条独立判据：公开 wire oracle 只证明「非零 peer RST 能沿 production 接线形成 peer evidence」，`code=8` 的字段保真由离线 collector 单测证明。**两条合起来也不等于重放了真实 GHC 流量**——真实 incident 只作外部观测证据。
- **没有覆盖 Bun 与 Node 的全部差异。** 结论主要在 Bun（本项目运行时）上取得；Node 腿只作跨 runtime 校准，且 spec 要求它按 `Bun.which("node")` capability-gated skip，不得成为 Bun-only 环境的必过门。
- **没有证明 `stream.close()` 在任何位置都不忠实**——只测了上述四个位置；`before-respond` 与 post-header 形态表现不同，这正是它位置依赖的证据。
- **没有测代理/TLS/真实网络路径**，全部是 loopback 明文 h2c。

**复跑**：`node exp/http2-cancel-provenance/wire-oracle/probe-peer-cancel-oracle.mjs`（同理 `probe-public-peer-cancel.mjs`）。每个 variant 打印一行 JSON，含事件序列与各事件时点的 `rstCode`。`probe-client-abort-race.ts` 用 `bun` 跑，且它 import 的是**绝对路径**的仓库源码——换机器或换 worktree 需改路径。

## incident-analysis/ —— 回答「这批 CANCEL 事故长什么样」

**问题**：生产 History 里以 `NGHTTP2_CANCEL` 失败的 generation，其路由、耗时、帧数与静默期分布如何？这是 spec §1 问题陈述的数据来源。

**结论**：事故集中在 `/v1/messages` + `claude-opus-5 → gpt-5.6-sol` 路由；失败样本在**收到响应头之后**、流中途被砍断。详细分型见 spec §1。

**它没有证明什么**：
- **没有证明发起方是 peer。** 这正是整个 spec 的出发点——F4：Bun 对本地 `req.close(CANCEL)` 与 peer RST 产生同一文本，因此**这批 History 数据无法区分二者**，只能等阶段 2 的结构化 evidence 落地后回头重新归因。
- 统计口径依赖当时的归档库 `history-v3-260807.db`，**不是全时段**；脚本里硬编码了该路径。

**复跑**：脚本 import 仓库源码的**绝对路径**并直接读归档 DB（只读打开）。换机器需同时改 DB 路径与 import 路径。原始 dump（数百 MB 级）**故意不入库**——可由脚本对同一 DB 重新生成。

## stage1-gate-mutations/ —— 回答「阶段 1 的门禁真咬得住吗」

七份 exact patch，是阶段 1 双控（正样本绿 + 注入目标缺陷变红）实际使用的冻结变异。每份只描述一处目标变异，用法是 `git apply` 注入 → 跑对应测试确认变红 → `git apply --reverse --check` 后反向恢复。

| patch | 目标缺陷 |
|---|---|
| `mutate-remove-header-deadline-signal.patch` | 删掉 deadline signal 接线 |
| `mutate-leak-header-deadline.patch` | 删掉 resolve/reject 时的解除，让 header 时钟泄漏到 body 阶段 |
| `mutate-deadline-only-signal.patch` | 只保留 deadline signal、丢掉 lifecycle signal |
| `mutate-deadline-no-clear.patch` | 解除时不清 timer |
| `mutate-deadline-no-idempotence.patch` | 去掉幂等门 |
| `mutate-http2-detach-cleanup.patch` | 删掉 HTTP/2 natural-end / close 的 detach |
| `mutate-shared-send-drop-header-duration.patch` | 删掉 shared-send 传入的真实 duration property |

**它没有证明什么**：**变异会红 ≠ 判据覆盖完整**。这七份只证明「**已写的**那些判据在这七种错误实现下会红」，不证明判据覆盖了该覆盖的输入形态。阶段 2/3 新增判据时要重新构造相邻状态，不能引用本目录当覆盖率证据。

**复跑**：patch 的 `diff --git` 路径相对仓库根。阶段 1 代码终点是 `bea1dfa3`；在更晚的树上应用可能因上下文漂移失败，此时应重新构造而不是强推。

## 附带发现（与本 spec 无关，但会咬人）

`git merge --ff-only` 在目标文件为 dirty 时被拒——**即使工作区内容已逐字节等于 FF 目标**。一次性仓库实测：必须让**工作区与 index 同时**等于目标（`git add` 之后）才会放行；只改工作区仍报 `Your local changes to the following files would be overwritten by merge`。本轮没有走这条路（改用了正常的三方合并），记在这里是为了让下一个想「先把碰撞文件补成目标再 FF」的人知道该方案的真实前提。
