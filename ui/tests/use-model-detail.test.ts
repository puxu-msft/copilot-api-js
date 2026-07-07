import type { Model } from "~backend/lib/models/client"

import {
  //
  describe,
  expect,
  test,
} from "bun:test"
import { ref } from "vue"

import type { RequestTelemetrySnapshot } from "@/composables/telemetry-parse"

import { useModelDetail } from "@/composables/useModelDetail"

const m = (id: string): Model =>
  ({
    id,
    name: id,
    vendor: "Anthropic",
    object: "model",
    preview: false,
    model_picker_enabled: true,
    is_chat_default: false,
    is_chat_fallback: false,
    version: "1",
  }) as Model

const usage = () => ({ inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, reasoningTokens: 0 })
const snap = (last7d: Array<{ model: string; requestCount: number }>): RequestTelemetrySnapshot => ({
  acceptedSinceStart: 0,
  bucketSizeMinutes: 5,
  windowDays: 7,
  totalLast7d: 0,
  buckets: [],
  modelsSinceStart: [],
  modelsLast7d: last7d.map((r) => ({
    model: r.model,
    requestCount: r.requestCount,
    successCount: 0,
    failureCount: 0,
    totalDurationMs: 0,
    averageDurationMs: 0,
    usage: usage(),
    buckets: [],
  })),
})

describe("useModelDetail", () => {
  test("open/close toggles selectedId + isOpen; stores id not object", () => {
    const d = useModelDetail(ref([m("claude-opus-4.8")]), ref(null))
    expect(d.isOpen.value).toBe(false)
    d.open("claude-opus-4.8")
    expect(d.selectedId.value).toBe("claude-opus-4.8")
    expect(d.isOpen.value).toBe(true)
    d.close()
    expect(d.selectedId.value).toBeNull()
    expect(d.isOpen.value).toBe(false)
  })

  test("telemetryFor joins by normalized id", () => {
    const d = useModelDetail(ref([m("claude-opus-4.8")]), ref(snap([{ model: "claude-opus-4.8", requestCount: 5 }])))
    expect(d.telemetryFor("claude-opus-4.8")?.last7d?.requestCount).toBe(5)
    expect(d.telemetryFor("nonexistent")).toBeNull()
  })

  test("telemetryIndex recomputes when snapshot changes", () => {
    const s = ref<RequestTelemetrySnapshot | null>(null)
    const d = useModelDetail(ref([m("claude-opus-4.8")]), s)
    expect(d.telemetryFor("claude-opus-4.8")).toBeNull()
    s.value = snap([{ model: "claude-opus-4.8", requestCount: 9 }])
    expect(d.telemetryFor("claude-opus-4.8")?.last7d?.requestCount).toBe(9)
  })

  test("telemetryIndex.unmatched surfaces un-joinable telemetry", () => {
    const d = useModelDetail(ref([m("claude-opus-4.8")]), ref(snap([{ model: "opus", requestCount: 3 }])))
    expect(d.telemetryIndex.value.unmatched).toHaveLength(1)
    expect(d.telemetryIndex.value.unmatched[0].model).toBe("opus")
  })
})
