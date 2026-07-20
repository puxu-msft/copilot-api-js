// PoC-B — Two questions, measured against a LOOPBACK Bun.serve WS server (127.0.0.1),
// mirroring the h2 keepalive `ss` verification in http2-client.ts:
//
//   Q1 (functional ping): does the client WebSocket obtained via `import {WebSocket}
//       from "undici"` actually put a WS PING frame on the wire? (The server's Bun.serve
//       `ping` handler fires ⟺ a real ping frame arrived.)
//   Q2 (TCP keepalive):  does that client socket carry `timer:(keepalive,...)` in
//       `ss -tnope`? i.e. is SO_KEEPALIVE set on the upgrade socket by default?
//
// The client is whatever `import {WebSocket} from "undici"` resolves to IN THE CURRENT
// RUNTIME — under Bun that is Bun's native globalThis.WebSocket; under Node it is npm
// undici's WHATWG WebSocket. Run under BOTH to see the runtime split:
//   bun  exp/ws-upstream-keepalive/probe-tcp-keepalive.mjs
//   node exp/ws-upstream-keepalive/probe-tcp-keepalive.mjs   (needs a WS server; Bun.serve
//                                                              is Bun-only, so Node run is
//                                                              client-API-only — see note)
//
// Discipline: binds 127.0.0.1 only, ephemeral port, server stopped in finally, `ss` is
// read-only. No GHC upstream is contacted.
import { WebSocket } from "undici"
import { execSync } from "node:child_process"

const isBun = typeof Bun !== "undefined"
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  if (!isBun) {
    // Bun.serve is Bun-only. Under Node we cannot stand up the loopback WS server here
    // without pulling in a `ws` dependency, so this run reports the client API surface
    // only (the prototype scan in probe-api.mjs is the authoritative Node result).
    console.log("[node] runtime =", process.version)
    console.log("[node] undici WebSocket.prototype has ping():", typeof WebSocket.prototype.ping === "function")
    console.log("[node] (loopback ss probe skipped — Bun.serve is Bun-only; run under bun for the wire test)")
    return
  }

  let server
  let client
  try {
    let pingReceived = false
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0, // ephemeral
      fetch(req, srv) {
        if (srv.upgrade(req)) return undefined
        return new Response("expected ws upgrade", { status: 426 })
      },
      websocket: {
        open() {},
        message() {},
        // Bun.serve fires this ONLY when a real WS PING control frame arrives.
        ping(ws, data) {
          pingReceived = true
          void ws
          void data
        },
      },
    })

    const port = server.port
    const url = `ws://127.0.0.1:${port}`
    console.log("[bun] runtime =", process.versions.bun ? `bun ${process.versions.bun}` : "bun")
    console.log("[bun] undici.WebSocket === globalThis.WebSocket:", WebSocket === globalThis.WebSocket)
    console.log("[bun] client WebSocket has ping():", typeof WebSocket.prototype.ping === "function")
    console.log("[bun] loopback server:", url)

    client = new WebSocket(url)
    await new Promise((resolve, reject) => {
      client.addEventListener("open", () => resolve(), { once: true })
      client.addEventListener("error", (e) => reject(new Error(`client error: ${e?.message ?? "unknown"}`)), { once: true })
    })
    console.log("[bun] client connected (readyState=OPEN)")

    // Q1 — functional ping: call .ping() and see if the server's ping handler fires.
    if (typeof client.ping === "function") {
      client.ping()
      await sleep(150)
      console.log("[bun] Q1 client.ping() -> server received PING frame:", pingReceived)
    } else {
      console.log("[bun] Q1 client.ping() not a function — cannot send app-level ping")
    }

    // Q2 — TCP keepalive: hold the socket open and inspect it with ss.
    await sleep(200)
    let ssOut = ""
    try {
      // Match either endpoint of the loopback pair on the server port.
      ssOut = execSync(`ss -tnope 2>/dev/null | grep ':${port}\\b' || true`, { encoding: "utf8" })
    } catch (e) {
      ssOut = `<ss failed: ${e?.message ?? e}>`
    }
    console.log("[bun] Q2 ss -tnope (sockets on :" + port + "):")
    console.log(ssOut.trim() || "  (no matching rows — ss unavailable or filtered)")
    const hasKeepaliveTimer = /timer:\(keepalive/.test(ssOut)
    console.log("[bun] Q2 socket carries timer:(keepalive,...):", hasKeepaliveTimer)
  } finally {
    try {
      client?.close(1000, "poc done")
    } catch {
      /* best-effort */
    }
    server?.stop(true)
    console.log("[bun] server stopped")
  }
}

await main()
