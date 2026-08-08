/**
 * CopilotTokenManager disposal — no timer or async write may outlive dispose().
 *
 * Regression test for the latent leak found in the C3/C4 review: refresh()'s
 * `.then` reschedules unconditionally, so disposing WHILE a refresh is in flight
 * (cancel timer → await in-flight → the resolving .then arms a NEW timer) would
 * leave a live timer holding a manager reference — a classic cross-test flaky
 * pollution source. The fix is a `disposed` guard in scheduleRefresh.
 *
 * Deterministic (no wall-clock timing): asserts on the manager's armed-timer
 * state via `_hasScheduledRefreshForTests()` rather than waiting for a fire.
 */

import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type { GitHubTokenManager } from "~/lib/token/github-token-manager"

import { CopilotTokenManager } from "~/lib/token/copilot-token-manager"

import {
  //
  autoRestoreFetch,
  setFetchMock,
} from "../helpers/mock-fetch"
import { autoRestoreState } from "../helpers/state-fixture"

/** A GitHubTokenManager stand-in — only refresh() is reachable (401 path), unused here. */
const fakeGithubTokenManager = {
  refresh: async () => null,
} as unknown as GitHubTokenManager

function copilotTokenBody(refreshIn = 3600) {
  return JSON.stringify({ token: "copilot-tok", expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_in: refreshIn })
}

describe("CopilotTokenManager.dispose", () => {
  autoRestoreFetch()
  autoRestoreState()

  test("initialize arms a refresh timer", async () => {
    setFetchMock(async () => new Response(copilotTokenBody(), { status: 200, headers: { "content-type": "application/json" } }))
    const mgr = new CopilotTokenManager({ githubTokenManager: fakeGithubTokenManager })

    await mgr.initialize()
    expect(mgr._hasScheduledRefreshForTests()).toBe(true)

    await mgr.dispose()
    expect(mgr._hasScheduledRefreshForTests()).toBe(false)
  })

  test("dispose() during an in-flight refresh leaves NO armed timer (leak guard)", async () => {
    setFetchMock(async () => new Response(copilotTokenBody(), { status: 200, headers: { "content-type": "application/json" } }))
    const mgr = new CopilotTokenManager({ githubTokenManager: fakeGithubTokenManager })

    await mgr.initialize()
    // Start a refresh and, while it is in flight, dispose the manager.
    const refreshP = mgr.refresh()
    const disposeP = mgr.dispose()
    await Promise.all([refreshP, disposeP])

    // The resolving refresh's `.then` calls scheduleRefresh(); the disposed
    // guard must have blocked it. Without the guard this is `true` (leaked timer).
    expect(mgr._hasScheduledRefreshForTests()).toBe(false)
  })

  test("scheduled refresh does not re-arm after dispose", async () => {
    setFetchMock(async () => new Response(copilotTokenBody(), { status: 200, headers: { "content-type": "application/json" } }))
    const mgr = new CopilotTokenManager({ githubTokenManager: fakeGithubTokenManager })

    await mgr.initialize()
    await mgr.dispose()

    // A post-dispose refresh() must not schedule a new timer either.
    await mgr.refresh()
    expect(mgr._hasScheduledRefreshForTests()).toBe(false)
  })
})
