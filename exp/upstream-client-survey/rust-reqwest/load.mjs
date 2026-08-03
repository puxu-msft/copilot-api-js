import { createRequire } from "node:module"

const url = process.argv[2]
if (!url) throw new Error("usage: load.mjs <h2c-url>")

const require = createRequire(import.meta.url)
const native = require("./upstream_client_reqwest_spike.node")
const started = performance.now()
const result = await native.probeH2(url, 100)
console.log(JSON.stringify({
  runtime: typeof Bun === "undefined" ? `node ${process.version}` : `bun ${Bun.version}`,
  elapsedMs: +(performance.now() - started).toFixed(1),
  ...result,
}))
