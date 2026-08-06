import type { HistorySearchUdsClient } from "./uds-client"

/**
 * Process-local reference to the stateless UDS client.
 *
 * Lifecycle orchestration installs and clears it; read paths depend only on this
 * narrow registry instead of importing the History lifecycle module back into
 * the query graph.
 */
let client: HistorySearchUdsClient | undefined

export function getHistorySearchClient(): HistorySearchUdsClient | undefined {
  return client
}

export function setHistorySearchClient(next: HistorySearchUdsClient | undefined): void {
  client = next
}
