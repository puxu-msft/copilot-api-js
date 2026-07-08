/**
 * Pure-logic tests for the Models table's thinking-column summary. Asserts the
 * real label + tooltip forms (adaptive > fixed budget ≤N > plain ✓ > none ·)
 * derived from {@link DerivedCapabilities}, so the cell shows the actual thinking
 * budget instead of an opaque ✓.
 */

import type { DerivedCapabilities } from "~backend/lib/models/capabilities"

import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import { thinkingLabel } from "@/lib/model-thinking"

const caps = (o: Partial<DerivedCapabilities>): DerivedCapabilities =>
  ({ thinking: false, adaptiveThinking: false, maxThinkingBudget: 0, ...o }) as DerivedCapabilities

describe("thinkingLabel", () => {
  test("no thinking → ·", () => {
    expect(thinkingLabel(caps({}))).toEqual({ text: "·", title: "no thinking" })
  })

  test("adaptive → adaptive", () => {
    expect(thinkingLabel(caps({ thinking: true, adaptiveThinking: true }))).toEqual({ text: "adaptive", title: "adaptive thinking" })
  })

  test("fixed budget → ≤N", () => {
    expect(thinkingLabel(caps({ thinking: true, maxThinkingBudget: 8192 }))).toEqual({ text: "≤8192", title: "max thinking budget 8192" })
  })

  test("adaptive wins over a positive budget", () => {
    expect(thinkingLabel(caps({ thinking: true, adaptiveThinking: true, maxThinkingBudget: 8192 }))).toEqual({ text: "adaptive", title: "adaptive thinking" })
  })

  test("plain thinking with no budget → ✓", () => {
    expect(thinkingLabel(caps({ thinking: true }))).toEqual({ text: "✓", title: "thinking" })
  })
})
