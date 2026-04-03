import consola from "consola"

import { state } from "../state"
import { cacheModels } from "./client"

type RefreshModelsFn = () => Promise<void>

let refreshTimer: ReturnType<typeof setTimeout> | null = null
let refreshLoopRunning = false
let refreshIntervalSeconds = state.modelRefreshInterval
let refreshModelsImpl: RefreshModelsFn = cacheModels

function clearRefreshTimer(): void {
  if (refreshTimer) {
    clearTimeout(refreshTimer)
    refreshTimer = null
  }
}

function logRefreshFailure(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  if (state.models?.data.length) {
    consola.warn(`[Models] Periodic refresh failed, keeping cached models: ${message}`)
    return
  }

  consola.error(`[Models] Periodic refresh failed with no cached models: ${message}`)
}

function scheduleNextRefresh(): void {
  clearRefreshTimer()
  if (!refreshLoopRunning || refreshIntervalSeconds <= 0) {
    return
  }

  refreshTimer = setTimeout(() => {
    void refreshModelsImpl()
      .catch(logRefreshFailure)
      .finally(() => {
        scheduleNextRefresh()
      })
  }, refreshIntervalSeconds * 1000)
}

export function startModelRefreshLoop(refreshModels: RefreshModelsFn = cacheModels): () => void {
  refreshLoopRunning = true
  refreshModelsImpl = refreshModels
  refreshIntervalSeconds = state.modelRefreshInterval
  scheduleNextRefresh()

  return () => {
    refreshLoopRunning = false
    clearRefreshTimer()
  }
}

export function syncModelRefreshLoop(intervalSeconds = state.modelRefreshInterval): void {
  refreshIntervalSeconds = intervalSeconds
  if (!refreshLoopRunning) {
    return
  }

  scheduleNextRefresh()
}
