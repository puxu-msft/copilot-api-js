#!/usr/bin/env node

import { defineCommand } from "citty"
import consola from "consola"
import path from "node:path"
import { getProxyForUrl } from "proxy-from-env"

import type { PidfileContent } from "~/lib/restart/pidfile"

import {
  //
  initAdaptiveRateLimiter,
  setMockRateLimiterThrottled,
  setRateLimitPublisher,
} from "~/lib/adaptive-rate-limiter"
import { loadPersistedFeatureNegotiation } from "~/lib/anthropic/feature-negotiation"
import {
  //
  applyConfigToState,
  ConfigParseError,
  loadRawConfigFile,
} from "~/lib/config/config"
import {
  //
  PATHS,
  ensurePaths,
} from "~/lib/config/paths"
import { snapshotWithSummary } from "~/lib/context/activity-summary"
import { initRequestContextManager } from "~/lib/context/manager"
import { cacheVSCodeVersion } from "~/lib/copilot-api"
import { initDiagnosticLogger } from "~/lib/diagnostics"
import {
  //
  attachBootstrapDiagnosticSpool,
  attachStructuredFileSink,
  disableStructuredFileLogging,
} from "~/lib/diagnostics/file"
import {
  //
  initHistoryWithinStartupDeadline,
  setHistoryPublisher,
  startHistoryBackfills,
} from "~/lib/history"
import { cacheModels } from "~/lib/models/cache"
import { getRawModels } from "~/lib/models/cache"
import { loadPersistedLimits } from "~/lib/models/calibration"
import { normalizeForMatching } from "~/lib/models/model-name"
import { startModelRefreshLoop } from "~/lib/models/refresh-loop"
import { initBus } from "~/lib/observability"
import { toActiveRequestWire } from "~/lib/observability/active-request-wire"
import { installConsolaRepublish } from "~/lib/observability/republish"
import { attachCalibrationSink } from "~/lib/observability/sinks/calibration"
import { attachCalibrationFailureSink } from "~/lib/observability/sinks/calibration-failure"
import { attachTelemetrySink } from "~/lib/observability/sinks/telemetry"
import { attachWsSink } from "~/lib/observability/sinks/ws"
import { setRequestLinePublisher } from "~/lib/observability/synthetic-request-line"
import { loadUpstreamHookSafe } from "~/lib/pipeline/hooks/loader"
import {
  //
  getProcessIdentity,
  initProcessIdentity,
} from "~/lib/process-identity"
import { initProxy } from "~/lib/proxy"
import { notifyReady } from "~/lib/restart/notify"
import {
  //
  removePidfileIfOwnedBySelf,
  writePidfile,
} from "~/lib/restart/pidfile"
import { isSupervised } from "~/lib/restart/supervisor-env"
import {
  //
  resolveManualStartup,
  signalPredecessorHandoff,
} from "~/lib/restart/takeover"
import { startServer } from "~/lib/serve"
import {
  //
  setServerInstance,
  setShutdownPublisher,
  setupShutdownHandlers,
  waitForShutdown,
} from "~/lib/shutdown"
import {
  //
  setCliState,
  setServerStartTime,
  setTokenBasedBilling,
  state,
} from "~/lib/state"
import { installDefaultTelemetryRuntime } from "~/lib/telemetry-assembly"
import { initTokenManagers } from "~/lib/token-runtime"
import { getCopilotUsage } from "~/lib/token/copilot-client"
import { attachTerminalUi } from "~/lib/tui"
import {
  //
  createWebSocketAdapter,
  setConnectedDataFactory,
} from "~/lib/ws"
import { registerWsRoutes } from "~/routes"
import { createServer } from "~/server"

import packageJson from "../../../package.json"

/** Parse an integer from a string, returning a default if the result is NaN. */
function parseIntOrDefault(value: string, defaultValue: number): number {
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) ? parsed : defaultValue
}

/**
 * Resolve the --host CLI value into one or more concrete bind addresses.
 *
 * - undefined / "localhost"  → 127.0.0.1 + ::1 (dual-stack loopback)
 * - "any"                    → 0.0.0.0 + ::    (dual-stack all interfaces)
 * - anything else            → used as-is (single bind)
 */
export function resolveBindHostnames(host: string | undefined): { hostnames: Array<string>; displayHost: string } {
  if (host === undefined || host === "localhost") {
    return { hostnames: ["127.0.0.1", "::1"], displayHost: "localhost" }
  }
  if (host === "any") {
    return { hostnames: ["0.0.0.0", "::"], displayHost: "0.0.0.0" }
  }
  return { hostnames: [host], displayHost: host }
}

