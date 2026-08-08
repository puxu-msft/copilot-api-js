/**
 * Aggregated server status endpoint.
 * Returns health, auth, quota, rate limiter, memory, shutdown, and model counts
 * in a single request.
 */

import {
  //
  createRoute,
  OpenAPIHono,
  z,
} from "@hono/zod-openapi"
import { getTelemetryRuntime } from "@hsupu/ghc-proxy-telemetry"

import { getAdaptiveRateLimiter } from "~/lib/adaptive-rate-limiter"
import {
  //
  getProtectStreamingStats,
  protectStreamingHitRate,
} from "~/lib/anthropic/protect-streaming-stats"
import { getToolInputRepairStats } from "~/lib/anthropic/tool-input-repair-stats"
import { PATHS } from "~/lib/config/paths"
import { getRequestContextManager } from "~/lib/context/manager"
import { listHistoryOverlaySummaries } from "~/lib/history/overlay"
import { getRawCaptureStatus } from "~/lib/history/raw/manager"
import { pingHistorySearchUdsClient } from "~/lib/history/search/uds-client"
import { getHistorySearchClient } from "~/lib/history/state"
import { listInFlightEntries } from "~/lib/history/store"
import {
  //
  countV3StoredOperationsExcluding,
  getV3StoreStatus,
} from "~/lib/history/v3/store"
import { getHistoryPersistenceStatus } from "~/lib/history/worker/status"
import { peekUpstreamWsManager } from "~/lib/openai/upstream-ws"
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
import { getTokenCredentials } from "~/lib/token"
import {
  //
  getCopilotUsage,
  type QuotaDetail,
} from "~/lib/token/copilot-client"
import { getTransportStatusSnapshot } from "~/lib/transport/status-snapshot"

import packageJson from "../../../package.json"

export const statusRoutes = new OpenAPIHono()

/**
 * Aggregated server status. Top-level keys are documented; the nested objects
 * (auth / quota / rateLimiter / requestTelemetry / memory / upstream_ws /
 * transport / protect_streaming) carry runtime-dynamic, evolving shapes and
 * are described as open objects to avoid schema drift — see the handler /
 * DESIGN.md for fields.
 */
const ServerStatusSchema = z
  .object({
    status: z.string().openapi({ description: "healthy | unhealthy | shutting_down" }),
    uptime: z.number().openapi({ description: "Seconds since server start" }),
    version: z.string(),
    vsCodeVersion: z.string().nullable(),
    auth: z.record(z.string(), z.unknown()),
    quota: z.record(z.string(), z.unknown()).openapi({ description: "Copilot quota: { status: ok | no_data | error, ... }" }),
    activeRequests: z.object({ count: z.number().int() }),
    rateLimiter: z.record(z.string(), z.unknown()),
    requestTelemetry: z.record(z.string(), z.unknown()),
    memory: z.record(z.string(), z.unknown()),
    shutdown: z.object({ phase: z.unknown() }),
    models: z.object({ totalCount: z.number().int(), availableCount: z.number().int() }),
    upstream_ws: z.record(z.string(), z.unknown()),
    transport: z.record(z.string(), z.unknown()),
    responses: z.record(z.string(), z.unknown()),
    protect_streaming: z.record(z.string(), z.unknown()),
    tool_input_repair: z.record(z.string(), z.unknown()),
    thinking_blocks: z.record(z.string(), z.unknown()),
    history_raw_capture: z.record(z.string(), z.unknown()),
    history_search: z.record(z.string(), z.unknown()),
    history_persistence: z.record(z.string(), z.unknown()),
  })
  .openapi("ServerStatus")

const getStatusRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["status"],
  summary: "Aggregated server status",
  description:
    "Health, auth, Copilot quota, rate limiter, request telemetry, memory, shutdown phase, model counts, upstream-WS and L2 protect-streaming stats.",
  responses: {
    200: { description: "Server status", content: { "application/json": { schema: ServerStatusSchema } } },
  },
})

