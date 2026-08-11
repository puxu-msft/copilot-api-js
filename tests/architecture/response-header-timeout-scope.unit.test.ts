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
  test("HTTP lifecycle signals do not reuse the persistent first-event timeout helper", () => {
    expect(read("src/lib/transport/send.ts")).not.toContain(`combineAbortSignals(${retiredHeaderSignalHelper}`)
  })

  test("the transport watchdog does not import the higher-level fetch utilities module", () => {
    expect(read("src/lib/transport/upstream-fetch.ts")).not.toContain("~/lib/fetch-utils")
    expect(read("src/lib/transport/upstream-fetch.ts")).toContain('from "./response-header-deadline"')
  })

  test("the timeout resolver does not create a models-to-anthropic back edge", () => {
    expect(read("src/lib/models/timeout-resolver.ts")).not.toContain("~/lib/anthropic/")
    expect(read("src/lib/models/timeout-resolver.ts")).toContain('from "./model-pattern"')
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
