/**
 * Mock server for shutdown tests.
 */

import { mock } from "bun:test"

export function createMockServer() {
  return {
    close: mock(async (_force?: boolean) => {}),
  }
}
