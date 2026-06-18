/**
 * Real undici integration for upstreamFetch (Bun runtime).
 *
 * The .unit suite exercises the test bridge (globalThis.fetch mock). This suite
 * deliberately uses the PRODUCTION path (setUpstreamFetchForTests(undefined)) so
 * undici actually issues the request — verifying that the things the mock bridge
 * cannot prove (large body, streaming SSE body, AbortSignal mid-flight) work on
 * Bun + undici, which is what production runs. Mirrors the probe subagent's
 * findings with an in-repo regression guard (probe-harness-must-match-prod).
 *
 * Proxy paths (ProxyAgent / SOCKS) reuse the same undici Agent already validated
 * on Node; constructing them on Bun is covered by proxy.unit.test.ts. A live
 * proxy round-trip is left to out-of-band verification.
 */

import {
  //
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test"
import { events } from "fetch-event-stream"

import {
  //
  setUpstreamFetchForTests,
  upstreamFetch,
} from "~/lib/transport/upstream-fetch"

let server: ReturnType<typeof Bun.serve>
let baseUrl = ""

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      if (url.pathname === "/echo") {
        const body = await req.arrayBuffer()
        return new Response(JSON.stringify({ bytes: body.byteLength }), { status: 200, headers: { "content-type": "application/json" } })
      }
      if (url.pathname === "/sse") {
        const encoder = new TextEncoder()
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode('event: a\ndata: {"n":1}\n\n'))
            controller.enqueue(encoder.encode("data: [DONE]\n\n"))
            controller.close()
          },
        })
        return new Response(stream, { headers: { "content-type": "text/event-stream" } })
      }
      if (url.pathname === "/slow") {
        await Bun.sleep(5000)
        return new Response("late")
      }
      return new Response("not found", { status: 404 })
    },
  })
  baseUrl = `http://localhost:${server.port}`
})

afterAll(() => {
  server.stop(true)
})

describe("upstreamFetch — real undici integration (Bun)", () => {
  // Keep the production undici path; restore the default after each test.
  afterEach(() => {
    setUpstreamFetchForTests(undefined)
  })

  test("round-trips an ~800KB POST body through undici", async () => {
    setUpstreamFetchForTests(undefined)
    const body = "x".repeat(800 * 1024)
    const res = await upstreamFetch(`${baseUrl}/echo`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body,
    })
    expect(res.status).toBe(200)
    const json = (await res.json()) as { bytes: number }
    expect(json.bytes).toBe(800 * 1024)
  })

  test("reads a streaming SSE response through undici + events()", async () => {
    setUpstreamFetchForTests(undefined)
    const res = await upstreamFetch(`${baseUrl}/sse`, { method: "GET" })
    const seen: Array<string> = []
    for await (const ev of events(res)) {
      if (ev.data) seen.push(ev.data)
    }
    expect(seen).toContain('{"n":1}')
    expect(seen).toContain("[DONE]")
  })

  test("aborts an in-flight request via AbortSignal", async () => {
    setUpstreamFetchForTests(undefined)
    const ctrl = new AbortController()
    const pending = upstreamFetch(`${baseUrl}/slow`, { method: "GET", signal: ctrl.signal })
    setTimeout(() => ctrl.abort(), 50)
    await expect(pending).rejects.toThrow()
  })
})
