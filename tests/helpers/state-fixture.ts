/**
 * Test fixture for global runtime state isolation.
 *
 * Centralizes the snapshot/restore boilerplate that was previously repeated
 * across many test files: capturing `~/lib/state` at a pristine point and
 * restoring it after every test so mutations via `setStateForTests` don't leak
 * between tests.
 *
 * Mirrors `autoRestoreFetch()` from `./mock-fetch`. Typical usage:
 *
 *   import { autoRestoreState } from "../helpers/state-fixture"
 *
 *   describe("my feature", () => {
 *     autoRestoreState() // snapshot now, restore after each test
 *
 *     test("...", () => {
 *       setStateForTests({ ... })
 *       // assertions; state is rolled back automatically afterwards
 *     })
 *   })
 *
 * For files that need the snapshot value explicitly (e.g. to combine with
 * other cleanup in a single afterEach, or to re-snapshot per test), keep using
 * `snapshotStateForTests()` / `restoreStateForTests()` from `~/lib/state`
 * directly — this helper only covers the common "snapshot once, auto-restore"
 * case.
 */

import { afterEach } from "bun:test"

import {
  //
  restoreStateForTests,
  snapshotStateForTests,
} from "~/lib/state"

/**
 * Snapshot the global runtime state at call time and register an `afterEach`
 * hook that restores it after every test in the current file or describe
 * block. Call once at module or describe scope, before any test mutates state.
 *
 * Replaces the boilerplate:
 *   const originalState = snapshotStateForTests()
 *   afterEach(() => restoreStateForTests(originalState))
 */
export function autoRestoreState(): void {
  const snapshot = snapshotStateForTests()
  afterEach(() => {
    restoreStateForTests(snapshot)
  })
}
