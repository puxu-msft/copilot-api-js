import {
  //
  describe,
  expect,
  test,
} from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"

const repoRoot = path.resolve(import.meta.dir, "../..")
const read = (relativePath: string): string => readFileSync(path.join(repoRoot, relativePath), "utf8")
const retiredHeaderSignalHelper = ["createResponseHeader", "TimeoutSignal"].join("")

describe("response-header timeout ownership", () => {
  test("HTTP callers pass timeout duration separately from lifecycle signals", () => {
    expect(read("src/lib/transport/send.ts")).toContain("responseHeaderTimeoutMs: resolveResponseHeaderTimeoutMs(modelId)")
    expect(read("src/lib/transport/send.ts")).not.toContain(`combineAbortSignals(${retiredHeaderSignalHelper}`)
    expect(read("src/lib/anthropic/client.ts")).toContain("responseHeaderTimeoutMs: resolveResponseHeaderTimeoutMs(model)")
    expect(read("src/routes/messages/count-tokens.ts")).toContain("responseHeaderTimeoutMs: resolveResponseHeaderTimeoutMs(outboundModel)")
    expect(read("src/lib/models/client.ts")).toContain("responseHeaderTimeoutMs: resolveResponseHeaderTimeoutMs(undefined)")
    expect(read("src/lib/openai/embeddings.ts")).toContain("responseHeaderTimeoutMs: resolveResponseHeaderTimeoutMs(payload.model)")
  })

  test("the persistent timeout signal is named and owned as a WebSocket first-event clock", () => {
    expect(read("src/lib/openai/upstream-ws-attempt.ts")).toContain("createUpstreamFirstEventTimeoutSignal(wire.model)")

    for (const relativePath of [
      "src/lib/transport/send.ts",
      "src/lib/anthropic/client.ts",
      "src/routes/messages/count-tokens.ts",
      "src/lib/models/client.ts",
      "src/lib/openai/embeddings.ts",
      "src/lib/openai/upstream-ws-attempt.ts",
      "src/lib/fetch-utils.ts",
    ]) {
      expect(read(relativePath)).not.toContain(retiredHeaderSignalHelper)
    }
  })
})
