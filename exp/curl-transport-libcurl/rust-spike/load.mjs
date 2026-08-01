import { createRequire } from "node:module"

const require = createRequire(import.meta.url)
const native = require("./copilot_http_transport_spike.node")
const started = performance.now()
const body = await native.getHttps("https://example.com/")
console.log(JSON.stringify({ runtime: typeof Bun === "undefined" ? `node ${process.version}` : `bun ${Bun.version}`, bytes: Buffer.byteLength(body), elapsedMs: +(performance.now() - started).toFixed(1) }))
