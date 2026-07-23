/**
 * Forward cross-test isolation of the token credential store.
 *
 * C5 moved githubToken / copilotToken / tokenInfo / copilotTokenInfo out of core
 * `state` into `~/lib/token`'s store, and folded the store's snapshot/restore
 * into `snapshotStateForTests` / `restoreStateForTests` so the standard per-test
 * fixture isolates credentials with zero extra wiring. These tests prove that:
 * test A writes all four credentials via the compat `setStateForTests` shim, and
 * test B (running after A in file order) sees a pristine store — the fixture's
 * afterEach restore rolled A's writes back.
 */

import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import { setStateForTests } from "~/lib/state"
import { getTokenCredentials } from "~/lib/token"

import { useIsolatedRuntime } from "../helpers/isolated-fixture"

describe("token credential store — cross-test isolation", () => {
  useIsolatedRuntime()

  test("A: writes all four credentials via setStateForTests", () => {
    setStateForTests({
      githubToken: "gh-A",
      copilotToken: "cop-A",
      tokenInfo: { token: "gh-A", source: "cli", refreshable: false },
      copilotTokenInfo: { token: "cop-A", expiresAt: 123, refreshIn: 45, raw: {} },
    })

    const c = getTokenCredentials()
    expect(c.githubToken).toBe("gh-A")
    expect(c.copilotToken).toBe("cop-A")
    expect(c.tokenInfo?.source).toBe("cli")
    expect(c.copilotTokenInfo?.expiresAt).toBe(123)
  })

  test("B: sees a pristine store (A's writes were restored by the fixture)", () => {
    const c = getTokenCredentials()
    expect(c.githubToken).toBeUndefined()
    expect(c.copilotToken).toBeUndefined()
    expect(c.tokenInfo).toBeUndefined()
    expect(c.copilotTokenInfo).toBeUndefined()
  })

  test("C: forwarding only touches the keys present in the patch", () => {
    setStateForTests({ copilotToken: "only-copilot" })
    const c = getTokenCredentials()
    expect(c.copilotToken).toBe("only-copilot")
    expect(c.githubToken).toBeUndefined()
    expect(c.tokenInfo).toBeUndefined()
  })
})
