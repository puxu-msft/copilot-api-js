/** Probe: does a re-upserted operation leave a live duplicate visible to the raw docset? */
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { getNativeHistorySearch } from "../../src/lib/history/search-native"

const { HistoryIndex } = await getNativeHistorySearch()
const directory = await fs.mkdtemp(path.join(os.tmpdir(), "supersede-probe-"))
const index = new HistoryIndex(directory)
const base = { operationKind: "generation", createdAt: 100, committedAt: 10, content: "supersede needle", sessionId: "s1" }

await index.upsertSummary({ ...base, operationId: "op-a", state: "streaming" })
for (let i = 0; i < 200; i++) {
  await index.upsertSummary({ ...base, operationId: `op-keep-${i}`, state: "streaming" })
}
await index.flush()
console.log("after first flush:", await index.generation())

await index.upsertSummary({ ...base, operationId: "op-a", state: "completed" })
await index.flush()
console.log("after second flush:", await index.generation())

const query = { query: "supersede needle", operationKinds: [], states: [] as Array<string>, targetCommittedAt: 10, targetOperationIds: ["op-a"], direction: "older" as const, limit: 10 }
console.log("no state filter:", await index.listSearch(query))
console.log("states=[streaming]:", await index.listSearch({ ...query, states: ["streaming"] }))
console.log("states=[completed]:", await index.listSearch({ ...query, states: ["completed"] }))
console.log("segment files:", (await fs.readdir(directory)).join(" "))
const meta = JSON.parse(await fs.readFile(path.join(directory, "meta.json"), "utf8")) as {
  segments: Array<{ segment_id: string; max_doc: number; deletes: unknown }>
}
console.log("live segments:", JSON.stringify(meta.segments.map((segment) => ({ id: segment.segment_id, maxDoc: segment.max_doc, deletes: segment.deletes }))))

await index.close()
await fs.rm(directory, { recursive: true, force: true })
