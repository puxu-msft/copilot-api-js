#!/usr/bin/env node

import { defineCommand } from "citty"
import consola from "consola"
import pc from "picocolors"
import { startServer } from "./lib/serve"

import type { Model } from "./lib/models/client"

import packageJson from "../package.json"
import { initAdaptiveRateLimiter } from "./lib/adaptive-rate-limiter"
import { loadPersistedLimits } from "./lib/auto-truncate"
import { applyConfigToState } from "./lib/config/config"
import { PATHS, ensurePaths } from "./lib/config/paths"
import { registerContextConsumers } from "./lib/context/consumers"
import { initRequestContextManager } from "./lib/context/manager"
import { cacheVSCodeVersion } from "./lib/copilot-api"
import { initHistory, startMemoryPressureMonitor } from "./lib/history"
import { cacheModels } from "./lib/models/client"
import { getEffectiveEndpoints } from "./lib/models/endpoint"
import { initProxy } from "./lib/proxy"
import { setServerInstance, setupShutdownHandlers, waitForShutdown } from "./lib/shutdown"
import { setServerStartTime, state } from "./lib/state"
import { initTokenManagers } from "./lib/token"
import { initTuiLogger } from "./lib/tui"
import { initWebSocket, setConnectedDataFactory } from "./lib/ws"
import { createWebSocketAdapter } from "./lib/ws-adapter"
import { initResponsesWebSocket } from "./routes/responses/ws"
import { server } from "./server"

/** Format limit values as "Xk" or "?" if not available */
function formatLimit(value?: number): string {
  return value ? `${Math.round(value / 1000)}k` : "?"
}

/**
 * Format a model as 3 lines: main info, features, and supported endpoints.
 *
 * Example output:
 *   - claude-opus-4.6-1m (Anthropic)               ctx:1000k prp: 936k out:  64k
 *       features:  adaptive-thinking, thinking, streaming, vision, tool-calls
 *       endpoints: /v1/messages, /chat/completions
 */
function formatModelInfo(model: Model): string {
  const limits = model.capabilities?.limits
  const supports = model.capabilities?.supports

  const contextK = formatLimit(limits?.max_context_window_tokens)
  const promptK = formatLimit(limits?.max_prompt_tokens)
  const outputK = formatLimit(limits?.max_output_tokens)

  const label = `${model.id} (${model.vendor})`
  const padded = label.length > 45 ? `${label.slice(0, 42)}...` : label.padEnd(45)
  const mainLine =
    `  - ${padded} ` + `ctx:${contextK.padStart(5)} ` + `prp:${promptK.padStart(5)} ` + `out:${outputK.padStart(5)}`

  const features = [
    ...Object.entries(supports ?? {})
      .filter(([, value]) => value === true)
      .map(([key]) => key.replaceAll("_", "-")),
    supports?.max_thinking_budget && "thinking",
    model.capabilities?.type === "embeddings" && "embeddings",
    model.preview && "preview",
  ]
    .filter(Boolean)
    .join(", ")
  const featLine = features ? pc.dim(`      features:  ${features}`) : ""

  const endpoints = getEffectiveEndpoints(model)
  const endpLine = pc.dim(`      endpoints: ${endpoints?.join(", ") ?? "(unknown)"}`)

  return [mainLine, featLine, endpLine].filter(Boolean).join("\n")
}

/** Parse an integer from a string, returning a default if the result is NaN. */
function parseIntOrDefault(value: string, defaultValue: number): number {
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) ? parsed : defaultValue
}

const VALID_ACCOUNT_TYPES = ["individual", "business", "enterprise"] as const

interface RunServerOptions {
  port: number
  host?: string
  verbose: boolean
  accountType: "individual" | "business" | "enterprise"
  // Adaptive rate limiting (disabled if rateLimit is false)
  rateLimit: boolean
  githubToken?: string
  showGitHubToken: boolean
  /** Explicit proxy URL (CLI --proxy). Takes precedence over config.yaml and env vars. */
  proxy?: string
  httpProxyFromEnv: boolean
  autoTruncate: boolean
}

