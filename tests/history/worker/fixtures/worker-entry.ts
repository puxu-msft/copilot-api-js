import {
  //
  parentPort,
  workerData,
} from "node:worker_threads"

if (!parentPort) throw new Error("worker-entry fixture requires a parent port")

if ((workerData as { crash?: boolean } | undefined)?.crash) throw new Error("deterministic fixture crash")

// Node MessagePort has no browser targetOrigin parameter.
// eslint-disable-next-line unicorn/require-post-message-target-origin
parentPort.postMessage({ ready: true })
