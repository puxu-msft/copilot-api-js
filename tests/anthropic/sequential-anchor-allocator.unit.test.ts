import {
  //
  expect,
  test,
} from "bun:test"

import { createGenerationWireIndexAllocator } from "~/lib/anthropic/keepalive-anchor"

test("sequential allocation: anchor@0, real@1, gap-anchor@2, real@3 (never two blocks share an index)", () => {
  const a = createGenerationWireIndexAllocator()
  expect(a.nextAnchorIndex()).toBe(0) // pre-content anchor
  a.onAnchorOpen()
  expect(a.nextRealIndex()).toBe(1) // first real block after the anchor closed
  a.onRealBlockOpen()
  expect(a.nextAnchorIndex()).toBe(2) // gap anchor
  a.onAnchorOpen()
  expect(a.nextRealIndex()).toBe(3) // second real block
  a.onRealBlockOpen()
})

test("realBlockOffset maps an upstream block index to the current wire index", () => {
  const a = createGenerationWireIndexAllocator()
  a.onAnchorOpen() // anchor@0
  a.onRealBlockOpen() // real block opened at wire index 1 (upstream index 0)
  // upstream frame for this block carries index 0 → wire 1 → offset 1
  expect(a.realBlockOffset(0)).toBe(1)
  a.onAnchorOpen() // gap anchor@2
  a.onRealBlockOpen() // real block opened at wire index 3 (upstream index 1)
  // upstream frame carries index 1 → wire 3 → offset 2
  expect(a.realBlockOffset(1)).toBe(2)
})

test("peek methods are pure — they do not advance until on*Open is called", () => {
  const a = createGenerationWireIndexAllocator()
  expect(a.nextAnchorIndex()).toBe(0)
  expect(a.nextAnchorIndex()).toBe(0) // still 0 — no advance
  a.onAnchorOpen()
  expect(a.nextRealIndex()).toBe(1)
  expect(a.nextRealIndex()).toBe(1) // still 1
})

test("anchorsOpened is a DIAGNOSTIC counter — never a remap predicate", () => {
  const a = createGenerationWireIndexAllocator()
  expect(a.anchorsOpened()).toBe(0)
  a.onRealBlockOpen()
  expect(a.anchorsOpened()).toBe(0)
  a.onAnchorOpen()
  expect(a.anchorsOpened()).toBe(1)
})

test("allocateAnchor / allocateRealBlock atomically advance the generation frontier", () => {
  const a = createGenerationWireIndexAllocator()
  a.beginLeg("primary", { candidateId: "candidate-primary", dispatchId: "dispatch-primary" })
  expect(a.allocateAnchor()).toBe(0)
  expect(a.allocateRealBlock(0).wireIndex).toBe(1)
  expect(a.allocateAnchor()).toBe(2)
  expect(a.allocateRealBlock(1).wireIndex).toBe(3)
})

test("mappings are immutable tokens — a later leg cannot change an earlier block", () => {
  const a = createGenerationWireIndexAllocator()
  const primary = a.beginLeg("primary", { candidateId: "candidate-primary", dispatchId: "dispatch-primary" })
  const frame = { event: "content_block_start", data: '{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}' }
  const m0 = a.allocateRealBlock(0)
  const continuation = a.beginLeg("continuation", { candidateId: "candidate-cont", dispatchId: "dispatch-cont" })
  const m1 = a.allocateRealBlock(0)

  expect(m0.leg).toBe(primary)
  expect(m1.leg).toBe(continuation)
  expect(m0.wireIndex).toBe(0)
  expect(m1.wireIndex).toBe(1)
  expect(m0.remap(frame)).toBe(frame)
  expect(JSON.parse(m1.remap(frame).data as string).index).toBe(1)
})

test("a rolled-back reservation leaves the frontier and diagnostics unchanged", () => {
  const a = createGenerationWireIndexAllocator()
  a.beginLeg("primary", { candidateId: "candidate-primary", dispatchId: "dispatch-primary" })
  const reservation = a.reserveAnchor()
  expect(reservation.value).toBe(0)
  reservation.rollback()
  expect(a.nextAnchorIndex()).toBe(0)
  expect(a.anchorsOpened()).toBe(0)

  const committed = a.reserveAnchor()
  committed.commit()
  expect(a.nextAnchorIndex()).toBe(1)
  expect(a.anchorsOpened()).toBe(1)
})

test("allocating a real block without an active leg is rejected", () => {
  const a = createGenerationWireIndexAllocator()
  expect(() => a.allocateRealBlock(0)).toThrow("active leg")
})
