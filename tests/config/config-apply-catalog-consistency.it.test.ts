/**
 * `applyConfigToState()` 失败时，**已经落地的那部分状态必须自洽**。
 *
 * 这个不变量在 state 降为 foundation 叶子那轮差点被拆掉：原本 `setDisabledModels()` 自己带重新过滤，
 * 拆分后（为了让 `state` 不必 import models 域）变成「在 `disabled_models` 分支更新列表、在函数末尾
 * 才重新推导视图」，中间隔着三个 generation 校验 `throw`。于是一份 generation 段非法的配置会留下
 * `state.disabledModels` 点名了某个模型、而 `state.models` 仍在提供它——**过滤策略与被它过滤的目录互相打架**。
 *
 * 部分应用本身不是这里的靶子（那是 `applyConfigToState` 早已存在的形状，见
 * docs/todo/deferred-backlog.md 的「config apply 不是两阶段」）。这里钉的是更弱但更要命的一条：
 * 无论在哪一步失败，**目录视图与禁用列表必须互相一致**。
 */

import {
  //
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import {
  //
  applyConfigToState,
  resetApplyState,
  resetConfigCache,
  setBundledConfigForTests,
} from "~/lib/config/config"
import { PATHS } from "~/lib/config/paths"
import {
  //
  resetRawModelsForTests,
  setModels,
} from "~/lib/models/cache"
import {
  //
  resetConfigManagedState,
  restoreStateForTests,
  snapshotStateForTests,
  state,
} from "~/lib/state"

import { mockModel } from "../helpers/factories"

let tmpDir: string
let savedAppDir: string
let savedConfigYaml: string
let originalState = snapshotStateForTests()

beforeEach(async () => {
  originalState = snapshotStateForTests()
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "config-apply-atomicity-"))
  savedAppDir = PATHS.APP_DIR
  savedConfigYaml = PATHS.CONFIG_YAML
  ;(PATHS as { APP_DIR: string }).APP_DIR = tmpDir
  ;(PATHS as { CONFIG_YAML: string }).CONFIG_YAML = path.join(tmpDir, "config.yaml")
  resetConfigCache()
  resetApplyState()
  setBundledConfigForTests({})
})

afterEach(async () => {
  restoreStateForTests(originalState)
  resetRawModelsForTests()
  ;(PATHS as { APP_DIR: string }).APP_DIR = savedAppDir
  ;(PATHS as { CONFIG_YAML: string }).CONFIG_YAML = savedConfigYaml
  await fs.rm(tmpDir, { recursive: true, force: true })
  resetConfigCache()
  resetApplyState()
  setBundledConfigForTests(null)
})

const servedIds = (): Array<string> => (state.models?.data ?? []).map((model) => model.id)

/** `disabled_models` 先于 generation 校验被应用；generation 段刻意写成非法的。 */
const CONFIG_THAT_THROWS_AFTER_DISABLING = `
disabled_models:
  - model-a
generation:
  max_active_candidates: 5
  max_total_candidates: 1
`

describe("applyConfigToState 失败时的目录一致性", () => {
  beforeEach(() => {
    setModels({ object: "list", data: [mockModel("model-a"), mockModel("model-b")] })
  })

  test("前提自证：这份配置确实会抛，且抛在 disabled_models 之后", async () => {
    // 没有这条，下面那条测试「视图一致」可能只是因为根本没抛、或者压根没走到 disabled_models。
    await writeConfig(CONFIG_THAT_THROWS_AFTER_DISABLING)
    await expect(applyConfigToState()).rejects.toThrow(/max_total_candidates must be >= /)
    expect(state.disabledModels, "禁用列表必须已经落地，否则这个测试没有测到那个窗口").toEqual(["model-a"])
  })

  test("校验抛错后，被禁用的模型不得仍留在可用目录里", async () => {
    await writeConfig(CONFIG_THAT_THROWS_AFTER_DISABLING)
    await expect(applyConfigToState()).rejects.toThrow()

    expect(servedIds(), "model-a 已被标记禁用，就不能还出现在 state.models 里").toEqual(["model-b"])
    expect(state.modelIds, "索引是从过滤后的视图重建的，同样不该含它").not.toContain("model-a")
  })

  test("正控：配置合法时同样过滤（否则上面的绿可能来自「什么都没应用」）", async () => {
    await writeConfig("disabled_models:\n  - model-a\n")
    await applyConfigToState()

    expect(state.disabledModels).toEqual(["model-a"])
    expect(servedIds()).toEqual(["model-b"])
  })

  // 另一条路：PUT /api/config 先 resetConfigManagedState()（禁用列表回默认、**不重新过滤**）再调
  // applyConfigToState()。抛错时如果末尾那次重推导没跑，模型就停在「已不再被禁用、却仍不在目录里」——
  // 与上面那条方向相反、同样自相矛盾。所以重推导挂在 finally 上，而不是某个 throw 之前。
  test("reset 之后 apply 抛错：解除禁用的模型必须回到目录（与上一条方向相反的同一个不变量）", async () => {
    await writeConfig("disabled_models:\n  - model-a\n")
    await applyConfigToState()
    expect(servedIds(), "前提：model-a 此刻确实被过滤掉了").toEqual(["model-b"])

    resetConfigCache()
    resetConfigManagedState() // PUT /api/config 的第一步：列表回默认，视图未动
    await writeConfig(CONFIG_THAT_THROWS_AFTER_DISABLING.replace("  - model-a\n", ""))
    await expect(applyConfigToState()).rejects.toThrow()

    expect(state.disabledModels, "已经没有任何模型被禁用").toEqual([])
    expect(servedIds(), "那 model-a 就必须回到目录里——否则它「不被禁用却也不被提供」").toEqual(["model-a", "model-b"])
  })
})

async function writeConfig(content: string): Promise<void> {
  await fs.writeFile(PATHS.CONFIG_YAML, content, "utf8")
}
