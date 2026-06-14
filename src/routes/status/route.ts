/**
 * Aggregated server status endpoint.
 * Returns health, auth, quota, rate limiter, memory, shutdown, and model counts
 * in a single request.
 */

import { Hono } from "hono"

import { getAdaptiveRateLimiter } from "~/lib/adaptive-rate-limiter"
import { getRequestContextManager } from "~/lib/context/manager"
import { queryEntryCount } from "~/lib/history/sqlite/read"
import { listInFlightEntries } from "~/lib/history/store"
import { peekUpstreamWsManager } from "~/lib/openai/upstream-ws"
import { getRequestTelemetrySnapshot } from "~/lib/request-telemetry"
import {
  //
  getIsShuttingDown,
  getShutdownPhase,
} from "~/lib/shutdown"
import {
  //
  serverStartTime,
  state,
} from "~/lib/state"
import {
  //
  getCopilotUsage,
  type QuotaDetail,
} from "~/lib/token/copilot-client"

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

  // History backend stats
  const requestTelemetry = getRequestTelemetrySnapshot(now)
  const upstreamWs = peekUpstreamWsManager()

  let historyEntryCount = 0
  try {
    historyEntryCount = queryEntryCount()
  } catch {
    // DB not opened yet
  }
  const inFlightCount = listInFlightEntries().length

  // Active request count (safe — returns 0 if manager not initialized)
  let activeCount = 0
  try {
    activeCount = getRequestContextManager().activeCount
  } catch {
    // Manager not initialized yet
  }

  // Copilot quota — distinguish "fetch failed" from "account has no buckets".
  //
  // Shape:
  //   { status: "ok",      plan, resetDate, chat?, completions?, premiumInteractions? }
  //   { status: "no_data", plan }            // account exposes no quota_snapshots
  //   { status: "error",   error: string }   // network / auth / 5xx
  //
  // Per-bucket fields are individually optional because GHC may omit any
  // subset for free / expired / pre-provisioned accounts.
  type QuotaPayload =
    | {
        status: "ok"
        plan: string
        resetDate: string | null
        chat?: QuotaDetail
        completions?: QuotaDetail
        premiumInteractions?: QuotaDetail
      }
    | { status: "no_data"; plan: string }
    | { status: "error"; error: string }

  let quota: QuotaPayload
  try {
    const usage = await getCopilotUsage()
    const snapshots = usage.quota_snapshots
    if (!snapshots) {
      quota = { status: "no_data", plan: usage.copilot_plan }
    } else {
      quota = {
        status: "ok",
        plan: usage.copilot_plan,
        resetDate: usage.quota_reset_date ?? null,
        ...(snapshots.chat && { chat: snapshots.chat }),
        ...(snapshots.completions && { completions: snapshots.completions }),
        // Prefer `premium_models` (newer bucket) over `premium_interactions`,
        // matching upstream chatQuotaServiceImpl behavior.
        ...((snapshots.premium_models ?? snapshots.premium_interactions) && {
          premiumInteractions: snapshots.premium_models ?? snapshots.premium_interactions,
        }),
      }
    }
  } catch (error) {
    quota = {
      status: "error",
      error: error instanceof Error ? error.message : String(error),
    }
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
      historyBackend: "sqlite",
      historyEntryCount,
      historySuccessLimit: state.historySuccessLimit,
      historyFailureLimit: state.historyFailureLimit,
      inFlightCount,
    },

    shutdown: {
      phase: getShutdownPhase(),
    },

    models: {
      totalCount: state.models?.data.length ?? 0,
      availableCount: state.modelIds.size,
    },

    upstream_ws: {
      enabled: state.upstreamWebSocket,
      active_connections: upstreamWs?.activeCount ?? 0,
      consecutive_fallbacks: upstreamWs?.consecutiveFallbacks ?? 0,
      temporarily_disabled: upstreamWs?.temporarilyDisabled ?? false,
      // Absolute deadline (epoch ms) for half-open recovery; 0 when not disabled.
      // Operators can derive "recovers in N seconds" client-side instead of us
      // hardcoding the recovery window in the response shape.
      disabled_until_ms: upstreamWs?.disabledUntilMs ?? 0,
    },
  })
})
