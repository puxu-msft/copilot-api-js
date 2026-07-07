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
  const rows = (list: Array<Model>) => augmentRows(list, telemetryFor)

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
