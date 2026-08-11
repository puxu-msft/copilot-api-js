import http2 from "node:http2"
import { combineAbortSignals, guardSseIterable } from "/home/xp/src/copilot-api-js/packages/foundation/src/stream.ts"
import { createDispatchLifecycle } from "/home/xp/src/copilot-api-js/src/lib/transport/dispatch-lifecycle.ts"
import { http2Fetch, setHttp2SessionFactoryForTests } from "/home/xp/src/copilot-api-js/src/lib/transport/http2-client.ts"
import { ownedResponseEvents } from "/home/xp/src/copilot-api-js/src/lib/transport/send.ts"

const server = http2.createServer()
server.on("stream", (stream) => {
  stream.respond({ ":status": 200, "content-type": "text/event-stream" })
  stream.write('event: x\ndata: {"type":"response.created"}\n\n')
})
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
const address = server.address()
if (!address || typeof address === "string") throw new Error("missing port")
setHttp2SessionFactoryForTests(() => http2.connect(`http://127.0.0.1:${address.port}`))

const outcomes: Record<string, number> = {}
for (let i = 0; i < 25; i++) {
  const client = new AbortController()
  const lifecycle = createDispatchLifecycle(combineAbortSignals(client.signal))
  const response = await http2Fetch(`https://probe.invalid/${i}`, {
    method: "POST",
    body: "{}",
    signal: lifecycle.signal,
  })
  const guarded = guardSseIterable(ownedResponseEvents(response), {
    idleTimeoutMs: 60_000,
    clientSignal: client.signal,
    dispatchSignal: lifecycle.signal,
  })
  const iterator = lifecycle.ownFrames(guarded)[Symbol.asyncIterator]()
  await iterator.next()
  client.abort()
  try {
    await iterator.next()
    outcomes["clean"] = (outcomes["clean"] ?? 0) + 1
  } catch (error) {
    const key = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    outcomes[key] = (outcomes[key] ?? 0) + 1
  }
  await lifecycle.quiesced
}

console.log(JSON.stringify(outcomes, null, 2))
setHttp2SessionFactoryForTests(undefined)
await new Promise<void>((resolve) => server.close(() => resolve()))
