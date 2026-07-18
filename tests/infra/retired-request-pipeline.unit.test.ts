import {
  //
  describe,
  expect,
  test,
} from "bun:test"
import {
  //
  existsSync,
  readdirSync,
  readFileSync,
} from "node:fs"
import { join } from "node:path"

const ROOT = join(import.meta.dir, "../..")
const SRC = join(ROOT, "src")

function typescriptSources(dir: string): Array<string> {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return typescriptSources(path)
    return entry.isFile() && entry.name.endsWith(".ts") ? [path] : []
  })
}

describe("retired request executor architecture", () => {
  test("production owns request orchestration only in the generation driver", () => {
    const source = typescriptSources(SRC)
      .map((path) => readFileSync(path, "utf8"))
      .join("\n")

    // Positive reachability control: prove the scan reached the live orchestrator.
    expect(source).toContain("createPipelineDriver")
    expect(existsSync(join(SRC, "lib/request/pipeline.ts"))).toBe(false)
    expect(existsSync(join(SRC, "lib/pipeline/legacy-strategy-adapter.ts"))).toBe(false)
    expect(source).not.toContain("executeRequestPipeline")
    expect(source).not.toContain("legacy-strategy-adapter")
    expect(source).not.toContain("adaptLegacyStrategy")
  })
})