const VALID_ACCOUNT_TYPES = ["individual", "business", "enterprise"] as const

/**
 * Best-effort inference of account type from `/copilot_internal/user`.
 *
 * Heuristics — conservative, falls through to `"individual"` for unknown
 * plans rather than guessing. Upstream's `copilot_plan` strings are
 * documented loosely; we match on substrings so new SKUs (e.g.
 * `enterprise_seat_v2`) still route correctly.
 *
 * Returns `undefined` when no field provides a usable signal.
 */
function inferAccountTypeFromUsage(usage: { copilot_plan?: string; access_type_sku?: string }): (typeof VALID_ACCOUNT_TYPES)[number] | undefined {
  const haystack = `${usage.copilot_plan ?? ""} ${usage.access_type_sku ?? ""}`.toLowerCase()
  if (!haystack.trim()) return undefined
  if (haystack.includes("enterprise")) return "enterprise"
  if (haystack.includes("business")) return "business"
  if (haystack.includes("individual") || haystack.includes("free") || haystack.includes("pro")) return "individual"
  return undefined
}

interface RunServerOptions {
  port: number
  host?: string
  verbose: boolean
  /**
   * Explicit account type. When `undefined`, the runtime infers it from
   * the logged-in user's `copilot_plan` field after authentication and
   * falls back to `"individual"` if no clear signal is found.
   */
  accountType?: "individual" | "business" | "enterprise"
  /**
   * Explicit GHC API base URL (e.g. `https://api.githubcopilot.com`).
   * Overrides `accountType`-derived URL when set.
   */
  ghcApiBaseUrl?: string
  // Adaptive rate limiting (disabled if rateLimit is false)
  rateLimit: boolean
  /**
   * History recording master switch (CLI --history / --no-history). undefined =
   * unset → fall back to config `history.enabled` (default true). false forces
   * no-history mode: no History database is opened and nothing is recorded.
   */
  history?: boolean
  /** Mock rate limiter throttle: reject all requests with 429 */
  mockRateLimiterThrottled: boolean
  githubToken?: string
  showGitHubToken: boolean
  /** Enable interactive raw-mode TUI; false forces the plain log renderer. */
  tui: boolean
  /** Explicit proxy URL (CLI --proxy). Takes precedence over env vars and config.yaml. */
  proxy?: string
  httpProxyFromEnv: boolean
  /**
   * 零停机接管：若已有裸手动实例在跑（pidfile 活性检查检测到），绑定同端口
   * （reusePort）并向其发 SIGUSR2 交接，待其 drain 完退出。仅裸手动路径生效；
   * systemd/pm2 下由 supervisor 编排交接、本 flag 被忽略（lifecycle.md「优雅重启」）。
   */
  restart: boolean
}

