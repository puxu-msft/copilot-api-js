import {
  //
  describe,
  expect,
  test,
} from "bun:test"
import { ref } from "vue"

import type { HistoryEntry } from "@/types"

import { useDetailStages } from "@/composables/useDetailStages"

function entry(over: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    id: "e",
    endpoint: "anthropic-messages",
    startedAt: 0,
    inboundRequest: { model: "m", messages: [{ role: "user", content: "hi" }] },
    ...over,
  } as HistoryEntry
}

describe("useDetailStages", () => {
  test("inbound + meta always present; wire/upstream/forwarded/attempts/effective gated by data", () => {
    const e = ref<HistoryEntry | null>(entry())
    const active = ref("inbound")
    const { stages } = useDetailStages(e, active)
    const keys = stages.value.map((s) => s.key)
    expect(keys).toContain("inbound")
    expect(keys).toContain("meta")
    expect(keys).not.toContain("wire") // no outboundRequest.payload
    expect(keys).not.toContain("effective") // no effectiveRequest
    expect(keys).not.toContain("attempts")
  })

  test("effective present only when effectiveRequest differs from inbound", () => {
    const same = ref<HistoryEntry | null>(entry({ effectiveRequest: { messages: [{ role: "user", content: "hi" }] } } as Partial<HistoryEntry>))
    const differ = ref<HistoryEntry | null>(entry({ effectiveRequest: { messages: [{ role: "user", content: "CHANGED" }] } } as Partial<HistoryEntry>))
    expect(useDetailStages(same, ref("inbound")).stages.value.map((s) => s.key)).not.toContain("effective")
    expect(useDetailStages(differ, ref("inbound")).stages.value.map((s) => s.key)).toContain("effective")
  })

  test("wire/upstream/attempts presence", () => {
    const e = ref<HistoryEntry | null>(
      entry({
        outboundRequest: { payload: { x: 1 } },
        outboundResponse: { success: true, model: "m", usage: { input_tokens: 0, output_tokens: 0 }, content: { role: "assistant", content: "ok" } },
        attempts: [
          { index: 0, durationMs: 1 },
          { index: 1, durationMs: 1 },
        ],
      } as Partial<HistoryEntry>),
    )
    const keys = useDetailStages(e, ref("inbound")).stages.value.map((s) => s.key)
    for (const k of ["inbound", "wire", "upstream", "attempts", "meta"]) expect(keys).toContain(k)
  })

  test("activeTocIds = the active stage's tocIds, headers-before-messages for inbound", () => {
    const e = ref<HistoryEntry | null>(entry({ httpHeaders: { inboundRequest: { a: "b" } } } as Partial<HistoryEntry>))
    const active = ref("inbound")
    const { activeTocIds } = useDetailStages(e, active)
    expect(activeTocIds.value).toEqual(["httpHeaders", "request"]) // headers first
  })

  test("manageActiveStage resets an invalid active stage to the first present one", () => {
    const e = ref<HistoryEntry | null>(entry()) // no effective stage
    const active = ref("effective") // not present
    useDetailStages(e, active, { manageActiveStage: true })
    expect(active.value).toBe("inbound") // reset synchronously by the immediate watch
  })

  test("without manageActiveStage, the active stage is left untouched", () => {
    const e = ref<HistoryEntry | null>(entry())
    const active = ref("effective")
    useDetailStages(e, active)
    expect(active.value).toBe("effective")
  })
})
