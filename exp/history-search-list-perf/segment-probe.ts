/** Probe: how does one flush distribute documents across segments? */
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { getNativeHistorySearch } from "../../src/lib/history/search-native"

const { HistoryIndex } = await getNativeHistorySearch()

async function inspect(count: number): Promise<void> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "segment-probe-"))
  const index = new HistoryIndex(directory)
  for (let i = 0; i < count; i++) {
    await index.upsertSummary({
      operationId: `op-${String(i).padStart(4, "0")}`,
      operationKind: "generation",
      createdAt: 1000 - i,
      committedAt: 10,
      content: "segment needle",
    })
  }
  await index.flush()
  const meta = JSON.parse(await fs.readFile(path.join(directory, "meta.json"), "utf8")) as {
    segments: Array<{ max_doc: number }>
  }
  console.log(`${count} docs -> ${meta.segments.length} segments, sizes ${meta.segments.map((s) => s.max_doc).join(",")}`)
  await index.close()
  await fs.rm(directory, { recursive: true, force: true })
}

for (const count of [3, 8, 30, 200]) await inspect(count)
