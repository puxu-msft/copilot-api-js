# ADR: per-model idle timeout 是 app-guard-only —— 无需 transport backstop 耦合

- **状态**：Accepted（架构边界继续有效；2026-08-08 起 bundled 正超时默认已被 later decision `never-false-kill-legit-thinking` 取代，见下）
- **日期**：2026-07-12
- **相关**：[spec/2026-07-12-per-model-idle-timeout.md](../spec/2026-07-12-per-model-idle-timeout.md) §7、[plan/2026-07-12-per-model-idle-timeout.md](../plan/2026-07-12-per-model-idle-timeout.md) Phase 4b、DESIGN.md「活的架构现状」`streamIdleTimeout`/`streamIdleTimeoutOverrides` 行、`src/lib/models/timeout-resolver.ts`、实测 `exp/ws-upstream-keepalive/REPORT.md`（2026-07-12 归因更正节）

## 背景

per-model idle timeout 特性（`timeouts.stream_idle_overrides` / `response_header_overrides`）为 gpt-5.5 类模型放大帧-idle guard（实测 gpt-5.5 effort=high 是单个 266–462s 零帧静默 → 末尾 burst，300s 标量 guard 会误掐合法长响应）。

设计初稿（spec v1 §7）提出一个 undici↔per-model 联动的 ADR：因为全局 undici Agent 的 `bodyTimeout = scaleTimeout(state.streamIdleTimeout)`（×1.5），若某模型 override 到 600s，全局 undici 450s backstop 会**抢先掐死**该模型的合法静默；故需让全局 backstop 取 `max(标量, 所有 override) × 1.5` 联动。

这个前提**被源码推翻**（对抗评审 BLOCKER，coordinator 亲手核验）。

## 定夺

**per-model idle timeout 是纯 app-guard 特性，不与 undici / transport dispatcher 耦合。全局 undici `bodyTimeout`/`headersTimeout` 保持 `scaleTimeout(scalar)` 不动。**

### 2026-08-08 后续裁决对默认值的覆盖

本 ADR 决定的是“若启用 per-model timeout，它属于哪一层”，不授予任何正 wall-clock 值安全终止合法思考的判别力。后续 upstream-silence 计划的用户冻结不变量 `never-false-kill-legit-thinking` 明确：合法思考无可证明的 wall-clock 上界，任何仍活连接上的 timeout 都可能误杀。因此 bundled `response_header`、`stream_idle`、`stale_request_max_age`、`request_deadline` 及内置 per-model override 均改为 `0`；运维仍可显式配置正值，resolver、hot reload 与本 ADR 的 app-guard-only 边界继续保留。旧 spec 中“gpt-5.5 内置 600s”与“其余模型正标量”只作为历史决策记录，不再描述当前默认值。

### 三条传输路由事实（核验依据）

1. **GHC(https) 不经 undici**：`src/lib/transport/upstream-fetch.ts` 的 `productionUpstreamFetch` —— `u.protocol === "https:" ? http2Fetch : undiciUpstreamFetch`。所有真实上游（GHC `api.*.githubcopilot.com`、`api.github.com`、`api.anthropic.com`）是 https，走 **node:http2**。undici **只服务唯一的明文 http 上游：本地 SearXNG**。
2. **h2 传输层无 body-idle timeout**：`src/lib/transport/http2-client.ts` 握手后 `sock.setTimeout(0)`（"an established h2 conn may idle legitimately"）。h2 路径的帧静默完全靠 app-guard（`guardSseIterable` / `raceIteratorNext` = `resolveStreamIdleTimeoutMs`）兜底，传输层不会抢先掐。
3. **首字节（response_header）同理**：GHC 首字节由 app 侧 `createResponseHeaderTimeoutSignal`（`AbortSignal.timeout`）治，非 undici `headersTimeout`。

故「undici bodyTimeout 450s 抢先掐死 600s 模型」对 GHC 流量**为假**——gpt-5.5 根本不经 undici。undici 的 `bodyTimeout` 只对 SearXNG 搜索 JSON（非流式、无 600s 帧-idle 诉求）生效，标量足够。

盲区根因：初稿只读了 `proxy.ts`（配置 undici 的地方）的注释，把「transport timeout 不能先于 app-guard」错误泛化到 GHC 路径,没回 `upstream-fetch.ts` 核实真实路由。

## 反证守卫（防复发）

per-model override 侧字段（`streamIdleTimeoutOverrides` / `responseHeaderTimeoutOverrides`）**绝不出现在 transport 层**（`src/lib/proxy.ts` / `src/lib/transport/http2-client.ts`）。测试 `tests/architecture/per-model-idle-transport-boundary.test.ts` 断言这两文件不引用 override 字段名（用文件读取 + 正则，非全局 grep 标量——`proxy.ts:105` 合法读 `state.streamIdleTimeout` 标量服务 SearXNG，spec §7.3 明确保留）。任何未来「在 transport 层读 per-model override」的提议会被此守卫逐字挡下。

## 备选方案（未采纳）

- **方案 A（undici backstop 取 max(标量,所有 override)×1.5 联动）**：spec v1 推荐。因 undici 不在 GHC 路径而**不必要**——实现它会用 INV-3/INV-4 测试锁定一条守护「gpt-5.5 根本不经过的路径」的耦合，落一份契约为假的 ADR。撤销。
- **方案 B（固定 ceiling）**：魔数 + 仍可能 pre-empt。撤销。
- **方案 C（per-model undici dispatcher 池）**：承重耦合、不可行。撤销。
