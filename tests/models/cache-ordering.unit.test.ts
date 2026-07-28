/**
 * The model catalog cache: ORDERING and the re-derive seam.
 *
 * S2 moved this logic out of `state.ts` into the models domain
 * (docs/plan/2026-07-28-state-to-foundation/HANDOVER.md). Two things about that move are invisible
 * to typecheck and to every existing test, so they are pinned here:
 *
 *  1. `setModels` has ORDERED side effects — cache raw, publish the filtered view, THEN rebuild the
 *     indexes from that view. Rebuilding before filtering indexes entries the operator disabled, and
 *     nothing else in the suite would notice: `state.models` would still be correct.
 *  2. The re-filter is no longer triggered by `state` itself. `setDisabledModels` is now a plain
 *     field setter and `refreshCatalogView()` is a separate call the CONFIG layer makes, because
 *     `state.resetConfigManagedState()` resets the disabled list and having `state` call into the
 *     models domain to re-filter would close the two-node cycle this migration exists to remove.
 *     That seam is the one thing that can silently rot: forget the call and the catalog view simply
 *     keeps the previous filtering, which looks fine until an operator removes a `disabled_models`
 *     entry and it stays disabled.
 */

import {
  //
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test"

import type {
  //
  Model,
  ModelsResponse,
} from "~/lib/models/client"

import {
  //
  getConfigDisabledIds,
  getRawModels,
  refreshCatalogView,
  resetRawModelsForTests,
  setModels,
} from "~/lib/models/cache"
import {
  //
  setDisabledModels,
  state,
} from "~/lib/state"

const model = (id: string): Model => ({ id, object: "model" }) as unknown as Model
const catalog = (...ids: Array<string>): ModelsResponse => ({ object: "list", data: ids.map(model) })

beforeEach(() => {
  resetRawModelsForTests()
  setDisabledModels([])
  setModels(undefined)
})

describe("models/cache", () => {
  test("setModels 过滤后才建索引（顺序错了 state.models 仍然正确、只有索引会多出被禁模型）", () => {
    setDisabledModels(["gpt-5"])
    setModels(catalog("claude-opus-4.8", "gpt-5"))

    expect(state.models?.data.map((m) => m.id)).toEqual(["claude-opus-4.8"])
    // 承重断言：索引必须来自过滤后的视图，而不是原始目录。
    expect([...state.modelIds]).toEqual(["claude-opus-4.8"])
    expect(state.modelIndex.has("gpt-5")).toBe(false)
  })

  test("索引是本次派生的，不是上一次的残留", () => {
    setModels(catalog("a", "b"))
    setModels(catalog("c"))
    expect([...state.modelIds]).toEqual(["c"])
    expect(state.modelIndex.get("c")?.id).toBe("c")
  })

  test("归一化匹配：配置写 claude-opus-4-8 能禁掉目录里的 claude-opus-4.8", () => {
    setDisabledModels(["claude-opus-4-8"])
    setModels(catalog("claude-opus-4.8", "gpt-5"))
    expect(state.models?.data.map((m) => m.id)).toEqual(["gpt-5"])
    // 同一条匹配规则也要驱动 /api/models 的标注，否则两处会各自漂移。
    expect(getConfigDisabledIds()).toEqual(["claude-opus-4.8"])
  })

  test("原始目录保留被禁条目（重新过滤不需要再打一次上游）", () => {
    setModels(catalog("a", "b"))
    setDisabledModels(["a"])
    refreshCatalogView()

    expect(getRawModels()?.data.map((m) => m.id)).toEqual(["a", "b"])
    expect(state.models?.data.map((m) => m.id)).toEqual(["b"])
  })

  test("改了禁用列表但没调 refreshCatalogView，视图就是陈旧的——这正是 config 层那次调用在防的事", () => {
    setModels(catalog("a", "b"))
    setDisabledModels(["a"])
    // 还没 refresh：视图仍是上一次过滤的结果。
    expect(state.models?.data.map((m) => m.id)).toEqual(["a", "b"])

    refreshCatalogView()
    expect(state.models?.data.map((m) => m.id)).toEqual(["b"])

    // 反向也要成立：清空禁用列表后必须把模型放回来（PUT /api/config 的 reset 路径走的就是这条）。
    setDisabledModels([])
    refreshCatalogView()
    expect(state.models?.data.map((m) => m.id)).toEqual(["a", "b"])
  })

  test("refreshCatalogView 在没有目录时是安全的空操作", () => {
    setDisabledModels(["a"])
    refreshCatalogView()
    expect(state.models).toBeUndefined()
    expect([...state.modelIds]).toEqual([])
    expect(getConfigDisabledIds()).toEqual([])
  })
})
