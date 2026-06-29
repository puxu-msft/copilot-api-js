---
name: reference-undici-response-not-globalthis-response
description: Node 下 undici Response 不是 globalThis.Response 实例;别用 instanceof Response 跨 undici/lib.dom 边界判别
metadata: 
  node_type: memory
  type: reference
  originSessionId: 23c7e548-1ad2-4ce2-9ae4-0445eb6ca9d2
---

**Node 运行时下** `import { Response } from "undici"` 的 Response 与 `globalThis.Response`(lib.dom)是**两个不同的类**:`undici.Response === globalThis.Response` 为 **false**,且 `undiciFetch(...)` 返回的对象 `instanceof globalThis.Response` 为 **false**(`instanceof undici.Response` 才 true)。

**Bun 下相反**:Bun 的 fetch shim 返回全局 Response,`undici.Response === globalThis.Response` 为 true——所以 `instanceof Response` 在 Bun 下"恰好"成立,会**掩盖** Node 路径的 bug。

**陷阱(C2 实例)**:`web-search/backends.ts` 曾用 `response instanceof Response` 判别 fetch 成功(配 `.catch(e=>e)` 把 reject 转成 Error)。改走真 undici(`upstream-fetch.ts`)后,Node 下成功的 undici Response `instanceof globalThis.Response===false` → 成功搜索被误判为失败。`bun test` 测不到(Bun 下 instanceof 恰好成立 + mock 桥返回全局 Response 双重掩盖)。

**修法**:别用 `instanceof Response` 跨 undici/lib.dom 边界判别身份。用结构判别——这里改成 `instanceof Error`(reject 必为 Error,见 fetch 规范),成功分支 `as Response` cast(undici/lib.dom Response 成员级结构兼容,只是名义类型不同)。成员访问(`.ok/.status/.headers.entries()/.json()/.text()/.body`)在两者上都兼容,**只有 `instanceof` 身份判别会坑**。

呼应 [[reference-bun-fetch-tcp-keepalive]](同一次 undici-on-Bun 迁移)、[[feedback-fix-all-comparison-sites]](grep 全仓 instanceof Response 确认无遗漏)。
