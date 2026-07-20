# ADR：driver 编排的多挂载点上游 hook（非 transport decorator）+ data-URL 热重载（非 `?v=` query）

日期：2026-07-12
状态：Accepted（用户 2026-07-12 brainstorming 确认，见 [spec/2026-07-12-upstream-hook-middleware.md](../spec/2026-07-12-upstream-hook-middleware.md) §2 决策表）
关联：[spec/2026-07-12-upstream-hook-middleware.md](../spec/2026-07-12-upstream-hook-middleware.md)（本 ADR 的两条决策即该 spec §2/§3.1 与 §6.3 的权威理由记录）、[DESIGN.md](../DESIGN.md)「活的架构现状」上游 hook 中间件行、[docs/todo/deferred-backlog.md](../todo/deferred-backlog.md)「`hook-rewrite` forwarded 标记覆盖缺口」（本决策的已知覆盖缺口）。

## 背景

2026-07-12 cache_control 子字段剥离特性实测中，发现"验证代理行为不得不真发 GHC"——消耗 Copilot 额度、依赖网络、且无法构造特定上游响应（如 400、畸形 decode 腔）来测反应式学习腿。用户提出需要一个 hook 机制：既跑本 proxy 的完整处理管线，又能给出 mock 的上游交互（四个确认用途：mock 上游响应 / 拦截改写 / 录制回放 / 注入故障延迟）。

落地这个机制涉及两个独立但都承重的架构决策：**hook 挂在哪个抽象层**，以及**热重载怎么绕过 Bun 的 ESM 模块缓存**。

## 决策 1：driver 编排的多挂载点，而非 transport decorator

**把 hook 收口进 `createPipelineDriver` 内部，在 driver 已编排的三个 phase 边界（`onRequest`/`onExchange`/`rewriteUpstreamFrame`）分别回调，而非把整个 `Transport.send` 包一层 decorator。**

### 备选：单一 `HookedTransport` decorator

最初设想的抽象是 `HookedTransport`（decorator 包裹 `Transport.send`，签名 `(wire, env, next) => UpstreamStream`），在 6 处 handler 构造 transport 的地方套一层。这是常见的「装饰器包裹依赖」模式，改动面看似最小（只碰 transport 构造点）。

### 为何选 driver 编排（用户 2026-07-12 brainstorming 明确要求）

