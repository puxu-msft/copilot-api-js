/**
 * Aggregates every D7 HIGH-7 transport diagnostic surface into one pure,
 * synchronous read consumed by `/api/status` (see routes/status/route.ts).
 * No caching, no subscriptions — called fresh on every status request, same
 * as every other field on that route.
 */

import type {
  //
  UpstreamWsReconcileStatus,
  UpstreamWsStatusRow,
} from "~/lib/openai/upstream-ws"

import {
  //
  getPooledConnectionIdleTimeoutMs,
  getUpstreamWsReconcileStatus,
  getUpstreamWsStatusSnapshot,
  peekUpstreamWsManager,
} from "~/lib/openai/upstream-ws"
import {
  //
  getUpstreamH2PingIntervalMs,
  getUpstreamKeepAliveDelayMs,
} from "~/lib/proxy"
import { state } from "~/lib/state"

import type { H2SessionStatusRow } from "./http2-client"

import {
  //
  getH2ReconcileStatus,
  getH2SessionStatusSnapshot,
  getSessionConnectTimeoutMs,
} from "./http2-client"

/**
 * Effective configured transport values, normalized at THIS presentation
 * boundary to a single "disabled/uncapped" spelling (`null`). The getters
 * this reads from do NOT agree with each other: `getUpstreamKeepAliveDelayMs()`
 * returns `undefined` for disabled, `getUpstreamH2PingIntervalMs()` /
 * `getSessionConnectTimeoutMs()` / `getPooledConnectionIdleTimeoutMs()` return
 * `0`, and `state.softMaxUpstreamWsConnections` uses `0` for "uncapped". None
 * of those functions change — this module only normalizes its OWN output so a
 * diagnostics consumer never has to remember five different spellings of "off".
 */
export interface TransportConfiguredValues {
  /** `null` = TCP keepalive disabled. */
  tcpKeepaliveProbeDelayMs: number | null
  /** `null` = application-layer h2 PING keepalive disabled. */
  h2PingIntervalMs: number | null
  /** `null` = no application-configured h2 connect deadline. */
  sessionConnectTimeoutMs: number | null
  /** `null` = pooled upstream WS connections never idle-timeout. */
  pooledConnectionIdleTimeoutMs: number | null
  /** `null` = no soft cap on simultaneous upstream WS connections. */
  softMaxUpstreamWsConnections: number | null
}

/**
 * Runtime-level capability flags — NOT configuration. `wsApplicationKeepalive`
 * is currently always `"unavailable"`: decision D4 — no cross-runtime,
 * empirically-verified upstream WS keepalive primitive exists yet, so there
 * is deliberately no config knob for it (see schema comment in P1 and ADR
 * 2026-07-14-transport-config-three-axis-organization.md). This field lets a
 * diagnostics consumer tell "off because you configured it off" apart from
 * "cannot exist in this runtime at all". If a future runtime gains a verified
 * primitive, this becomes a real union instead of a fixed literal.
 */
export interface TransportRuntimeCapability {
  runtime: "bun" | "node"
  wsApplicationKeepalive: "unavailable"
}

export interface TransportStatusSnapshot {
  configured: TransportConfiguredValues
  // NOTE: mutable `Array<T>`, not `ReadonlyArray<T>` — the element types
  // (`H2SessionStatusRow` / `UpstreamWsStatusRow`) are the README-locked P4
  // signatures and are untouched; only THIS snapshot's own container needs
  // to be mutable so `c.json()` (Hono's `JSONValue` = mutable `JSONArray`)
  // accepts it. `getTransportStatusSnapshot()` spreads the underlying
  // readonly snapshots into fresh mutable arrays below.
  h2Sessions: Array<H2SessionStatusRow>
  h2Reconcile: ReturnType<typeof getH2ReconcileStatus>
  upstreamWsPool: Array<UpstreamWsStatusRow>
  // Symmetric with `h2Reconcile` above (spec §4 D7 HIGH-7: both transports'
  // reconcile health must be independently visible, not just h2's). Sourced
  // from the P4 major-fix export `getUpstreamWsReconcileStatus()` — see the
  // default-when-no-manager handling below, mirroring h2Reconcile's own
  // always-present default (h2's reconcile state lives at module scope and
  // is never absent; the WS manager IS a lazily-created singleton, so this
  // snapshot must supply the same "idle, nothing has ever run" default by
  // hand when no manager exists yet).
  upstreamWsReconcile: UpstreamWsReconcileStatus
  runtimeCapability: TransportRuntimeCapability
}

const disabledToNull = (value: number | undefined): number | null => (value === undefined || value === 0 ? null : value)

/** Default when no upstream WS manager has ever been created — mirrors the shape `getH2ReconcileStatus()` starts at before any reconcile has run. */
const NO_MANAGER_WS_RECONCILE: UpstreamWsReconcileStatus = { state: "idle", lastCompletedGeneration: 0, lastError: null }

export function getTransportStatusSnapshot(): TransportStatusSnapshot {
  const wsManager = peekUpstreamWsManager()
  return {
    configured: {
      tcpKeepaliveProbeDelayMs: disabledToNull(getUpstreamKeepAliveDelayMs()),
      h2PingIntervalMs: disabledToNull(getUpstreamH2PingIntervalMs()),
      sessionConnectTimeoutMs: disabledToNull(getSessionConnectTimeoutMs()),
      pooledConnectionIdleTimeoutMs: disabledToNull(getPooledConnectionIdleTimeoutMs()),
      softMaxUpstreamWsConnections: disabledToNull(state.softMaxUpstreamWsConnections),
    },
    h2Sessions: [...getH2SessionStatusSnapshot()],
    h2Reconcile: getH2ReconcileStatus(),
    upstreamWsPool: wsManager === null ? [] : [...getUpstreamWsStatusSnapshot(wsManager)],
    upstreamWsReconcile: wsManager === null ? NO_MANAGER_WS_RECONCILE : getUpstreamWsReconcileStatus(wsManager),
    runtimeCapability: {
      runtime: typeof Bun === "undefined" ? "node" : "bun",
      wsApplicationKeepalive: "unavailable",
    },
  }
}
