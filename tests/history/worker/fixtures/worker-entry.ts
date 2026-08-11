import {
  //
  parentPort,
  workerData,
} from "node:worker_threads"

if (!parentPort) throw new Error("worker-entry fixture requires a parent port")

const fixture = workerData as { crash?: boolean; roundtrip?: boolean } | undefined
if (fixture?.crash) throw new Error("deterministic fixture crash")

const payload = fixture?.roundtrip ? { bytes: new Uint8Array([1, 2, 3]), map: new Map([["n", 7]]) } : { ready: true }
// Node MessagePort has no browser targetOrigin parameter.
// eslint-disable-next-line unicorn/require-post-message-target-origin
parentPort.postMessage(payload)