statusRoutes.openapi(getStatusRoute, async (c) => {
  const now = Date.now()
  const credentials = getTokenCredentials()

  // Rate limiter status + config
  const limiter = getAdaptiveRateLimiter()
  const limiterStatus = limiter?.getStatus()
  let serverStatus: "healthy" | "unhealthy" | "shutting_down"
  if (getIsShuttingDown()) {
    serverStatus = "shutting_down"
  } else if (credentials.copilotToken && credentials.githubToken) {
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
  const requestTelemetry = getTelemetryRuntime().getSnapshot(now)
  const upstreamWs = peekUpstreamWsManager()

  let historyEntryCount = 0
  let summaryProjection = { ready: false, pending: 0, poisoned: 0 }
  try {
    const overlayOperationIds = listHistoryOverlaySummaries().map((summary) => summary.id)
    historyEntryCount = overlayOperationIds.length + countV3StoredOperationsExcluding(overlayOperationIds)
    const historyStatus = getV3StoreStatus()
    summaryProjection = {
      ready: historyStatus.summaryProjectionReady,
      pending: historyStatus.summaryProjectionPending,
      poisoned: historyStatus.summaryProjectionPoisoned,
    }
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

  return c.json(
    {
      status: serverStatus,
      uptime: serverStartTime > 0 ? Math.floor((now - serverStartTime) / 1000) : 0,
      version: packageJson.version,
      vsCodeVersion: state.vsCodeVersion ?? null,

      auth: {
        accountType: state.accountType,
        tokenSource: credentials.tokenInfo?.source ?? null,
        tokenExpiresAt: credentials.tokenInfo?.expiresAt ?? null,
        copilotTokenExpiresAt: credentials.copilotTokenInfo ? credentials.copilotTokenInfo.expiresAt * 1000 : null,
      },

      quota,

      activeRequests: {
        count: activeCount,
      },

      rateLimiter,

      requestTelemetry,

      history_raw_capture: getRawCaptureStatus(),
      history_persistence: (() => {
        const snapshot = getHistoryPersistenceStatus()
        return { ...snapshot, unackedMessageIds: [...snapshot.unackedMessageIds] }
      })(),
      history_search: await (async () => {
        const client = getHistorySearchClient()
        if (!client) return { enabled: false }
        // The main process has NO visibility into the sidecar's lifecycle (it is an
        // independently-started, systemd-managed service, not something this process
        // spawns/supervises — history-search-out-of-process plan Phase 3′) — the ONLY
        // honest thing to report is "can we currently reach it", derived from an
        // actual lightweight probe, never a persisted alive/pid/abandoned view of a
        // process this side does not own.
        const ping = await pingHistorySearchUdsClient(PATHS.HISTORY_SEARCH_SOCKET)
        // Tail-progress status (merged-state review blocker 3, 2026-07-22): the ping
        // above hits the native short-circuit and answers instantly regardless of
        // whether the tail loop is actually making progress — a sidecar wedged on a
        // round-level infra fault would still report `reachable: true` forever with
        // NOTHING else to distinguish "search index has silently stopped growing"
        // from "search index is healthy". Only attempted when reachable (a second
        // round-trip against an already-unreachable sidecar would just fail the same
        // way and add nothing — never-blocking: `getTailStatus()`'s own rejection is
        // caught below rather than propagated, since a status-poll failure here must
        // never turn a routine `/api/status` request into a 500).
        if (!ping.reachable) return { enabled: true, ...ping }
        try {
          const tail = await client.getTailStatus()
          return { enabled: true, ...ping, tail }
        } catch (error) {
          return { enabled: true, ...ping, tailError: error instanceof Error ? error.message : String(error) }
        }
      })(),

      memory: {
        historyBackend: "sqlite",
        historyEntryCount,
        inFlightCount,
        summaryProjectionReady: summaryProjection.ready,
        summaryProjectionPending: summaryProjection.pending,
        summaryProjectionPoisoned: summaryProjection.poisoned,
      },

      shutdown: {
        phase: getShutdownPhase(),
      },

      models: {
        totalCount: state.models?.data.length ?? 0,
        availableCount: state.modelIds.size,
      },

      upstream_ws: (() => {
        // Per-model circuit breaker: expose the full per-model rows (only models
        // with a live entry appear) + a top-level aggregate rollup so existing
        // summary consumers keep a scalar view (any-disabled / max-fallbacks /
        // latest-recovery) without needing per-model logic. richest-data-flow.
        const perModel = upstreamWs?.breakerSnapshot() ?? []
        return {
          enabled: state.upstreamWebSocket,
          active_connections: upstreamWs?.activeCount ?? 0,
          per_model: perModel,
          // Aggregate rollup across all per-model breaker rows.
          consecutive_fallbacks: perModel.reduce((max, r) => Math.max(max, r.consecutiveFallbacks), 0),
          temporarily_disabled: perModel.some((r) => r.temporarilyDisabled),
          // Latest half-open recovery deadline (epoch ms) across models; 0 when none disabled.
          // Operators derive "recovers in N seconds" client-side.
          disabled_until_ms: perModel.reduce((latest, r) => Math.max(latest, r.disabledUntilMs), 0),
        }
      })(),

      // Responses (SSE/HTTP) path toggles. `buffered_retry` (opt-in `responsesBufferedRetry`)
      // routes the pump through the driver's `runResponseBufferedSink` for mid-stream upstream-drop
      // retry (default OFF — Codex mid-stream auto-retry is opt-in). Its hit-rate counters share the
      // `protect_streaming` block below (the same driver primitive drives both endpoints).
      responses: {
        buffered_retry: state.responsesBufferedRetry,
      },

      // L2 buffered-retry hit-rate counters (RFC §10): since-restart aggregate, keyed PER VENDOR
      // (anthropic / responses / chat_completions / responses_ws — the same driver primitive drives
      // every endpoint). Each vendor bucket carries the raw counters plus a derived `hit_rate`
      // (success / (success + exhausted + partialDegrade); null when no scoreable engagements yet).
      protect_streaming: {
        enabled: state.protectStreamingGeneration,
        by_vendor: Object.fromEntries(
          Object.entries(getProtectStreamingStats()).map(([vendor, s]) => [vendor, { ...s, hit_rate: protectStreamingHitRate(s) }]),
        ),
      },

      // Malformed tool-input repair outcome counters (P6): since-restart aggregate
      // (strip = tags-item fixes, jsonrepair = jsonrepair-item fixes, unrepairable = no item fixed).
      // `enabled` is the active repair-item set (empty = off).
      tool_input_repair: {
        enabled: [...state.toolRepairMalformedInput],
        ...getToolInputRepairStats(),
      },

      // Thinking-block emptiness totals since restart — a PROJECTION of the telemetry
      // measures (summed across the agentKind dimension), NOT a separate counter like
      // protect_streaming / tool_input_repair. { nonEmpty, emptySigned, emptyUnsigned }.
      thinking_blocks: getTelemetryRuntime().getThinkingBlockTotals(),

      // Upstream transport diagnostics (D7 HIGH-7): configured effective values
      // (normalized 0/undefined → null), h2 session pool + hot-reload reconcile
      // status, upstream WS connection pool, and runtime capability flags. See
      // src/lib/transport/status-snapshot.ts for the full shape — deliberately
      // NOT collapsed to a single generation scalar (spec explicitly forbids
      // that as a "form-only" implementation).
      transport: getTransportStatusSnapshot(),
    },
    200,
  )
})
