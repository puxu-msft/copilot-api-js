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
