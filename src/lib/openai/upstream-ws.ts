import { randomUUID } from "node:crypto"

import type { CreateUpstreamWsConnectionOptions, UpstreamWsConnection } from "./upstream-ws-connection"

import { createUpstreamWsConnection } from "./upstream-ws-connection"

const MAX_CONSECUTIVE_WS_FALLBACKS = 3
let connectionFactory: (opts: CreateUpstreamWsConnectionOptions) => UpstreamWsConnection = createUpstreamWsConnection

export interface UpstreamWsManager {
  findReusable(opts: { previousResponseId: string; model: string }): UpstreamWsConnection | undefined
  create(opts: { headers: Record<string, string>; model: string }): Promise<UpstreamWsConnection>
  stopNew(): void
  closeAll(): void
  resetRuntimeState(): void
  recordSuccessfulStart(): void
  recordFallback(): void
  readonly activeCount: number
  readonly consecutiveFallbacks: number
  readonly temporarilyDisabled: boolean
  readonly stopped: boolean
}

export function createUpstreamWsManager(): UpstreamWsManager {
  const connections = new Map<string, UpstreamWsConnection>()
  let stopped = false
  let consecutiveFallbacks = 0
  let temporarilyDisabled = false

  return {
    findReusable({ previousResponseId, model }) {
      if (stopped || temporarilyDisabled) return undefined

      for (const connection of connections.values()) {
        if (!connection.isOpen) continue
        if (connection.isBusy) continue
        if (connection.statefulMarker !== previousResponseId) continue
        if (connection.model !== model) continue
        return connection
      }

      return undefined
    },

    create({ headers, model }) {
      if (stopped) throw new Error("Upstream WebSocket manager is not accepting new work")

      const key = randomUUID()
      const connection = connectionFactory({
        headers,
        model,
        onClose: () => {
          connections.delete(key)
        },
      })
      connections.set(key, connection)
      return Promise.resolve(connection)
    },

    stopNew() {
      stopped = true
    },

    closeAll() {
      for (const connection of connections.values()) {
        connection.close()
      }
      connections.clear()
    },

    resetRuntimeState() {
      stopped = false
      consecutiveFallbacks = 0
      temporarilyDisabled = false
      this.closeAll()
    },

    recordSuccessfulStart() {
      consecutiveFallbacks = 0
      temporarilyDisabled = false
    },

    recordFallback() {
      consecutiveFallbacks += 1
      if (consecutiveFallbacks >= MAX_CONSECUTIVE_WS_FALLBACKS) {
        temporarilyDisabled = true
      }
    },

    get activeCount() {
      let count = 0
      for (const connection of connections.values()) {
        if (connection.isOpen) count += 1
      }
      return count
    },

    get consecutiveFallbacks() {
      return consecutiveFallbacks
    },

    get temporarilyDisabled() {
      return temporarilyDisabled
    },

    get stopped() {
      return stopped
    },
  }
}

let manager: UpstreamWsManager | null = null

export function getUpstreamWsManager(): UpstreamWsManager {
  manager ??= createUpstreamWsManager()
  return manager
}

export function peekUpstreamWsManager(): UpstreamWsManager | null {
  return manager
}

export function resetUpstreamWsManagerForTests(): UpstreamWsManager {
  manager?.closeAll()
  manager = createUpstreamWsManager()
  return manager
}

export function setUpstreamWsConnectionFactoryForTests(
  factory: ((opts: CreateUpstreamWsConnectionOptions) => UpstreamWsConnection) | null,
): void {
  connectionFactory = factory ?? createUpstreamWsConnection
}
