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
} from "@/components/models/model-table-columns"
import { modelStatus } from "@/lib/model-status"

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
