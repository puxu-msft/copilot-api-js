import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import { getRequestContextManager } from "~/lib/context/manager"
import { getInFlight } from "~/lib/history/in-flight"

import { useIsolatedRuntime } from "../helpers/isolated-fixture"

// ============================================================================
// RFC history-http-header-capture Phase 5 — httpHeaders in-flight 可见
//
// setter(setInboundRequestHeaders / setHttpHeaders)发 request.context_updated
// (field "httpHeaders"),history sink 的 onContextUpdated 把 live ctx.httpHeaders
// 镜像到 in-flight entry——流式请求在 finalize 前即可见 header(最初"看不到
// headers"痛点的直接解)。不进轻量 snapshot(保精简)。
// ============================================================================

describe("Phase 5: httpHeaders in-flight 可见", () => {
  useIsolatedRuntime()

  test("setInboundRequestHeaders 后 in-flight entry 立即含 inboundRequest 腿", () => {
    const manager = getRequestContextManager()
    const ctx = manager.create({ endpoint: "anthropic-messages", method: "POST", path: "/v1/messages" })
    ctx.setOriginalRequest({ model: "m", messages: [], stream: true, payload: {} })

    // 建好 in-flight entry，但还没捕获 headers
    expect(getInFlight(ctx.id)?.httpHeaders).toBeUndefined()

    ctx.setInboundRequestHeaders({ authorization: "Bearer client-secret", "x-test": "1" })

    // Phase 5: publish → sink 镜像 → in-flight 立即可见(原始未脱敏)
    expect(getInFlight(ctx.id)?.httpHeaders?.inboundRequest).toEqual({ authorization: "Bearer client-secret", "x-test": "1" })
  })

  test("setHttpHeaders(出站两腿)后 in-flight entry 立即含 outboundRequest/outboundResponse 腿", () => {
    const manager = getRequestContextManager()
    const ctx = manager.create({ endpoint: "openai-chat-completions", method: "POST", path: "/chat/completions" })
    ctx.setOriginalRequest({ model: "m", messages: [], stream: true, payload: {} })

    ctx.setHttpHeaders({ request: { authorization: "Bearer wire" }, response: { "x-upstream": "v" } })

    const h = getInFlight(ctx.id)?.httpHeaders
    expect(h?.outboundRequest).toEqual({ authorization: "Bearer wire" })
    expect(h?.outboundResponse).toEqual({ "x-upstream": "v" })
  })
})
