---
name: methodology-one-shot-connected-snapshot-needs-root-subscriber
description: "连接级一次性快照事件(WS connected 的 activeRequests)必须由常驻根订阅,页面级订阅晚挂载会静默漏初始快照、只剩实时增量"
metadata: 
  node_type: memory
  type: project
  originSessionId: 9adc2eaf-0885-437d-9c58-0b8c86859381
---

**症状**:ui-v4 在途面板「只显示打开页面后新发起的请求,之前已在飞行的请求不显示」。

**根因(跨层追踪确认)**:WS `connected` 事件携带初始在途快照 `activeRequests`(后端 `contextManager.getAll()` 正确返回活跃集,已核)。但它是**一次性事件**——`ws-client.ts` dispatch 只派发给到达时刻已注册的回调,无缓存。而唯一 `onConnected → live-store.setSnapshot` 的消费者 `useLiveRequests` 挂在 **requests 页**(`RequestsListPage`),该页晚挂载(深链/刷新落非 requests 路由、导航过去、redirect 多一个 tick),此时 socket 早已连上、`connected` 早已派发完 → `setSnapshot` 从不执行 → 打开前的在途集丢失;新请求经 `active_request_changed`(实时派发给所有当时在册回调)照常显示。

**修复**:把 `useLiveRequests()` 从 `RequestsListPage` **提升到常驻根 `AppShell`**(所有路由经其 `<Outlet/>` 渲染)。React commit 阶段同步刷 effect、WS 消息只能异步到达,故常驻根的订阅一定在 `connected` 前注册到位;live-store 从应用启动即被持续维护,LiveDock/Overview 只读 store。附带修好 OverviewPage 只读 store 从不订阅的同 bug,并让重连的新 `connected` 权威重同步(比修复前更稳)。

**How to apply**:任何「连接级一次性快照 + 后续实时增量」的订阅(WS `connected`/初始 dump/snapshot-then-delta 模式),快照消费者必须挂在**保证在传输连接建立前就已注册**的常驻宿主(app 根),绝不放会晚于连接挂载的页面级组件;否则表现为「只有增量、缺初始态」。判据:grep 一次性事件的唯一消费者,核其宿主是否常驻。备选(更通用但有陈旧风险):让传输层缓存最后一次快照并向晚订阅者补发——但须同步维护缓存(应用增量)否则补发陈旧态,不如根订阅干净。

**Related**:[[feedback-verify-ui-with-build-not-just-typecheck]](ui-v4 验收门)。回归守卫 `ui-v4/tests/AppShellLiveSubscription.vitest.test.tsx`(mock ws-client 捕获订阅回调 + fire connected + 断言 store 落地)。修复提交 `9a876c3b`。
