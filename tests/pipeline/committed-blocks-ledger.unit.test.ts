import {
  //
  expect,
  test,
} from "bun:test"

import { createCommittedBlocksLedger } from "~/lib/pipeline/committed-blocks-ledger"

test("records committed blocks in order, snapshot returns them", () => {
  const l = createCommittedBlocksLedger()
  l.recordCommitted({ type: "text", text: "Hello " })
  l.recordCommitted({ type: "tool_use", id: "t1", name: "Write", input: { path: "/x" } })
  expect(l.snapshot()).toEqual([
    { type: "text", text: "Hello " },
    { type: "tool_use", id: "t1", name: "Write", input: { path: "/x" } },
  ])
})

test("snapshot is a copy — mutating it does not affect the ledger", () => {
  const l = createCommittedBlocksLedger()
  l.recordCommitted({ type: "text", text: "a" })
  l.snapshot().push({ type: "text", text: "leak" })
  expect(l.snapshot()).toHaveLength(1)
})

test("empty ledger snapshots to an empty array", () => {
  expect(createCommittedBlocksLedger().snapshot()).toEqual([])
})