- **driver 是 transport 的唯一消费者、也是 stage 编排者**：所有上游交互已经过唯一窄接口 `Transport.send(wire, env): Promise<UpstreamStream>`（[types.ts:108](../../src/lib/pipeline/types.ts#L108)），driver 在 retry 循环里每 attempt 调一次（[driver.ts:310](../../src/lib/pipeline/driver.ts#L310)）。把 hook 收口在 driver 内部，6 处 handler 构造点（messages/chat-completions/gemini 用 `createUpstreamHttpTransport`，responses/ws 用 `createUpstreamResponsesTransport`）**一行不改**——decorator 方案则需要在每个构造点插入包裹逻辑，或引入一个新的工厂参数，改动面反而更分散。
- **单一 decorator 覆盖不了三个不同 phase 的语义**：用户明确要「分阶段多挂载点、同一 hook 模块按参数自辨 model/endpoint/format、无声明式匹配」。`onRequest` 是**一次性**请求改写，必须落在 retry 循环**之外**（循环内重放会清掉 reactive 策略如 beta-strip/tool-field-strip 的 env 修正——这与本特性的核心动机直接冲突：mock 出的 400 需要真被 reactive 策略学到，而非被 hook 每轮重放抹掉）；`rewriteUpstreamFrame` 是逐帧改写，必须落在 driver 的上游-original 采样**之后**、rewrite 链**之前**，才能保证上游轨永远记 pre-hook 真实帧（承重不变量，[spec/2026-07-12-upstream-hook-middleware.md](../spec/2026-07-12-upstream-hook-middleware.md) §3.4）。一个包裹 `Transport.send` 的单一 decorator 只能覆盖 `onExchange` 这一个 phase——`onRequest`（S3 之后）与 `rewriteUpstreamFrame`（S5 逐帧）都在 transport 边界**之外**，decorator 天然够不着，若要覆盖三个挂载点，decorator 方案最终也得在 driver 内部插桩，不是真的"只碰 transport 构造点"。
- **多挂载点比单一 decorator 更细粒度、贴合四用途**：`onExchange` 覆盖 mock/拦截改写/录制回放/注入故障四用途的核心（不调 `next` 即 mock；调 `next` 前后即拦截改写），`onRequest`/`rewriteUpstreamFrame` 是它的两个互补边界（请求侧一次性改写、响应侧逐帧改写）——三者合起来才是「在处理管线的上游边界引入一组可选挂载点」的完整设计意图，而非「用一个新对象替换 transport」。

### 后果

- **正向**：改动收口在 driver 内部（`createPipelineDriver` 读 module-global `getUpstreamHook()`），handler 构造点零改动；三个挂载点各自贴合其 phase 语义（一次性 vs per-attempt vs 逐帧），不需要为了塞进单一 decorator 签名而扭曲任何一个的天然位置。
- **成本**：driver 内部多了三处 `getUpstreamHook()` 读取 + 条件调用，即使未配置 hook 也会触发这几行判断（`hook?.onRequest ? ... : ...` 等）——这是新增的、比"早返回"更细的热路径扰动，spec §9 用 golden fixture 预捕获证明字节等价而非假设。
- **`onExchange` 的调用多重性**（评审 M1，spec §3.2 已记）：实际触发次数 = L1 attempts × L2 buffered-retry re-exchanges（`runExchange` 有两个调用点：`runRequest` + buffered-retry sink），是多挂载点方案带来的额外复杂度，需在 helper 文档里显式提醒 hook 作者。

## 决策 2：热重载用 Bun data-URL 机制，而非 `?v=` cache-busting query

> **SUPERSEDED（实施期实测修正，2026-07-14）**：本决策「拒绝 `?v=`」的核心结论**仍成立**，但落地机制已从 data-URL 改为**转译后写 `.hooks-cache/` 唯一编译文件再 import**。原因：**data-URL 模块不解析 `~/` 别名**（下方「仍解析 `~/` 别名」一句被后续实测证伪），带 toolkit import 的 hook 静默失败；唯一项目文件既绕 Bun path-keyed ESM 缓存（同 data-URL）、又经 tsconfig `paths` 解析别名。权威见 spec §5 头部修正注 + 记忆 `reference-bun-esm-cache-busting-query-fails-data-url-works`。下方原文保留作决策历史。

**`POST /api/hooks/reload` 的重载机制：读磁盘源 → `new Bun.Transpiler({ loader: "ts" }).transformSync(src)` → `import("data:text/javascript," + encodeURIComponent(js))`。每次 data-URL specifier 唯一，绕过 Bun 按路径缓存的 ESM 模块缓存。**

### 备选：`?v=` cache-busting query（初稿假设，实测证伪）

初稿假设 `import(url + "?v=" + Date.now())` 是 Bun/Node 通用的 ESM cache-busting 手法（Node 生态常见模式）。

### 为何改用 data-URL（**实测依据，非推断**）

亲手在 Bun 1.3.14 探针复现：**`?v=` query 对 Bun 无效**——Bun 按解析后的**文件路径**缓存模块，忽略 query string，`.ts`/`.mjs` 均静默返回旧模块（不报错、不警告，只是悄悄拿到 stale 代码，最危险的一类失效）。`?v=` 是 **Node 专有**手法，Bun 的模块解析器不认这个 cache key 维度。

data-URL 方案实测重载成功（改文件→重载→拿到新版本），且**仍解析 `~/` 别名 import**——这一点同样是实测确认，不是理论假设：data-URL 模块内的 `import { mockUpstreamError } from "~/lib/pipeline/hooks"` 与 exp/ 内真实文件的别名解析均通过验证，保住了 §4.2 helper 工具箱契约（若 data-URL 模块无法解析别名，hook 作者就只能用相对路径或裸对象，helper 的人体工学收益作废）。

### 后果

- **正向**：热重载真实可用（这是本特性"仅经管理 API 重载"设计意图的前提——若重载机制本身失效，用户改完 hook 文件后不管等多久都拿不到新版本，且**不会报错**，是最隐蔽的一类失败）。
- **成本**：每次 data-URL specifier 唯一意味着旧模块实例不会被 GC 复用——对于一个"仅开发/测试环境手动触发"的低频操作（用户改 hook 文件 → 手动 curl 重载），这个成本可接受；未观察到需要缓解的迹象。
- **记录以免复议**：`?v=` 方案已实测证伪，不应在后续迭代中因"看起来更简单/更常见"而重新引入——参见项目记忆 `reference-bun-esm-cache-busting-query-fails-data-url-works`。

## 未采纳的备选（合并记录）

- **单一 `HookedTransport` decorator**（决策 1 已述）——被否：够不着 `onRequest`/`rewriteUpstreamFrame` 两个 transport 边界外的挂载点，用户明确要多挂载点。
- **`?v=` query cache-busting**（决策 2 已述）——被否：Bun 实测无效（按路径缓存、忽略 query），是 Node-only 手法。
- **per-request mtime 检查自动热重载**——用户否决（spec §2）：每请求 stat 文件的隐式开销 + 时机不可控，用户明确偏好"仅经管理 API 显式触发"。