export async function runServer(options: RunServerOptions): Promise<void> {
  // ===========================================================================
  // Phase 0: Validate critical options
  // ===========================================================================
  // accountType is optional now — when explicitly passed it must be valid;
  // when omitted, inference (or a fallback to "individual") will fill it.
  if (options.accountType !== undefined && !VALID_ACCOUNT_TYPES.includes(options.accountType)) {
    consola.error(`Invalid account type: "${options.accountType}". Must be one of: ${VALID_ACCOUNT_TYPES.join(", ")}`)
    process.exit(1)
  }
  if (options.ghcApiBaseUrl !== undefined) {
    try {
      const url = new URL(options.ghcApiBaseUrl)
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new Error(`unsupported protocol "${url.protocol}" — only http:/https: are accepted`)
      }
    } catch (error) {
      consola.error(`Invalid --ghc-api-base-url: ${error instanceof Error ? error.message : String(error)}`)
      process.exit(1)
    }
  }
  // ===========================================================================
  // Phase 1: Logging and Verbose Mode
  // ===========================================================================
  if (options.verbose) {
    consola.level = 5
    setCliState({ verbose: true })
  }

  // ===========================================================================
  // Phase 1.5: Observability bootstrap (terminal + secure file WAL for the WHOLE boot)
  // ===========================================================================
  // The permanent terminal owner sees every event once. A secure O_EXCL spool is
  // the full-process file WAL: after config/identity freeze it replays boot records
  // into the detached-ready structured sink, then remains the sole bus owner and
  // WAL-first mirrors each live record into that sink with a stable delivery ID.
  // It is never re-published to the bus, so terminal output is not duplicated.
  // Clean shutdown deletes it only after the structured durability barrier; a
  // crash or cutover failure leaves it for idempotent recovery.
  await ensurePaths()
  const bus = initBus()
  const systemPublisher = bus.scope("system")
  setShutdownPublisher(systemPublisher)
  setRateLimitPublisher(systemPublisher)
  setRequestLinePublisher(systemPublisher)
  initDiagnosticLogger(systemPublisher)
  // Explicitly pass process.stdin so the interactive raw-mode panel gates on
  // (evaluator §3): tests that omit stdin stay on the non-interactive P0 path.
  let detachTerminalUi = attachTerminalUi(bus, { isTTY: false, diagnosticLevel: () => state.logging.terminalLevel })
  attachBootstrapDiagnosticSpool(bus, PATHS.DIAGNOSTIC_LOG_DIR)
  installConsolaRepublish(systemPublisher)

  // ===========================================================================
  // Phase 2: Version and Configuration Display
  // ===========================================================================
  consola.info(`copilot-api v${packageJson.version}`)

  // Capture the process identity (pid + boot time + git sha) once, before any
  // request can be served, so every history record can self-describe which
  // process produced it. Printed to the boot banner for at-a-glance attribution.
  const procId = initProcessIdentity(packageJson.version)
  consola.info(`Process: pid=${procId.pid}${procId.gitSha ? ` sha=${procId.gitSha}${procId.gitDirty ? "-dirty" : ""}` : ""}`)
  consola.info(`Data directory: ${PATHS.APP_DIR}`)

  // Set global state from CLI options. accountType is only set here when
  // the user passed it explicitly — otherwise we leave the state default
  // ("individual") in place until inference runs after authentication,
  // which may override it. ghcApiBaseUrl is applied below
  // (after config load) so CLI takes precedence over config.yaml.
  setCliState({
    ...(options.accountType !== undefined && { accountType: options.accountType }),
    showGitHubToken: options.showGitHubToken,
  })

  // ===========================================================================
  // Phase 2.5: Load config.yaml and apply runtime settings
  // ===========================================================================
  // Boot-time strict parse of the user's config.yaml. A malformed file (duplicate
  // keys, YAML spec violations) is silently lossy with the default permissive
  // parser — `parse()` keeps the last value on a duplicate key, so the operator's
  // intent is corrupted invisibly. Boot aborts here so the user fixes the file
  // before serving any traffic. Hot reload (per-request applyConfigToState) only
  // warns and falls back to bundled defaults, so a mid-flight edit can't take the
  // server down. ENOENT (no user config) is fine — bundled defaults stand.
  try {
    await loadRawConfigFile()
  } catch (err: unknown) {
    if (err instanceof ConfigParseError) {
      consola.error(`Refusing to start: user config.yaml is malformed (${PATHS.CONFIG_YAML}).`)
      consola.error(err.message)
      consola.error("Fix the YAML and restart. (Hot reload tolerates this; boot does not.)")
      process.exit(1)
    }
    throw err
  }

  const config = await applyConfigToState()

  // Boot diagnostics were shown once through the plain owner. Acquire raw-mode
  // TUI only after config is frozen; the synchronous swap has no publish gap.
  detachTerminalUi()
  detachTerminalUi = attachTerminalUi(
    bus,
    options.tui && state.tuiEnabled ?
      { stdin: process.stdin, diagnosticLevel: () => state.logging.terminalLevel }
    : {
        isTTY: false,
        diagnosticLevel: () => state.logging.terminalLevel,
      },
  )

  if (state.logging.fileEnabled) {
    try {
      const directory = state.logging.fileDirectory ? path.resolve(state.logging.fileDirectory) : PATHS.DIAGNOSTIC_LOG_DIR
      const sink = await attachStructuredFileSink(bus, {
        directory,
        maxSizeBytes: state.logging.fileMaxSizeMb * 1024 * 1024,
        maxFilesPerProcess: state.logging.fileMaxFilesPerProcess,
        retentionDays: state.logging.retentionDays,
        level: () => state.logging.fileLevel,
      })
      consola.info(`Structured diagnostics: ${sink.health.activePath}`)
    } catch (error) {
      // The secure per-boot spool remains crash-recoverable. Never fall back to
      // the retired shared rotating file, which is unsafe during process overlap.
      consola.error("Structured diagnostic file initialization failed; retaining secure bootstrap spool:", error)
    }
  } else {
    await disableStructuredFileLogging()
  }

  // Deprecation: ANTHROPIC_API_KEY previously routed count_tokens for Claude
  // models to api.anthropic.com. That path is retired — count_tokens now
  // forwards to GHC's upstream /v1/messages/count_tokens (no separate key). Warn
  // users who still set the env var so the silent channel change is visible.
  // (The config key anthropic.api_key is warned separately via CONFIG_MIGRATIONS.)
  if (process.env.ANTHROPIC_API_KEY) {
    consola.warn(
      "ANTHROPIC_API_KEY is set but no longer used — count_tokens now forwards to GHC's upstream /v1/messages/count_tokens (no separate Anthropic API key needed).",
    )
  }

  // Upstream hook module (dev/test only) — declarative state was already set by
  // applyConfigToState above; load it here if enabled. warn-continue: a bad/missing hook
  // module must never block startup (see loadUpstreamHookSafe).
  if (state.hooksEnabled && state.hooksUpstreamModule) {
    await loadUpstreamHookSafe(state.hooksUpstreamModule)
  }

  // GHC API base URL — CLI > config.yaml. Not hot-reloadable: changing
  // the upstream endpoint mid-flight would mis-route active requests.
  // Apply after applyConfigToState so the CLI value still wins.
  const resolvedBaseUrl = options.ghcApiBaseUrl ?? config.ghc_api_base_url
  if (resolvedBaseUrl) {
    setCliState({ ghcApiBaseUrl: resolvedBaseUrl })
  }

  // ===========================================================================
  // Phase 2.6: Initialize proxy (must be before any network requests)
  // ===========================================================================
  // Priority: CLI --proxy > env vars (--http-proxy-from-env) > config.yaml proxy.
  // CLI is an explicit URL. Otherwise, if env proxying is enabled and the
  // environment carries a proxy for the upstream, env wins; config is the
  // fallback when env is disabled or has no proxy for this host.
  const cliProxy = options.proxy
  const envHasProxy = options.httpProxyFromEnv && getProxyForUrl(state.ghcApiBaseUrl || "https://api.githubcopilot.com") !== ""
  const proxyUrl = cliProxy ?? (envHasProxy ? undefined : config.proxy)
  initProxy({ url: proxyUrl, fromEnv: !cliProxy && options.httpProxyFromEnv })

  // ===========================================================================
  // Phase 2.7: Graceful-restart startup guard (bare-metal path only)
  // ===========================================================================
  // resolveManualStartup collapses the supervisor branch + decideStartup into
  // one pure, unit-tested function (tests/restart/runserver-wiring.unit.test.ts);
  // this call site only does the IO reaction (exit/log/record) on its result.
  // Overlap-window data safety (reclaim exclusion / VACUUM skip) no longer
  // depends on this decision — it's judged by process liveness directly in
  // history/sqlite/connection.ts (lifecycle.md「overlap 共享状态安全 ①⑤」).
  const pidfilePath = config.pidfile ?? PATHS.PIDFILE
  const manualStartup = resolveManualStartup({ pidfilePath, restart: options.restart, supervised: isSupervised() })
  let takeoverPredecessor: PidfileContent | null = null
  if (manualStartup.kind === "refuse") {
    consola.error(`已有实例在运行（pid=${manualStartup.predecessor.pid}, port=${manualStartup.predecessor.port}）。` + `用 --restart 接管，或先停旧实例。`)
    process.exit(1)
  }
  if (manualStartup.kind === "takeover") {
    takeoverPredecessor = manualStartup.predecessor
    consola.info(`[restart] 接管模式：将在监听后向前任 pid=${takeoverPredecessor.pid} 发交接信号`)
  }

  // ===========================================================================
  // Phase 3: Initialize backing stores, their sinks, and the rate limiter
  // ===========================================================================
  // The log-stream sinks (Console, File) + system publisher were wired in
  // Phase 1.5. Here we init the request/history backing stores and attach the
  // sinks that depend on them, then the rate limiter (now AFTER the bus +
  // setRateLimitPublisher + installConsolaRepublish, so its "[RateLimiter]
  // Initialized" line is captured by the file sink and the --mock-rate-limiter-
  // throttled forced state transition actually reaches the bus).
  const historyEnabled = options.history ?? state.historyEnabled
  try {
    await initHistoryWithinStartupDeadline(historyEnabled)
  } catch (error) {
    // Spec §8.1 forbids listening before History is ready, and the Worker's startup retries are rate-limited but uncapped by design — so without an exit here a persistently locked or failing database leaves the process neither serving nor terminating, which is strictly worse for an operator than a crash. This is the one place that owns "stop waiting": end the process with a non-zero code so a supervisor can restart or alert.
    consola.error("History failed to start; refusing to serve without it.", error)
    process.exit(1)
  }
  // Assemble the telemetry domain BEFORE its first lifecycle op: the composition root adapts core
  // PATHS + the live `telemetry.*` config view + the config-change subscription into the domain's
  // injected ports and installs the process-singleton runtime every tolerant `peekTelemetryRuntime()`
  // consumer (record legs, read routes, shutdown) resolves. Phase ① of the 5-phase lifecycle;
  // phase ② (runJsonBackfill) deliberately runs AFTER the server listens, further down.
  const telemetryRuntime = installDefaultTelemetryRuntime()
  await telemetryRuntime.initialize()

  // Canonical V3 terminal persistence is installed by initHistory. The legacy
  // mutable-context HistorySink is deliberately not attached in production.
  const historyPublisher = bus.scope("history")
  setHistoryPublisher(historyPublisher)
  attachTelemetrySink(bus)
  attachCalibrationSink(bus)
  attachCalibrationFailureSink(bus)
  attachWsSink(bus)

  // Rate limiter — config-driven, constructed after observability is live so
  // its init log + any boot-time state transition are captured/published.
  const rlConfig = config.rate_limiter
  const rlRetryInterval = rlConfig?.retry_interval ?? 10
  const rlRequestInterval = rlConfig?.request_interval ?? 10
  const rlRecoveryInterval = rlConfig?.recovery_interval ?? 600
  const rlConsecutiveSuccesses = rlConfig?.consecutive_successes ?? 5
  if (options.rateLimit) {
    initAdaptiveRateLimiter({
      baseRetryIntervalSeconds: rlRetryInterval,
      requestIntervalSeconds: rlRequestInterval,
      recoveryTimeoutSeconds: rlRecoveryInterval,
      consecutiveSuccessesForRecovery: rlConsecutiveSuccesses,
    })
  }

  if (options.mockRateLimiterThrottled) {
    if (!options.rateLimit) {
      consola.warn("--mock-rate-limiter-throttled requires rate limiting to be enabled (--no-rate-limit is set)")
    }
    setMockRateLimiterThrottled(true)
  }

  // Initialize request context manager with the request.* publisher so
  // every lifecycle event reaches WsSink + ConsoleSink + TelemetrySink.
  // consumers.ts is deleted as of commit 3b;
  // the bus is the only path for these signals now.
  const contextManager = initRequestContextManager({ publisher: bus.scope("request") })

  // 在途快照:与 active_request_changed 同源(toActiveRequestWire ∘ snapshotWithSummary),
  // 保证 WS 重连后已在飞行的行富字段立即非空(attemptCount/queueWaitMs/transport/models…)。
  setConnectedDataFactory(() => contextManager.getAll().map((ctx) => toActiveRequestWire(snapshotWithSummary(ctx))))

  // Start stale request reaper (periodic cleanup of stuck active contexts)
  contextManager.startReaper()

  // ===========================================================================
  // Phase 4: External Dependencies (network)
  // ===========================================================================
  // cacheVSCodeVersion is independent network call
  await cacheVSCodeVersion()

  // Initialize token management and authenticate
  await initTokenManagers({ cliToken: options.githubToken })

  // Probe `/copilot_internal/user` once, then derive:
  //   - Account type (only when caller didn't pass --account-type and no
  //     explicit base URL is in effect).
  //   - Billing mode (token-based vs. multiplier — affects per-model badge).
  // Both are non-fatal: failures fall back to current defaults.
  try {
    const usage = await getCopilotUsage()

    // Auto-infer account type. Skipped when an explicit base URL is in
    // effect (state.ghcApiBaseUrl, set from CLI or config) — the URL
    // override makes account-type irrelevant for routing.
    if (options.accountType === undefined && !state.ghcApiBaseUrl) {
      const inferred = inferAccountTypeFromUsage(usage)
      if (inferred && inferred !== state.accountType) {
        const sourceField = usage.copilot_plan ? `copilot_plan="${usage.copilot_plan}"` : `access_type_sku="${usage.access_type_sku}"`
        consola.info(`[account] Inferred account-type=${inferred} from ${sourceField}`)
        setCliState({ accountType: inferred })
      } else if (!inferred) {
        consola.debug(
          `[account] Could not infer account-type from copilot_plan="${usage.copilot_plan}" / access_type_sku="${usage.access_type_sku}" — keeping "${state.accountType}"`,
        )
      }
    }

    // Billing mode badge — `(1x)` is meaningless when every model is PAYG.
    const tokenBased = usage.token_based_billing === true || usage.quota_snapshots?.premium_interactions?.token_based_billing === true
    setTokenBasedBilling(tokenBased)
  } catch (error) {
    consola.debug("[account] /copilot_internal/user probe failed; using defaults:", error)
  }

  // Fetch available models from Copilot API
  try {
    await cacheModels()
  } catch (error) {
    consola.error("Failed to fetch models from Copilot API:", error instanceof Error ? error.message : error)
    consola.error(
      state.ghcApiBaseUrl ?
        `Verify that --ghc-api-base-url "${state.ghcApiBaseUrl}" is reachable.`
      : `Verify that --account-type "${state.accountType}" is correct. ` + `Available types: ${VALID_ACCOUNT_TYPES.join(", ")}`,
    )
    process.exit(1)
  }

  // List all upstream models, marking disabled entries so it's obvious which
  // ones have been filtered out by config.disabled_models.
  const rawList = getRawModels()?.data ?? state.models?.data ?? []
  const disabledSet = new Set(state.disabledModels.map((id) => normalizeForMatching(id)))
  systemPublisher.publish({
    kind: "system.model_catalog",
    models: rawList.map((model) => ({ model, disabled: disabledSet.has(normalizeForMatching(model.id)) })),
    tokenBasedBilling: state.tokenBasedBilling,
    timeUnixMs: Date.now(),
  })
  const stopModelRefreshLoop = startModelRefreshLoop()

  // Load the persisted per-model token-count calibration (factor model + seed).
  // Unconditional: calibration is always-on now (repurposed for honest local
  // token counting — count-tokens fallback + debug probe), and this call also
  // materializes the factory bake-in seed for fresh installs.
  await loadPersistedLimits()

  // Load previously negotiated feature/beta-header support (states.json)
  await loadPersistedFeatureNegotiation()

  // ===========================================================================
  // Phase 5: Start Server
  // ===========================================================================
  const { hostnames, displayHost } = resolveBindHostnames(options.host)
  const serverUrl = `http://${displayHost}:${options.port}`
  const server = createServer()

  // Initialize WebSocket support using a single shared adapter.
  // A single createNodeWebSocket instance avoids multiple `upgrade` listeners
  // on the Node HTTP server, which would cause ERR_STREAM_WRITE_AFTER_END
  // when one handler consumes the socket and the other tries to reject.
  const wsAdapter = await createWebSocketAdapter(server)
  registerWsRoutes(server, wsAdapter.upgradeWebSocket)

  // Import hono/bun websocket handler for Bun's WebSocket support.
  // Bun.serve() requires an explicit `websocket` handler object alongside `fetch`
  // for WebSocket upgrades to work. Without this, server.upgrade() in
  // hono/bun's upgradeWebSocket middleware silently fails.
  const bunWebSocket = typeof globalThis.Bun !== "undefined" ? (await import("hono/bun")).websocket : undefined

  let serverInstance
  try {
    serverInstance = await startServer({
      fetch: server.fetch,
      port: options.port,
      hostnames,
      bunWebSocket,
    })
  } catch (error) {
    consola.error(`Failed to start server on port ${options.port}. Is the port already in use?`, error)
    process.exit(1)
  }

  consola.info(`Listening on ${serverUrl}`)
  setServerStartTime(Date.now())
  // Phase ① is over. The runtime fail-fasts here if initialize() never completed, and unblocks the
  // post-listen backfill below — it OWNS that ordering, so moving these calls cannot silently break
  // it (see the TelemetryRuntime doc).
  telemetryRuntime.markServerListening()

  // Store server instance and register signal handlers for graceful shutdown.
  // Order matters: setServerInstance must be called before setupShutdownHandlers
  // so the handler has access to the server instance when closing.
  setServerInstance(serverInstance)
  setupShutdownHandlers()

  // Bare-metal pidfile write (仅裸手动路径；supervisor 环境跳过整个 pidfile 机制) —
  // must happen AFTER the server is actually listening (setServerInstance above),
  // so a reader never observes a pidfile pointing at a process that isn't accepting
  // connections yet.
  if (!isSupervised()) {
    const id = getProcessIdentity()
    writePidfile(pidfilePath, { pid: id.pid, bootTime: id.bootTime, port: options.port })
    // Best-effort fallback for non-graceful exits (e.g. an uncaught throw that
    // bypasses the `finally` below): `process.on("exit")` handlers must be fully
    // synchronous, so this is the same compare-and-delete primitive used there —
    // never an unconditional delete (B2: would erase a takeover successor's live
    // pidfile).
    process.on("exit", () => removePidfileIfOwnedBySelf(pidfilePath, { pid: id.pid, bootTime: id.bootTime }))
  }

  // 就绪通知（三后端：sd_notify READY=1 / pm2 process.send('ready') / 裸手动 no-op，
  // 各自按环境自动 no-op）——此刻服务器已在监听，对外通知「可以路由流量了」是准确的。
  notifyReady()
  // 裸手动接管：现在才向前任发交接信号（新进程已监听同端口，前任此刻停 accept 是安全的）。
  if (takeoverPredecessor) signalPredecessorHandoff(takeoverPredecessor.pid)

  // Fire-and-forget the recoverable background backfills now that the server is
  // listening: the usage net-of-cache normalization first (fast, guarded by
  // usage_normalized), then the heavier search_index + preview_text backfill.
  // Both are async/chunked/resumable and yield between batches, so they never
  // block startup or starve request serving; each is a no-op once already done.
  // Returns immediately (the work trickles in the background) and never throws.
  startHistoryBackfills()

  // Run the one-shot legacy-JSON telemetry absorption backfill (P6) now the server is listening: absorb
  // the FROZEN pre-startup `request-telemetry.json` snapshot (captured at init) into telemetry.db
  // (tel_raw/tel_accepted/tel_cumulative + rollup seed) so the SQLite tiers carry the migration-era
  // history. Guarded by `json_backfill_version` (a restart re-runs it as a no-op), consumes the init-time
  // snapshot (never a fresh read — structural disjointness), and is itself never-throw. Synchronous DB
  // work, wrapped defensively so nothing here can bubble into the startup path.
  try {
    telemetryRuntime.runJsonBackfill()
  } catch (err: unknown) {
    consola.warn("[telemetry] json backfill failed", err)
  }

  // Inject the single shared WebSocket upgrade handler into each Node.js HTTP server (no-op under Bun)
  if (wsAdapter.injectWebSocket && serverInstance.nodeServers) {
    for (const nodeServer of serverInstance.nodeServers) {
      wsAdapter.injectWebSocket(nodeServer)
    }
  }

  try {
    // Block until a shutdown signal (SIGINT/SIGTERM) is received.
    // This prevents runMain() from returning, which would trigger
    // process.exit(0) in main.ts (needed for one-shot commands).
    await waitForShutdown()
  } finally {
    detachTerminalUi()
    stopModelRefreshLoop()
    // Bare-metal pidfile cleanup — compare-and-delete (B2): a takeover already
    // overwrote this same path with the successor's pid, so an unconditional
    // delete here would erase a LIVE successor's pidfile out from under it
    // (permanently disabling the guard, silently allowing a third instance to
    // stack on the next plain start). removePidfileIfOwnedBySelf only deletes
    // when the on-disk pid still matches our own.
    if (!isSupervised()) {
      const id = getProcessIdentity()
      removePidfileIfOwnedBySelf(pidfilePath, { pid: id.pid, bootTime: id.bootTime })
    }
  }
}

