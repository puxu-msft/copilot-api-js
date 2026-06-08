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
