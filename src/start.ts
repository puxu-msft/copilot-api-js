#!/usr/bin/env node

import { defineCommand } from "citty"
import consola from "consola"
import pc from "picocolors"
import { serve, type ServerHandler } from "srvx"

import type { Model } from "./lib/models/client"

import packageJson from "../package.json"
import { initAdaptiveRateLimiter } from "./lib/adaptive-rate-limiter"
import { cacheVSCodeVersion } from "./lib/config/api"
import { ensurePaths } from "./lib/config/paths"
import { initProxyFromEnv } from "./lib/config/proxy"
import { initHistory } from "./lib/history"
import { cacheModels } from "./lib/models/client"
import { setServerInstance, setupShutdownHandlers, waitForShutdown } from "./lib/shutdown"
import { state } from "./lib/state"
import { initTokenManagers } from "./lib/token"
import { initTuiLogger } from "./lib/tui"
import { initHistoryWebSocket } from "./routes/history/route"
import { server } from "./server"

/** Format limit values as "Xk" or "?" if not available */
function formatLimit(value?: number): string {
  return value ? `${Math.round(value / 1000)}k` : "?"
}

function formatModelInfo(model: Model): string {
  const limits = model.capabilities?.limits
  const supports = model.capabilities?.supports

  const contextK = formatLimit(limits?.max_context_window_tokens)
  const promptK = formatLimit(limits?.max_prompt_tokens)
  const outputK = formatLimit(limits?.max_output_tokens)

  const features = [
    // Collect all boolean true capabilities from supports
    ...Object.entries(supports ?? {})
      .filter(([, value]) => value === true)
      .map(([key]) => key.replaceAll("_", "-")),
    // Infer additional capabilities
    supports?.max_thinking_budget && "thinking",
    model.capabilities?.type === "embeddings" && "embeddings",
    model.preview && "preview",
  ]
    .filter(Boolean)
    .join(", ")
  const featureStr = features ? ` (${features})` : ""

  // Truncate long model names to maintain alignment
  const modelName = model.id.length > 25 ? `${model.id.slice(0, 22)}...` : model.id.padEnd(25)

  return (
    `  - ${modelName} `
    + `ctx:${contextK.padStart(5)} `
    + `prp:${promptK.padStart(5)} `
    + `out:${outputK.padStart(5)}`
    + featureStr
  )
}

/** Parse an integer from a string, returning a default if the result is NaN. */
function parseIntOrDefault(value: string, defaultValue: number): number {
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) ? parsed : defaultValue
}

interface RunServerOptions {
  port: number
  host?: string
  verbose: boolean
  accountType: "individual" | "business" | "enterprise"
  manual: boolean
  // Adaptive rate limiting options (disabled if rateLimit is false)
  rateLimit: boolean
  retryInterval: number
  requestInterval: number
  recoveryTimeout: number
  consecutiveSuccesses: number
  githubToken?: string
  showGitHubToken: boolean
  proxyEnv: boolean
  historyLimit: number
  autoTruncate: boolean
  compressToolResults: boolean
  redirectAnthropic: boolean
  rewriteAnthropicTools: boolean
  redirectCountTokens: boolean
  redirectSonnetToOpus: boolean
  historyWebSocket: boolean
  collectSystemPrompts: boolean
}