export async function runServer(options: RunServerOptions): Promise<void> {
  // ===========================================================================
  // Phase 0: Validate critical options
  // ===========================================================================
  if (!VALID_ACCOUNT_TYPES.includes(options.accountType)) {
    consola.error(`Invalid account type: "${options.accountType}". Must be one of: ${VALID_ACCOUNT_TYPES.join(", ")}`)
    process.exit(1)
  }

  // ===========================================================================
  // Phase 1: Logging and Verbose Mode
  // ===========================================================================
  if (options.verbose) {
    consola.level = 5
    state.verbose = true
  }

  // ===========================================================================
  // Phase 2: Version and Configuration Display
  // ===========================================================================
  consola.info(`copilot-api v${packageJson.version}`)

  // Set global state from CLI options
  state.accountType = options.accountType
  state.showGitHubToken = options.showGitHubToken
  state.autoTruncate = options.autoTruncate

  // ===========================================================================
  // Phase 2.5: Load config.yaml and apply runtime settings
  // ===========================================================================
  // ensurePaths must run first so the config directory exists
  await ensurePaths()
  consola.info(`Data directory: ${PATHS.APP_DIR}`)

  const config = await applyConfigToState()

  // ===========================================================================
  // Phase 2.6: Initialize proxy (must be before any network requests)
  // ===========================================================================
  // Priority: CLI --proxy > config.yaml proxy > env vars (--http-proxy-from-env)
  const proxyUrl = options.proxy ?? config.proxy
  initProxy({ url: proxyUrl, fromEnv: !proxyUrl && options.httpProxyFromEnv })

  // Rate limiter configuration (used in Phase 3)
  const rlConfig = config.rate_limiter
  const rlRetryInterval = rlConfig?.retry_interval ?? 10
  const rlRequestInterval = rlConfig?.request_interval ?? 10
  const rlRecoveryTimeout = rlConfig?.recovery_timeout ?? 10
  const rlConsecutiveSuccesses = rlConfig?.consecutive_successes ?? 5

  // ===========================================================================
  // Phase 3: Initialize Internal Services (rate limiter, history)
  // ===========================================================================
  if (options.rateLimit) {
    initAdaptiveRateLimiter({
      baseRetryIntervalSeconds: rlRetryInterval,
      requestIntervalSeconds: rlRequestInterval,
      recoveryTimeoutMinutes: rlRecoveryTimeout,
      consecutiveSuccessesForRecovery: rlConsecutiveSuccesses,
    })
  }

  initHistory(true, state.historyLimit)
  startMemoryPressureMonitor()

  // Initialize request context manager and register event consumers
  // Must be after initHistory so history store is ready to receive events
  const contextManager = initRequestContextManager()
  registerContextConsumers(contextManager)

  // Provide active requests snapshot for WS connected events
  setConnectedDataFactory(() =>
    contextManager.getAll().map((ctx) => ({
      id: ctx.id,
      endpoint: ctx.endpoint,
      state: ctx.state,
      startTime: ctx.startTime,
      durationMs: ctx.durationMs,
      model: ctx.originalRequest?.model,
      stream: ctx.originalRequest?.stream,
    })),
  )

  // Start stale request reaper (periodic cleanup of stuck active contexts)
  contextManager.startReaper()

  // Initialize TUI request tracking (renderer was created in main.ts via initConsolaReporter)
  initTuiLogger()

  // ===========================================================================
  // Phase 4: External Dependencies (network)
  // ===========================================================================
  // cacheVSCodeVersion is independent network call
  await cacheVSCodeVersion()

  // Initialize token management and authenticate
  await initTokenManagers({ cliToken: options.githubToken })

  // Fetch available models from Copilot API
  try {
    await cacheModels()
  } catch (error) {
    consola.error("Failed to fetch models from Copilot API:", error instanceof Error ? error.message : error)
    consola.error(
      `Verify that --account-type "${state.accountType}" is correct. `
        + `Available types: ${VALID_ACCOUNT_TYPES.join(", ")}`,
    )
    process.exit(1)
  }

  consola.info(`Available models:\n${state.models?.data.map((m) => formatModelInfo(m)).join("\n")}`)

  // Load previously learned auto-truncate limits (calibration + token limits)
  await loadPersistedLimits()

  // ===========================================================================
  // Phase 5: Start Server
  // ===========================================================================
  const displayHost = options.host ?? "localhost"
  const serverUrl = `http://${displayHost}:${options.port}`

  // Initialize WebSocket support using a single shared adapter.
  // A single createNodeWebSocket instance avoids multiple `upgrade` listeners
  // on the Node HTTP server, which would cause ERR_STREAM_WRITE_AFTER_END
  // when one handler consumes the socket and the other tries to reject.
  const wsAdapter = await createWebSocketAdapter(server)
  initWebSocket(server, wsAdapter.upgradeWebSocket)
  initResponsesWebSocket(server, wsAdapter.upgradeWebSocket)

  consola.box(`Web UI: ${serverUrl}/ui`)

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
      hostname: options.host,
      bunWebSocket,
    })
  } catch (error) {
    consola.error(`Failed to start server on port ${options.port}. Is the port already in use?`, error)
    process.exit(1)
  }

  consola.info(`Listening on ${serverUrl}`)
  setServerStartTime(Date.now())

  // Store server instance and register signal handlers for graceful shutdown.
  // Order matters: setServerInstance must be called before setupShutdownHandlers
  // so the handler has access to the server instance when closing.
  setServerInstance(serverInstance)
  setupShutdownHandlers()

  // Inject the single shared WebSocket upgrade handler into Node.js HTTP server (no-op under Bun)
  if (wsAdapter.injectWebSocket && serverInstance.nodeServer) {
    wsAdapter.injectWebSocket(serverInstance.nodeServer)
  }

  // Block until a shutdown signal (SIGINT/SIGTERM) is received.
  // This prevents runMain() from returning, which would trigger
  // process.exit(0) in main.ts (needed for one-shot commands).
  await waitForShutdown()
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
      description: "Host/interface to bind to (e.g., 127.0.0.1 for localhost only, 0.0.0.0 for all interfaces)",
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
      default: "individual",
      description: "Account type to use (individual, business, enterprise)",
    },
    "rate-limit": {
      type: "boolean",
      default: true,
      description: "Adaptive rate limiting (disable with --no-rate-limit)",
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
    proxy: {
      type: "string",
      description:
        "Proxy URL for all outgoing requests (http://, https://, socks5://, socks5h://). Overrides config.yaml and env vars.",
    },
    "http-proxy-from-env": {
      type: "boolean",
      default: true,
      description: "Use HTTP proxy from environment variables (disable with --no-http-proxy-from-env)",
    },
    "auto-truncate": {
      type: "boolean",
      default: true,
      description:
        "Reactive auto-truncate: retries with truncated payload on limit errors (disable with --no-auto-truncate)",
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
      // rate-limit (citty handles --no-rate-limit via built-in negation)
      "rate-limit",
      "rateLimit",
      // github-token
      "github-token",
      "githubToken",
      "g",
      // show-github-token
      "show-github-token",
      "showGithubToken",
      // proxy
      "proxy",
      // http-proxy-from-env (citty handles --no-http-proxy-from-env via built-in negation)
      "http-proxy-from-env",
      "httpProxyFromEnv",
      // auto-truncate (citty handles --no-auto-truncate via built-in negation)
      "auto-truncate",
      "autoTruncate",
    ])
    const unknownArgs = Object.keys(args).filter((key) => !knownArgs.has(key))
    if (unknownArgs.length > 0) {
      consola.warn(`Unknown argument(s): ${unknownArgs.map((a) => `--${a}`).join(", ")}`)
    }

    return runServer({
      port: parseIntOrDefault(args.port, 4141),
      host: args.host,
      verbose: args.verbose,
      accountType: args["account-type"] as "individual" | "business" | "enterprise",
      rateLimit: args["rate-limit"],
      githubToken: args["github-token"],
      showGitHubToken: args["show-github-token"],
      proxy: args.proxy,
      httpProxyFromEnv: args["http-proxy-from-env"],
      autoTruncate: args["auto-truncate"],
    })
  },
})
