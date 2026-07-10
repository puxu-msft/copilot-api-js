// PoC-A — Rigorously confirm undici's WHATWG client WebSocket exposes NO ping()
// and NO underlying-socket accessor. If both hold, an application-level WS ping
// keepalive (the analogue of scheduleH2KeepalivePing in http2-client.ts) is
// infeasible BY API SURFACE, independent of any GHC upstream behaviour.
//
// Run: bun exp/ws-upstream-keepalive/probe-api.mjs   (or: node ...)
import { WebSocket } from "undici"

// Walk the full prototype chain (WebSocket → EventTarget → ...) and collect every
// own-property name at each level, so a method hidden on a base class is still seen.
const proto = WebSocket.prototype
const members = []
for (let o = proto; o && o !== Object.prototype; o = Object.getPrototypeOf(o)) {
  members.push(...Object.getOwnPropertyNames(o))
}
const uniq = [...new Set(members)].sort()

// A live instance would carry per-instance fields too; enumerate one without opening
// a real connection (constructing to an unroutable URL still populates own props, then
// we close it immediately so nothing lingers). Best-effort — the prototype scan is the
// authoritative check; the instance scan only widens coverage.
let instanceProps = []
try {
  const ws = new WebSocket("ws://127.0.0.1:0")
  instanceProps = Object.getOwnPropertyNames(ws)
  ws.addEventListener("error", () => {}, { once: true }) // absorb the inevitable connect error
  try {
    ws.close()
  } catch {
    /* not yet open */
  }
} catch (e) {
  instanceProps = [`<construction threw: ${e?.message ?? e}>`]
}

const allNames = [...new Set([...uniq, ...instanceProps])].sort()
const socketLike = allNames.filter((m) => /socket|dispatcher|_ws|stream|fd/i.test(m))

console.log("undici version (from package):", await import("undici/package.json", { with: { type: "json" } }).then((m) => m.default.version).catch(() => "unknown"))
console.log("prototype-chain members:", uniq.join(", "))
console.log("instance own props:", instanceProps.join(", "))
console.log("")
console.log("has ping():", typeof proto.ping === "function")
console.log("has pong():", typeof proto.pong === "function")
console.log("socket/dispatcher-like member names:", socketLike.length ? socketLike.join(", ") : "(none)")
console.log("")
console.log("CONCLUSION app-level WS ping feasible:", typeof proto.ping === "function")