export async function runServer(options: RunServerOptions): Promise<void> {
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

  if (options.proxyEnv) {
    initProxyFromEnv()
  }

  // Set global state from options
  state.accountType = options.accountType
  state.manualApprove = options.manual
  state.showGitHubToken = options.showGitHubToken
  state.autoTruncate = options.autoTruncate
  state.compressToolResults = options.compressToolResults
  state.redirectAnthropic = options.redirectAnthropic
  state.rewriteAnthropicTools = options.rewriteAnthropicTools
  state.redirectCountTokens = options.redirectCountTokens
  state.redirectSonnetToOpus = options.redirectSonnetToOpus
  state.historyWebSocket = options.historyWebSocket
  state.collectSystemPrompts = options.collectSystemPrompts

  // Log configuration status for all features
  const configLines: Array<string> = []
  const on = (label: string, detail?: string) =>
    configLines.push(`  ${label}: ON${detail ? ` ${pc.dim(`(${detail})`)}` : ""}`)
  const off = (label: string) => configLines.push(pc.dim(`  ${label}: OFF`))
  const toggle = (flag: boolean | undefined, label: string, detail?: string) => (flag ? on(label, detail) : off(label))

  toggle(options.verbose, "Verbose logging")
  configLines.push(`  Account type: ${options.accountType}`)

  if (options.rateLimit) {
    on(
      "Rate limiter",
      `retry=${options.retryInterval}s interval=${options.requestInterval}s recovery=${options.recoveryTimeout}m successes=${options.consecutiveSuccesses}`,
    )
  } else {
    off("Rate limiter")
  }

  if (options.autoTruncate) {
    const detail = options.compressToolResults ? "reactive, compress" : "reactive"
    on("Auto-truncate", detail)
  } else {
    off("Auto-truncate")
  }

  if (options.compressToolResults && !options.autoTruncate) {
    // Only show separately if auto-truncate is off but compress is on (unusual)
    on("Compress tool results")
  }
  toggle(options.redirectAnthropic, "Redirect Anthropic", "via OpenAI translation")
  toggle(options.rewriteAnthropicTools, "Rewrite Anthropic tools")
  toggle(options.redirectCountTokens, "Redirect count tokens", "via OpenAI translation")
  toggle(options.manual, "Manual approval")
  toggle(options.proxyEnv, "Proxy from env")
  toggle(options.showGitHubToken, "Show GitHub token")
  toggle(options.redirectSonnetToOpus, "Redirect sonnet to opus")
  toggle(options.historyWebSocket, "History WebSocket", "real-time updates")
  toggle(options.collectSystemPrompts, "Collect system prompts")

  const historyLimitText = options.historyLimit === 0 ? "unlimited" : `max=${options.historyLimit}`
  on("History", historyLimitText)

  consola.info(`Configuration:\n${configLines.join("\n")}`)

  // ===========================================================================
  // Phase 3: Initialize Internal Services (rate limiter, history)
  // ===========================================================================
  if (options.rateLimit) {
    initAdaptiveRateLimiter({
      baseRetryIntervalSeconds: options.retryInterval,
      requestIntervalSeconds: options.requestInterval,
      recoveryTimeoutMinutes: options.recoveryTimeout,
      consecutiveSuccessesForRecovery: options.consecutiveSuccesses,
    })
  }

  initHistory(true, options.historyLimit)

  // ===========================================================================
  // Phase 4: External Dependencies (filesystem, network)
  // ===========================================================================
  await ensurePaths()

  try {
    await cacheVSCodeVersion()
  } catch (error) {
    consola.warn("Failed to fetch VSCode version, using default:", error instanceof Error ? error.message : error)
  }

  // Initialize token management and authenticate
  await initTokenManagers({ cliToken: options.githubToken })

  // Fetch available models from Copilot API
  try {
    await cacheModels()
  } catch (error) {
    consola.warn("Failed to fetch models from Copilot API:", error instanceof Error ? error.message : error)
  }

  consola.info(`Available models:\n${state.models?.data.map((m) => formatModelInfo(m)).join("\n")}`)

  // ===========================================================================
  // Phase 5: Start Server
  // ===========================================================================
  const displayHost = options.host ?? "localhost"
  const serverUrl = `http://${displayHost}:${options.port}`

  // Initialize TUI logger now that we're ready to handle requests
  initTuiLogger()

  // Initialize history WebSocket support (registers /history/ws route)
  // Must be called before server starts so routes are ready, but the returned
  // injectWebSocket function (Node.js only) is called after server creation.
  let injectWebSocket: ((httpServer: import("node:http").Server) => void) | undefined
  if (options.historyWebSocket) {
    injectWebSocket = await initHistoryWebSocket(server)
  }

  consola.box(
    `Web UI:\n🌐 Usage Viewer: https://ericc-ch.github.io/copilot-api?endpoint=${serverUrl}/usage\n📜 History UI:   ${serverUrl}/history`,
  )

  // Import hono/bun websocket handler for Bun's WebSocket support.
  // Bun.serve() requires an explicit `websocket` handler object alongside `fetch`
  // for WebSocket upgrades to work. Without this, server.upgrade() in
  // hono/bun's upgradeWebSocket middleware silently fails.
  const bunWebSocket = typeof globalThis.Bun !== "undefined" ? (await import("hono/bun")).websocket : undefined

  let serverInstance
  try {
    serverInstance = serve({
      fetch: server.fetch as ServerHandler,
      port: options.port,
      hostname: options.host,
      reusePort: true,
      // Disable srvx's built-in graceful shutdown — we have our own
      // multi-phase shutdown handler (see lib/shutdown.ts) that provides
      // request draining, abort signaling, and WebSocket cleanup.
      gracefulShutdown: false,
      bun: {
        // Default idleTimeout is 10s, too short for LLM streaming responses
        idleTimeout: 255, // seconds (Bun max)
        ...(bunWebSocket && { websocket: bunWebSocket }),
      },
    })
  } catch (error) {
    consola.error(`Failed to start server on port ${options.port}. Is the port already in use?`, error)
    process.exit(1)
  }

  // Store server instance and register signal handlers for graceful shutdown.
  // Order matters: setServerInstance must be called before setupShutdownHandlers
  // so the handler has access to the server instance when closing.
  setServerInstance(serverInstance)
  setupShutdownHandlers()

  // Inject WebSocket upgrade handler into Node.js HTTP server (no-op under Bun)
  if (injectWebSocket) {
    const nodeServer = serverInstance.node?.server
    if (nodeServer && "on" in nodeServer) {
      injectWebSocket(nodeServer as import("node:http").Server)
    }
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
    manual: {
      type: "boolean",
      default: false,
      description: "Enable manual request approval",
    },
    "no-rate-limit": {
      type: "boolean",
      default: false,
      description: "Disable adaptive rate limiting",
    },
    "retry-interval": {
      type: "string",
      default: "10",
      description: "Seconds to wait before retrying after rate limit error (default: 10)",
    },
    "request-interval": {
      type: "string",
      default: "10",
      description: "Seconds between requests in rate-limited mode (default: 10)",
    },
    "recovery-timeout": {
      type: "string",
      default: "10",
      description: "Minutes before attempting to recover from rate-limited mode (default: 10)",
    },
    "consecutive-successes": {
      type: "string",
      default: "5",
      description: "Number of consecutive successes needed to recover from rate-limited mode (default: 5)",
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
    "proxy-env": {
      type: "boolean",
      default: false,
      description: "Initialize proxy from environment variables",
    },
    "history-limit": {
      type: "string",
      default: "200",
      description: "Maximum number of history entries to keep in memory (0 = unlimited)",
    },
    "no-auto-truncate": {
      type: "boolean",
      default: false,
      description:
        "Disable reactive auto-truncate (enabled by default: retries with truncated payload on limit errors)",
    },
    "no-compress-tool-results": {
      type: "boolean",
      default: false,
      description: "Disable compressing old tool_result content during auto-truncate",
    },
    "redirect-anthropic": {
      type: "boolean",
      default: false,
      description: "Redirect Anthropic models through OpenAI translation (instead of direct API)",
    },
    "no-rewrite-anthropic-tools": {
      type: "boolean",
      default: false,
      description: "Don't rewrite Anthropic server-side tools (web_search, etc.) to custom tool format",
    },
    "redirect-count-tokens": {
      type: "boolean",
      default: false,
      description: "Redirect count_tokens through OpenAI translation (instead of native Anthropic counting)",
    },
    "redirect-sonnet-to-opus": {
      type: "boolean",
      default: false,
      description: "Redirect sonnet model requests to best available opus model",
    },
    "no-history-websocket": {
      type: "boolean",
      default: false,
      description: "Disable WebSocket real-time updates for history UI",
    },
    "collect-system-prompts": {
      type: "boolean",
      default: false,
      description: "Collect and save original system prompts to data directory (dedup by MD5)",
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
      // manual
      "manual",
      // no-rate-limit (citty also stores "rate-limit" when parsing --no-rate-limit)
      "no-rate-limit",
      "noRateLimit",
      "rate-limit",
      "rateLimit",
      // retry-interval
      "retry-interval",
      "retryInterval",
      // request-interval
      "request-interval",
      "requestInterval",
      // recovery-timeout
      "recovery-timeout",
      "recoveryTimeout",
      // consecutive-successes
      "consecutive-successes",
      "consecutiveSuccesses",
      // github-token
      "github-token",
      "githubToken",
      "g",
      // show-github-token
      "show-github-token",
      "showGithubToken",
      // proxy-env
      "proxy-env",
      "proxyEnv",
      // history-limit
      "history-limit",
      "historyLimit",
      // no-auto-truncate (citty also stores "auto-truncate" when parsing --no-auto-truncate)
      "no-auto-truncate",
      "noAutoTruncate",
      "auto-truncate",
      "autoTruncate",
      // no-compress-tool-results (citty also stores "compress-tool-results")
      "no-compress-tool-results",
      "noCompressToolResults",
      "compress-tool-results",
      "compressToolResults",
      // redirect-anthropic
      "redirect-anthropic",
      "redirectAnthropic",
      // no-rewrite-anthropic-tools (citty also stores "rewrite-anthropic-tools")
      "no-rewrite-anthropic-tools",
      "noRewriteAnthropicTools",
      "rewrite-anthropic-tools",
      "rewriteAnthropicTools",
      // redirect-count-tokens
      "redirect-count-tokens",
      "redirectCountTokens",
      // redirect-sonnet-to-opus
      "redirect-sonnet-to-opus",
      "redirectSonnetToOpus",
      // no-history-websocket (citty also stores "history-websocket")
      "no-history-websocket",
      "noHistoryWebsocket",
      "history-websocket",
      "historyWebsocket",
      // collect-system-prompts
      "collect-system-prompts",
      "collectSystemPrompts",
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
      manual: args.manual,
      rateLimit: !args["no-rate-limit"],
      retryInterval: parseIntOrDefault(args["retry-interval"], 10),
      requestInterval: parseIntOrDefault(args["request-interval"], 10),
      recoveryTimeout: parseIntOrDefault(args["recovery-timeout"], 10),
      consecutiveSuccesses: parseIntOrDefault(args["consecutive-successes"], 5),
      githubToken: args["github-token"],
      showGitHubToken: args["show-github-token"],
      proxyEnv: args["proxy-env"],
      historyLimit: parseIntOrDefault(args["history-limit"], 200),
      autoTruncate: !args["no-auto-truncate"],
      compressToolResults: !args["no-compress-tool-results"],
      redirectAnthropic: args["redirect-anthropic"],
      rewriteAnthropicTools: !args["no-rewrite-anthropic-tools"],
      redirectCountTokens: args["redirect-count-tokens"],
      redirectSonnetToOpus: args["redirect-sonnet-to-opus"],
      historyWebSocket: !args["no-history-websocket"],
      collectSystemPrompts: args["collect-system-prompts"],
    })
  },
})
