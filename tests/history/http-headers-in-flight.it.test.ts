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
// RFC history-http-header-capture Phase 5 — headers in-flight 可见
//
// setter(setInboundRequestHeaders / setInboundResponseHeaders)发
// request.context_updated(field "httpHeaders"),history sink 的 onContextUpdated
// 把 live 捕获的 CLIENT 腿 headers 镜像到 in-flight entry 的新腿
// (clientRequest.headers / clientResponse.headers)——流式请求在 finalize 前即可见
// header(最初"看不到 headers"痛点的直接解)。上游(逐 attempt)headers 走 attempt
// stage,不在此顶层镜像。不进轻量 snapshot(保精简)。
// ============================================================================

describe("Phase 5: headers in-flight 可见", () => {
  useIsolatedRuntime()

  test("setInboundRequestHeaders 后 in-flight entry 立即含 clientRequest.headers", () => {
    const manager = getRequestContextManager()
    const ctx = manager.create({ endpoint: "anthropic-messages", method: "POST", path: "/v1/messages" })
    ctx.setOriginalRequest({ model: "m", messages: [], stream: true, payload: {} })

    // 建好 in-flight entry(eager clientRequest 已建,但还没捕获 headers)
    expect(getInFlight(ctx.id)?.clientRequest?.headers).toBeUndefined()

    ctx.setInboundRequestHeaders({ authorization: "Bearer client-secret", "x-test": "1" })

    // Phase 5: publish → sink 镜像 → in-flight 立即可见(原始未脱敏),不覆盖 clientRequest 其他字段
    expect(getInFlight(ctx.id)?.clientRequest?.headers).toEqual({ authorization: "Bearer client-secret", "x-test": "1" })
    expect(getInFlight(ctx.id)?.clientRequest?.model).toBe("m")
  })

  test("setInboundResponseHeaders 后 in-flight entry 立即含 clientResponse.headers", () => {
    const manager = getRequestContextManager()
    const ctx = manager.create({ endpoint: "openai-chat-completions", method: "POST", path: "/chat/completions" })
    ctx.setOriginalRequest({ model: "m", messages: [], stream: true, payload: {} })

    ctx.setInboundResponseHeaders({ "x-forwarded": "v", "content-type": "text/event-stream" })

    // 转发给客户端的响应 headers 在 finalize 前即可见于 clientResponse 腿。
    expect(getInFlight(ctx.id)?.clientResponse?.headers).toEqual({ "x-forwarded": "v", "content-type": "text/event-stream" })
  })
})