export const start = defineCommand({
  meta: {
    name: "start",
    description: "Start the Copilot API server",
  },
  args: {
    port: {
      alias: "p",
      type: "string",
      default: "4141",
      description: "Port to listen on",
    },
    host: {
      alias: "H",
      type: "string",
      description:
        "Host/interface to bind to. Special values: 'localhost' (default) binds 127.0.0.1 + ::1, 'any' binds 0.0.0.0 + ::. Specific addresses (e.g. 127.0.0.1, 0.0.0.0) bind only that interface.",
    },
    verbose: {
      alias: "v",
      type: "boolean",
      default: false,
      description: "Enable verbose logging",
    },
    "account-type": {
      alias: "a",
      type: "string",
      // No default — when omitted, the runtime may infer it from the
      // logged-in user's `copilot_plan` field. Falls back to `individual`
      // if inference fails or yields no clear signal.
      description:
        "Upstream account type, one of: individual, business, enterprise."
        + " When omitted, inferred from the logged-in account; falls back to 'individual'."
        + " Has no effect when --ghc-api-base-url is set.",
    },
    "ghc-api-base-url": {
      type: "string",
      description: "Explicit upstream GHC API base URL (e.g. https://api.githubcopilot.com)." + " Overrides --account-type when set.",
    },
    "rate-limit": {
      type: "boolean",
      default: true,
      description: "Adaptive rate limiting (disable with --no-rate-limit)",
    },
    history: {
      type: "boolean",
      // No default on purpose: unset → undefined → fall back to config
      // `history.enabled` (default true). --no-history forces the no-history
      // mode (no History database opened, nothing recorded) and wins over config.
      description: "Record request history to SQLite (disable with --no-history)",
    },
    "mock-rate-limiter-throttled": {
      type: "boolean",
      default: false,
      description: "Mock rate limiter: reject all GHC API requests with 429 after timeout (for testing)",
    },
    "github-token": {
      alias: "g",
      type: "string",
      description: "Provide GitHub token directly (must be generated using the `auth` subcommand)",
    },
    "show-github-token": {
      type: "boolean",
      default: false,
      description: "Show GitHub token in logs (use --verbose for Copilot token refresh logs)",
    },
    tui: {
      type: "boolean",
      default: true,
      description: "Interactive terminal UI (disable with --no-tui)",
    },
    proxy: {
      type: "string",
      description: "Proxy URL for all outgoing requests (http://, https://, socks5://, socks5h://). Overrides env vars and config.yaml.",
    },
    "http-proxy-from-env": {
      type: "boolean",
      default: true,
      description: "Use HTTP proxy from environment variables (disable with --no-http-proxy-from-env)",
    },
    restart: {
      type: "boolean",
      default: false,
      description: "零停机接管：若已有实例在跑，绑定同端口并向其发 SIGUSR2 交接（仅裸手动路径；systemd/pm2 由 supervisor 编排）。",
    },
  },
  run({ args }) {
    // Check for unknown arguments
    // Known args include both kebab-case (as defined) and camelCase (citty auto-converts)
    const knownArgs = new Set([
      "_",
      // port
      "port",
      "p",
      // host
      "host",
      "H",
      // verbose
      "verbose",
      "v",
      // account-type
      "account-type",
      "accountType",
      "a",
      // ghc-api-base-url
      "ghc-api-base-url",
      "ghcApiBaseUrl",
      // rate-limit (citty handles --no-rate-limit via built-in negation)
      "rate-limit",
      "rateLimit",
      // history (citty handles --no-history via built-in negation)
      "history",
      // mock-rate-limiter-throttled
      "mock-rate-limiter-throttled",
      "mockRateLimiterThrottled",
      // github-token
      "github-token",
      "githubToken",
      "g",
      // show-github-token
      "show-github-token",
      "showGithubToken",
      "tui",
      // proxy
      "proxy",
      // http-proxy-from-env (citty handles --no-http-proxy-from-env via built-in negation)
      "http-proxy-from-env",
      "httpProxyFromEnv",
      // restart
      "restart",
    ])
    const unknownArgs = Object.keys(args).filter((key) => !knownArgs.has(key))
    if (unknownArgs.length > 0) {
      consola.warn(`Unknown argument(s): ${unknownArgs.map((a) => `--${a}`).join(", ")}`)
    }

    return runServer({
      port: parseIntOrDefault(args.port, 4141),
      host: args.host,
      verbose: args.verbose,
      // `undefined` triggers auto-inference; the runServer flow falls back
      // to "individual" when inference yields no clear signal.
      accountType: args["account-type"] as "individual" | "business" | "enterprise" | undefined,
      ghcApiBaseUrl: args["ghc-api-base-url"],
      rateLimit: args["rate-limit"],
      history: args.history,
      mockRateLimiterThrottled: args["mock-rate-limiter-throttled"],
      githubToken: args["github-token"],
      showGitHubToken: args["show-github-token"],
      tui: args.tui,
      proxy: args.proxy,
      httpProxyFromEnv: args["http-proxy-from-env"],
      restart: args.restart,
    })
  },
})
