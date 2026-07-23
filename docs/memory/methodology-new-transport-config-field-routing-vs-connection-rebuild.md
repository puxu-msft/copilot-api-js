---
name: methodology-new-transport-config-field-routing-vs-connection-rebuild
description: 给共享 transport-config setter 加新配置字段前，先辨清它是「纯路由/纯读取标志」还是「连接级参数」——前者绝不进 change-detection，否则热改它连带触发全 h2 session retire + dispatcher rebuild + WS reconcile
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 03eae792-307f-4984-a453-0d7e5894adf4
  modified: 2026-07-23T03:39:13.966Z
---

给 `setUpstreamTransportConfig`（state.ts）加新字段时，**别反射式照抄既有字段把它加进 `changed` 计算**。该 setter 对**任何**追踪字段变化触发**全体** `onUpstreamTransportChange` 监听者，无 per-field 区分；订阅者含三个重量级副作用：`http2-client.ts:reconcileH2SessionsForConfigChange`（retire 全部活跃 h2 session + bump generation）、`proxy.ts:rebuildUpstreamDispatcher`、`openai/upstream-ws.ts` WS 池 reconcile。

判据：新字段是否需要**已建立连接的重建**？

- **连接级参数**（keepalive delay、h2 ping interval、connect timeout、WS 池上限）→ 进 `changed`，热改须让在途/池化连接感知。
- **纯路由/纯读取标志**（如 `upstreamH2Favor`：`upstream-fetch.ts` 逐请求 live 读，只决定下次走 http2 还是 undici）→ **绝不进 `changed`**。`updateState(patch)` 在 `changed` 门之前**无条件先行**，故值仍立即写入 state、下个请求即生效，只是不做无谓的连接抖动。

实例：`upstreamH2Favor`（HTTP/2 favor 开关）初版误加进 `changed`，异模型 reviewer 抓出——favor-only 热改会连带淘汰全 h2 session，且与文档「favor 只重路由无需 session teardown」自相矛盾。修复=移出 `changed` + 防回归注释 + 用 `onUpstreamTransportChange` 计数 spy 断言「favor 变更 fire 0 次、真连接字段 fire 1 次」（正样本对照）。

**Why:** 对称外观（照抄相邻字段的 change-detection 行）掩盖了非对称副作用（一个纯路由标志触发全连接池 teardown）；这类坑自审最易漏、须异模型 review。→ [[feedback-pass-null-clean-not-self-validating]] 通过/自洽不自证。

**How to apply:** 加 transport-config 字段前问「这字段改了要不要重建已有连接」；答否则排除出 listener-trigger 集、靠 `updateState` 无条件应用兜底路由即时性；写回归测试时用直接的 listener 计数 oracle（别只靠某具体 listener 的副作用形状如 dispatcher 引用同一性——该 listener 若改懒重建，间接 oracle 会失效）。承重实例见 [[project-transport-config-three-axis-reorg]]。
