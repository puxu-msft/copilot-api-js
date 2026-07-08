import type { Model } from "~backend/lib/models/client"

import {
  //
  describe,
  expect,
  it,
} from "bun:test"

import {
  //
  augmentRows,
  sortModelRows,
} from "@/components/models/model-table-columns"
import { modelStatus } from "@/lib/model-status"

const telemetryFor = (id: string) =>
  id === "b" ?
    ({ last7d: { requestCount: 9 } } as ReturnType<Parameters<typeof augmentRows>[1]>)
  : ({ last7d: { requestCount: 1 } } as ReturnType<Parameters<typeof augmentRows>[1]>)

const m = (over: Record<string, unknown> = {}): Model =>
  ({
    id: "m",
    name: "m",
    vendor: "v",
    object: "model",
    preview: false,
    model_picker_enabled: true,
    is_chat_default: false,
    is_chat_fallback: false,
    version: "1",
    billing: {},
    ...over,
  }) as Model

/** `sortModelRows` is the shared sort backing the CSV export — it must reproduce the
 *  table's TanStack order from the same accessors, given a SortingState. */
describe("sortModelRows", () => {
  const rows = (list: Array<Model>) => augmentRows(list, telemetryFor, (model) => modelStatus(model, new Set()))

  it("no sorting → input order preserved", () => {
    const list = [m({ id: "z" }), m({ id: "a" })]
    expect(sortModelRows(rows(list), []).map((r) => r.model.id)).toEqual(["z", "a"])
  })

  it("sorts by billing multiplier desc", () => {
    const list = [m({ id: "lo", billing: { multiplier: 1 } }), m({ id: "hi", billing: { multiplier: 3 } })]
    expect(sortModelRows(rows(list), [{ id: "billing", desc: true }]).map((r) => r.model.id)).toEqual(["hi", "lo"])
  })

  it("sorts by requests7d (joined telemetry) desc", () => {
    const list = [m({ id: "a" }), m({ id: "b" })]
    expect(sortModelRows(rows(list), [{ id: "requests7d", desc: true }]).map((r) => r.model.id)).toEqual(["b", "a"])
  })

  it("sorts by id asc (string localeCompare)", () => {
    const list = [m({ id: "gpt-5" }), m({ id: "claude-4" })]
    expect(sortModelRows(rows(list), [{ id: "id", desc: false }]).map((r) => r.model.id)).toEqual(["claude-4", "gpt-5"])
  })

  it("is stable on ties (equal keys keep input order)", () => {
    const list = [m({ id: "a", billing: { multiplier: 2 } }), m({ id: "b", billing: { multiplier: 2 } })]
    expect(sortModelRows(rows(list), [{ id: "billing", desc: true }]).map((r) => r.model.id)).toEqual(["a", "b"])
  })
})

/** `augmentRows` pre-resolves each row's UI status via the `statusFor` closure so the
 *  status column + row muting read a stable value (not recomputed per cell). */
describe("augmentRows status", () => {
  it("carries status via statusFor", () => {
    const models = [
      { id: "a", model_picker_enabled: true },
      { id: "b", model_picker_enabled: false },
    ] as unknown as Array<Model>
    const statusFor = (model: Model) => modelStatus(model, new Set(["a"]))
    const augmented = augmentRows(models, () => null, statusFor)
    expect(augmented.map((r) => r.status)).toEqual(["config-disabled", "picker-disabled"])
  })
})
