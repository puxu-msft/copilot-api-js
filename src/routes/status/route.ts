/**
 * Aggregated server status endpoint.
 * Returns health, auth, quota, rate limiter, memory, shutdown, and model counts
 * in a single request.
 */

import { Hono } from "hono"

import { getAdaptiveRateLimiter } from "~/lib/adaptive-rate-limiter"
import { getRequestContextManager } from "~/lib/context/manager"
import { getMemoryPressureStats } from "~/lib/history/memory-pressure"
import { historyState } from "~/lib/history/store"
import { peekUpstreamWsManager } from "~/lib/openai/upstream-ws"
import { getRequestTelemetrySnapshot } from "~/lib/request-telemetry"
import { getIsShuttingDown, getShutdownPhase } from "~/lib/shutdown"
import { serverStartTime, state } from "~/lib/state"
import { getCopilotUsage, type QuotaDetail } from "~/lib/token/copilot-client"

import packageJson from "../../../package.json"

export const statusRoutes = new Hono()

statusRoutes.get("/", async (c) => {
  const now = Date.now()

  // Rate limiter status + config
  const limiter = getAdaptiveRateLimiter()
  const limiterStatus = limiter?.getStatus()
  let serverStatus: "healthy" | "unhealthy" | "shutting_down"
  if (getIsShuttingDown()) {
    serverStatus = "shutting_down"
  } else if (state.copilotToken && state.githubToken) {
    serverStatus = "healthy"
  } else {
    serverStatus = "unhealthy"
  }
  const rateLimiter =
    limiter && limiterStatus ?
      {
        enabled: true,
        ...limiterStatus,
        config: limiter.getConfig(),
      }
    : { enabled: false }

  // Memory pressure
  const memStats = getMemoryPressureStats()
  const requestTelemetry = getRequestTelemetrySnapshot(now)
  const upstreamWs = peekUpstreamWsManager()

  // Active request count (safe — returns 0 if manager not initialized)
  let activeCount = 0
  try {
    activeCount = getRequestContextManager().activeCount
  } catch {
    // Manager not initialized yet
  }

  // Copilot quota (non-blocking — null on failure)
  let quota: {
    plan: string
    resetDate: string
    chat: QuotaDetail
    completions: QuotaDetail
    premiumInteractions: QuotaDetail
  } | null = null
  try {
    const usage = await getCopilotUsage()
    quota = {
      plan: usage.copilot_plan,
      resetDate: usage.quota_reset_date,
      chat: usage.quota_snapshots.chat,
      completions: usage.quota_snapshots.completions,
      premiumInteractions: usage.quota_snapshots.premium_interactions,
    }
  } catch {
    // Quota query failed — return null, don't block the entire status response
  }

  return c.json({
    status: serverStatus,
    uptime: serverStartTime > 0 ? Math.floor((now - serverStartTime) / 1000) : 0,
    version: packageJson.version,
    vsCodeVersion: state.vsCodeVersion ?? null,

    auth: {
      accountType: state.accountType,
      tokenSource: state.tokenInfo?.source ?? null,
      tokenExpiresAt: state.tokenInfo?.expiresAt ?? null,
      copilotTokenExpiresAt: state.copilotTokenInfo ? state.copilotTokenInfo.expiresAt * 1000 : null,
    },

    quota,

    activeRequests: {
      count: activeCount,
    },

    rateLimiter,

    requestTelemetry,

    memory: {
      heapUsedMB: memStats.heapUsedMB,
      heapLimitMB: memStats.heapLimitMB,
      historyEntryCount: historyState.entries.length,
      historyMaxEntries: memStats.currentMaxEntries,
      totalEvictedCount: memStats.totalEvictedCount,
    },

    shutdown: {
      phase: getShutdownPhase(),
    },

    models: {
      totalCount: state.models?.data.length ?? 0,
      availableCount: state.modelIds.size,
    },

    upstream_websocket: {
      enabled: state.upstreamWebSocket,
      active_connections: upstreamWs?.activeCount ?? 0,
      consecutive_fallbacks: upstreamWs?.consecutiveFallbacks ?? 0,
      temporarily_disabled: upstreamWs?.temporarilyDisabled ?? false,
    },
  })
})
