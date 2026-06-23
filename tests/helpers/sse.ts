/**
 * Shared Server-Sent Events (SSE) test fixtures.
 *
 * Builders for the `text/event-stream` `Response` objects that streaming-path
 * tests feed through the proxy. Previously copy-pasted byte-for-byte across the
 * Anthropic / OpenAI / Responses / WebSocket streaming test files.
 */

/**
 * Build a streaming `Response` (status 200, `content-type: text/event-stream`)
 * that emits each entry of `chunks` as a separate stream chunk, then closes.
 * Each chunk is sent verbatim — include the SSE framing (`event: ...\ndata:
 * ...\n\n`) in the strings you pass.
 */
export function createSseResponse(chunks: Array<string>) {
  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk))
      }
      controller.close()
    },
  })

  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  })
}

/**
 * Build a streaming `Response` that emits `chunks` verbatim, then ERRORS the body
 * (deterministic mid-stream H3): the consumer reads every chunk, then its next read
 * rejects with `error`. Used to drive an owns-sink handler's `stream-error` outcome
 * (settle `failed` + write the format's client error frame) with no timers, no flakiness.
 */
export function createSseResponseThenError(chunks: Array<string>, error: Error): Response {
  const encoder = new TextEncoder()
  let i = 0
  const stream = new ReadableStream({
    pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(encoder.encode(chunks[i]))
        i += 1
      } else {
        controller.error(error)
      }
    },
  })
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } })
}

/**
 * Build a streaming `Response` that emits `chunks` verbatim, then — on the consumer's
 * NEXT read — aborts `clientAbort` and blocks forever (deterministic mid-stream client
 * disconnect): the handler's read past the last chunk loses the race to the abort, so the
 * transport throws `StreamClientAbortError` → the owns-sink `settled-abort` outcome (settle
 * `aborted`, write ZERO further bytes). Mirrors the Anthropic `streaming-abort` pattern —
 * the abort fires from inside the body pull (after the chunks are consumed), not a timer.
 * Pass `clientAbort.signal` as the `app.request` signal so it bridges to the handler.
 */
export function createSseResponseThenAbort(chunks: Array<string>, clientAbort: AbortController): Response {
  const encoder = new TextEncoder()
  let i = 0
  const stream = new ReadableStream({
    pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(encoder.encode(chunks[i]))
        i += 1
      } else {
        clientAbort.abort()
        // Block forever: the read never resolves, so the abort deterministically wins.
        return new Promise<void>(() => {})
      }
    },
  })
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } })
}

/**
 * Parse a forwarded SSE string into the ordered list of frame `type` values (`message_start`,
 * `content_block_delta`, `ping`, `error`, …). A non-JSON `data: [DONE]` is reported as the literal
 * `"[DONE]"`; unparseable keepalive lines are skipped. The standard order-assertion helper for the
 * streaming golden tests (previously copy-pasted as a local `frameTypesInOrder` in several files).
 */
export function frameTypesInOrder(sse: string): Array<string> {
  const out: Array<string> = []
  for (const line of sse.split("\n")) {
    if (!line.startsWith("data: ")) continue
    const body = line.slice(6)
    if (body === "[DONE]") {
      out.push("[DONE]")
      continue
    }
    try {
      out.push((JSON.parse(body) as { type?: string }).type ?? "?")
    } catch {
      /* keepalive / non-json */
    }
  }
  return out
}

/** Parse the `data:` JSON objects of a given `type` out of a forwarded SSE string (e.g. all `error`
 *  frames). Complements {@link frameTypesInOrder} for tests that assert on a frame's payload. */
export function dataFramesOfType(sse: string, type: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = []
  for (const line of sse.split("\n")) {
    if (!line.startsWith("data: ")) continue
    const body = line.slice(6)
    if (body === "[DONE]") continue
    try {
      const obj = JSON.parse(body) as Record<string, unknown>
      if (obj.type === type) out.push(obj)
    } catch {
      /* keepalive / non-json */
    }
  }
  return out
}
