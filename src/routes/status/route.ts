/**
 * Aggregated server status endpoint.
 * Returns health, auth, quota, rate limiter, memory, shutdown, and model counts
 * in a single request.
 */

import { Hono } from "hono"

import packageJson from "../../../package.json"
import { getAdaptiveRateLimiter } from "~/lib/adaptive-rate-limiter"
import { getRequestContextManager } from "~/lib/context/manager"
import { historyState } from "~/lib/history/store"
import { getMemoryPressureStats } from "~/lib/history/memory-pressure"
import { getIsShuttingDown, getShutdownPhase } from "~/lib/shutdown"
import { serverStartTime, state } from "~/lib/state"
import { getCopilotUsage, type QuotaDetail } from "~/lib/token/copilot-client"

export const statusRoutes = new Hono()

statusRoutes.get("/", async (c) => {
  const now = Date.now()

  // Rate limiter status + config
  const limiter = getAdaptiveRateLimiter()
  const limiterStatus = limiter?.getStatus()

  // Memory pressure
  const memStats = getMemoryPressureStats()

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
    status: getIsShuttingDown() ? "shutting_down" : (state.copilotToken && state.githubToken ? "healthy" : "unhealthy"),
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

    rateLimiter: limiterStatus
      ? {
          enabled: true,
          ...limiterStatus,
          config: limiter!.getConfig(),
        }
      : { enabled: false },

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
  })
})
