import {
  //
  describe,
  expect,
  test,
} from "bun:test"
import {
  //
  readdir,
  readFile,
} from "node:fs/promises"
import path from "node:path"

async function sourceFiles(root: string): Promise<Array<string>> {
  const entries = await readdir(root, { withFileTypes: true })
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const resolved = path.join(root, entry.name)
      return (
        entry.isDirectory() ? sourceFiles(resolved)
        : entry.isFile() && entry.name.endsWith(".ts") ? [resolved]
        : []
      )
    }),
  )
  return nested.flat()
}

async function importsUnder(root: string): Promise<Array<{ file: string; source: string }>> {
  const files = await sourceFiles(root)
  return Promise.all(files.map(async (file) => ({ file, source: await readFile(file, "utf8") })))
}

describe("generation runtime engine import boundaries", () => {
  test("delivery does not import generation retry/candidate/dispatch or physical transport implementations", async () => {
    const files = await importsUnder(path.resolve(import.meta.dir, "../../src/lib/pipeline/delivery"))
    for (const { file, source } of files) {
      expect(source, file).not.toMatch(/from ["'](?:~\/lib\/pipeline\/generation|\.\.\/generation|~\/lib\/transport|\.\.\/\.\.\/transport)/)
    }
  })

  test("physical transport and connection liveness do not import generation or downstream delivery", async () => {
    const files = await importsUnder(path.resolve(import.meta.dir, "../../src/lib/transport"))
    for (const { file, source } of files) {
      expect(source, file).not.toMatch(/from ["'](?:~\/lib\/pipeline\/(?:generation|delivery)|\.\.\/pipeline\/(?:generation|delivery))/)
    }
  })

  test("generation orchestration depends on the delivery port, not concrete Hono SSE/WS sinks", async () => {
    const files = await importsUnder(path.resolve(import.meta.dir, "../../src/lib/pipeline/generation"))
    for (const { file, source } of files) {
      expect(source, file).not.toMatch(/hono\/(?:streaming|ws)|makeSseSink|makeWsSink|makeDeliverySseSink|makeDeliveryWsSink/)
    }
  })

  test("dispatch disposal cannot own pooled HTTP/2 sessions or their keepalive timers", async () => {
    const source = await readFile(path.resolve(import.meta.dir, "../../src/lib/transport/dispatch-lifecycle.ts"), "utf8")
    expect(source).not.toMatch(/http2-client|closeHttp2Sessions|scheduleH2KeepalivePing|clearInterval|session\.close/)
    expect(source).toContain("connectionReusable: true")
  })

  test("HTTP/2 GOAWAY removes routing eligibility but preserves PING until error or close", async () => {
    const source = await readFile(path.resolve(import.meta.dir, "../../src/lib/transport/http2-client.ts"), "utf8")
    expect(source).toMatch(/session\.on\("error", dispose\)/)
    expect(source).toMatch(/session\.on\("close", dispose\)/)
    expect(source).toMatch(/session\.on\("goaway", removeFromPool\)/)
    expect(source).not.toMatch(/session\.on\("goaway", dispose\)/)
  })

  test("upstream WS has no application PING scheduler that could masquerade as semantic progress", async () => {
    const source = await readFile(path.resolve(import.meta.dir, "../../src/lib/openai/upstream-ws-connection.ts"), "utf8")
    const code = source.replaceAll(/^\/\/.*$/gm, "")
    expect(code).not.toMatch(/\.ping\(|setInterval\(/)
  })
})
