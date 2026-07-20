---
name: methodology-reason-from-primitive-not-dominant-wrapper
description: 两套机制并存（干净 primitive + 耦合全局的便利 wrapper）时从 primitive 推理、别从流行用法泛化
metadata:
  type: feedback
---

写测试骨架/接线时，若同一能力有**两套机制并存**——一个干净的**专用 primitive** + 一个把它耦合到全局的**便利 wrapper**——判定行为/风险要**从 primitive 的实现推理**，别从代码里的**流行用法**泛化。

**实例（本项目 2026-07-13 client↔proxy SDK e2e 骨架）**：屏蔽上游有两条路——`setUpstreamFetchForTests(fn)`（`src/lib/transport/upstream-fetch.ts`，替换模块级 `activeUpstreamFetch`，**只被 `upstreamFetch()` 调用、不碰 `globalThis.fetch`**）vs `applyFetchMock`/`setFetchMock`（`tests/helpers/mock-fetch.ts`，装 `globalThis.fetch = mock` 并把上游桥回 globalThis）。golden 测试**主流用**后者（因走 `app.request()` 无真实 SDK、globalThis mock 无害）。我据这个流行用法泛化成「上游=全局 fetch-mock」，把 e2e 骨架的隔离风险**搞反了方向**（担心同进程 fetch-mock 误伤真实 SDK→自锁、要 host-scoping）——而我**早先就亲手读过并引用过** primitive 的注释「route upstreamFetch through fn」，ground truth 在手却让流行用法盖过它。reviewer 逼我重读 primitive 才纠正：直接用 `setUpstreamFetchForTests` 则 `globalThis.fetch` 全程不碰、真实 SDK 天然隔离、零 host-scoping。

**Why:** 便利 wrapper 常为了「复用现有 harness」把干净 primitive 耦合进全局副作用；文件头 doc 与主流调用点都指向 wrapper，会把「该能力只能经全局」这个**错误框架**植入心智。primitive 才是行为真相。这是 `verifying-authoritative-claims`「从独立 ground truth 裁决、别从声音权威/流行度」在**代码机制**上的投影（[[feedback-pass-null-clean-not-self-validating]]）。

**How to apply:** 接线/判风险前，找到该能力的**最底层 primitive**读它到底改了什么全局态；两套机制并存时优先用**副作用最小的那个**（此处 `setUpstreamFetchForTests` 而非 `applyFetchMock`）。已读到过的 primitive 事实**优先于**任何流行用法泛化——若二者冲突，是我泛化错了、回去重读 primitive。
