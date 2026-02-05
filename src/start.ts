#!/usr/bin/env node

import { defineCommand } from "citty"
import consola from "consola"
import { createHash } from "node:crypto"
import { existsSync, promises as fsPromises } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { serve, type ServerHandler } from "srvx"
import invariant from "tiny-invariant"

import type { Model } from "./services/copilot/get-models"

import packageJson from "../package.json"
import { initAdaptiveRateLimiter } from "./lib/adaptive-rate-limiter"
import { initHistory } from "./lib/history"
import { ensurePaths } from "./lib/paths"
import { initProxyFromEnv } from "./lib/proxy"
import { state } from "./lib/state"
import { initTokenManagers } from "./lib/token"
import { initConsolaReporter, initRequestTracker } from "./lib/tui"
import { cacheModels, cacheVSCodeVersion } from "./lib/utils"
import { server } from "./server"

/** Format limit values as "Xk" or "?" if not available */
function formatLimit(value?: number): string {
  return value ? `${Math.round(value / 1000)}k` : "?"
}

function formatModelInfo(model: Model): string {
  const limits = model.capabilities?.limits

  const contextK = formatLimit(limits?.max_context_window_tokens)
  const promptK = formatLimit(limits?.max_prompt_tokens)
  const outputK = formatLimit(limits?.max_output_tokens)

  const features = [
    model.capabilities?.supports?.tool_calls && "tools",
    model.preview && "preview",
  ]
    .filter(Boolean)
    .join(", ")
  const featureStr = features ? ` (${features})` : ""

  // Truncate long model names to maintain alignment
  const modelName =
    model.id.length > 30 ? `${model.id.slice(0, 27)}...` : model.id.padEnd(30)

  return (
    `  - ${modelName} `
    + `ctx:${contextK.padStart(5)} `
    + `prps:${promptK.padStart(4)} `
    + `out:${outputK.padStart(4)}`
    + featureStr
  )
}

// Security Research Mode passphrase verification
// Salt + SHA1 hash of the correct passphrase (not stored in plaintext)
const SECURITY_RESEARCH_SALT = "copilot-api-security-research:"
const SECURITY_RESEARCH_HASH = "400d6b268f04b9ae9d9ea9b27a93364c3b24565c"

/**
 * Verify the Security Research Mode passphrase.
 * Returns true if the passphrase is correct, false otherwise.
 */
function verifySecurityResearchPassphrase(passphrase: string): boolean {
  const hash = createHash("sha1")
    .update(SECURITY_RESEARCH_SALT + passphrase)
    .digest("hex")
  return hash === SECURITY_RESEARCH_HASH
}

/**
 * Setup Claude Code configuration files for use with Copilot API.
 * Creates/updates:
 * - $HOME/.claude.json - Sets hasCompletedOnboarding: true
 * - $HOME/.claude/settings.json - Sets env variables for Copilot API
 */
async function setupClaudeCodeConfig(
  serverUrl: string,
  model: string,
  smallModel: string,
): Promise<void> {
  const home = homedir()
  const claudeJsonPath = join(home, ".claude.json")
  const claudeDir = join(home, ".claude")
  const settingsPath = join(claudeDir, "settings.json")

  // Ensure .claude directory exists
  if (!existsSync(claudeDir)) {
    await fsPromises.mkdir(claudeDir, { recursive: true })
    consola.info(`Created directory: ${claudeDir}`)
  }

  // Update $HOME/.claude.json
  let claudeJson: Record<string, unknown> = {}
  if (existsSync(claudeJsonPath)) {
    try {
      const buffer = await fsPromises.readFile(claudeJsonPath)
      claudeJson = JSON.parse(buffer.toString()) as Record<string, unknown>
    } catch {
      consola.warn(`Failed to parse ${claudeJsonPath}, creating new file`)
    }
  }
  claudeJson.hasCompletedOnboarding = true
  await fsPromises.writeFile(
    claudeJsonPath,
    JSON.stringify(claudeJson, null, 2) + "\n",
  )
  consola.success(`Updated ${claudeJsonPath}`)

  // Update $HOME/.claude/settings.json
  let settings: Record<string, unknown> = {}
  if (existsSync(settingsPath)) {
    try {
      const buffer = await fsPromises.readFile(settingsPath)
      settings = JSON.parse(buffer.toString()) as Record<string, unknown>
    } catch {
      consola.warn(`Failed to parse ${settingsPath}, creating new file`)
    }
  }

  // Set env configuration
  settings.env = {
    ...(settings.env as Record<string, string> | undefined),
    ANTHROPIC_BASE_URL: serverUrl,
    ANTHROPIC_AUTH_TOKEN: "copilot-api",
    ANTHROPIC_MODEL: model,
    ANTHROPIC_DEFAULT_SONNET_MODEL: model,
    ANTHROPIC_SMALL_FAST_MODEL: smallModel,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: smallModel,
    DISABLE_NON_ESSENTIAL_MODEL_CALLS: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    CLAUDE_CODE_ENABLE_TELEMETRY: "0",
  }

  await fsPromises.writeFile(
    settingsPath,
    JSON.stringify(settings, null, 2) + "\n",
  )
  consola.success(`Updated ${settingsPath}`)

  consola.box(
    `Claude Code configured!\n\n`
      + `Model: ${model}\n`
      + `Small Model: ${smallModel}\n`
      + `API URL: ${serverUrl}\n\n`
      + `Run 'claude' to start Claude Code.`,
  )
}

interface RunServerOptions {
  port: number
  host?: string
  verbose: boolean
  accountType: string
  manual: boolean
  // Adaptive rate limiting options (disabled if rateLimit is false)
  rateLimit: boolean
  retryInterval: number
  requestInterval: number
  recoveryTimeout: number
  consecutiveSuccesses: number
  githubToken?: string
  setupClaudeCode: boolean
  claudeModel?: string
  claudeSmallModel?: string
  showGitHubToken: boolean
  proxyEnv: boolean
  history: boolean
  historyLimit: number
  autoTruncate: boolean
  compressToolResults: boolean
  redirectAnthropic: boolean
  rewriteAnthropicTools: boolean
  securityResearchPassphrase?: string
}

export async function runServer(options: RunServerOptions): Promise<void> {
  // ===========================================================================
  // Phase 1: Logging Infrastructure
  // Must be first to ensure all subsequent logs use unified format
  // ===========================================================================
  initConsolaReporter()

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

  // Verify Security Research Mode passphrase if provided
  if (options.securityResearchPassphrase) {
    if (verifySecurityResearchPassphrase(options.securityResearchPassphrase)) {
      state.securityResearchMode = true
      consola.warn(
        "⚠️  Security Research Mode enabled - use responsibly for authorized testing only",
      )
    } else {
      consola.error("Invalid Security Research Mode passphrase")
      process.exit(1)
    }
  }

  // Log non-default configuration
  if (options.verbose) {
    consola.info("Verbose logging enabled")
  }
  if (options.accountType !== "individual") {
    consola.info(`Using ${options.accountType} plan GitHub account`)
  }
  if (!options.rateLimit) {
    consola.info("Rate limiting disabled")
  }
  if (!options.autoTruncate) {
    consola.info("Auto-truncate disabled")
  }
  if (options.compressToolResults) {
    consola.info("Tool result compression enabled")
  }
  if (options.redirectAnthropic) {
    consola.info("Anthropic API redirect enabled (using OpenAI translation)")
  }
  if (!options.rewriteAnthropicTools) {
    consola.info(
      "Anthropic server-side tools rewrite disabled (passing through unchanged)",
    )
  }

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

  initHistory(options.history, options.historyLimit)
  if (options.history) {
    const limitText =
      options.historyLimit === 0 ? "unlimited" : `max ${options.historyLimit}`
    consola.info(`History recording enabled (${limitText} entries)`)
  }

  // ===========================================================================
  // Phase 4: External Dependencies (filesystem, network)
  // ===========================================================================
  await ensurePaths()
  await cacheVSCodeVersion()

  // Initialize token management and authenticate
  await initTokenManagers({ cliToken: options.githubToken })

  // Fetch available models from Copilot API
  await cacheModels()

  consola.info(
    `Available models:\n${state.models?.data.map((m) => formatModelInfo(m)).join("\n")}`,
  )

  // ===========================================================================
  // Phase 5: Optional Setup (Claude Code configuration)
  // ===========================================================================
  const displayHost = options.host ?? "localhost"
  const serverUrl = `http://${displayHost}:${options.port}`

  if (options.setupClaudeCode) {
    invariant(state.models, "Models should be loaded by now")
    const availableModelIds = state.models.data.map((model) => model.id)

    let selectedModel: string
    let selectedSmallModel: string

    // Check if models are provided via CLI arguments
    if (options.claudeModel && options.claudeSmallModel) {
      // Validate the provided models exist
      if (!availableModelIds.includes(options.claudeModel)) {
        consola.error(
          `Invalid model: ${options.claudeModel}\nAvailable models: ${availableModelIds.join(", ")}`,
        )
        process.exit(1)
      }
      if (!availableModelIds.includes(options.claudeSmallModel)) {
        consola.error(
          `Invalid small model: ${options.claudeSmallModel}\nAvailable models: ${availableModelIds.join(", ")}`,
        )
        process.exit(1)
      }
      selectedModel = options.claudeModel
      selectedSmallModel = options.claudeSmallModel
    } else if (options.claudeModel || options.claudeSmallModel) {
      // Only one model provided - error
      consola.error(
        "Both --claude-model and --claude-small-model must be provided together, or neither for interactive selection",
      )
      process.exit(1)
    } else {
      // Interactive selection
      selectedModel = await consola.prompt(
        "Select a model to use with Claude Code",
        {
          type: "select",
          options: availableModelIds,
        },
      )

      selectedSmallModel = await consola.prompt(
        "Select a small model to use with Claude Code",
        {
          type: "select",
          options: availableModelIds,
        },
      )
    }

    // Setup Claude Code configuration files
    await setupClaudeCodeConfig(serverUrl, selectedModel, selectedSmallModel)
  }

  // ===========================================================================
  // Phase 6: Start Server
  // ===========================================================================
  // Initialize request tracker now that we're ready to handle requests
  initRequestTracker()

  consola.box(
    `🌐 Usage Viewer: https://ericc-ch.github.io/copilot-api?endpoint=${serverUrl}/usage${options.history ? `\n📜 History UI: ${serverUrl}/history` : ""}`,
  )

  serve({
    fetch: server.fetch as ServerHandler,
    port: options.port,
    hostname: options.host,
  })
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
        "Host/interface to bind to (e.g., 127.0.0.1 for localhost only, 0.0.0.0 for all interfaces)",
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
      description:
        "Seconds to wait before retrying after rate limit error (default: 10)",
    },
    "request-interval": {
      type: "string",
      default: "10",
      description:
        "Seconds between requests in rate-limited mode (default: 10)",
    },
    "recovery-timeout": {
      type: "string",
      default: "10",
      description:
        "Minutes before attempting to recover from rate-limited mode (default: 10)",
    },
    "consecutive-successes": {
      type: "string",
      default: "5",
      description:
        "Number of consecutive successes needed to recover from rate-limited mode (default: 5)",
    },
    "github-token": {
      alias: "g",
      type: "string",
      description:
        "Provide GitHub token directly (must be generated using the `auth` subcommand)",
    },
    "setup-claude-code": {
      type: "boolean",
      default: false,
      description:
        "Setup Claude Code config files to use Copilot API (interactive model selection)",
    },
    "claude-model": {
      type: "string",
      description:
        "Model to use with Claude Code (use with --setup-claude-code, skips interactive selection)",
    },
    "claude-small-model": {
      type: "string",
      description:
        "Small/fast model to use with Claude Code (use with --setup-claude-code, skips interactive selection)",
    },
    "show-github-token": {
      type: "boolean",
      default: false,
      description:
        "Show GitHub token in logs (use --verbose for Copilot token refresh logs)",
    },
    "proxy-env": {
      type: "boolean",
      default: false,
      description: "Initialize proxy from environment variables",
    },
    "no-history": {
      type: "boolean",
      default: false,
      description: "Disable request history recording and Web UI",
    },
    "history-limit": {
      type: "string",
      default: "1000",
      description:
        "Maximum number of history entries to keep in memory (0 = unlimited)",
    },
    "no-auto-truncate": {
      type: "boolean",
      default: false,
      description:
        "Disable automatic conversation history truncation when exceeding limits",
    },
    "compress-tool-results": {
      type: "boolean",
      default: false,
      description:
        "Compress old tool_result content before truncating messages (may lose context details)",
    },
    "redirect-anthropic": {
      type: "boolean",
      default: false,
      description:
        "Redirect Anthropic models through OpenAI translation (instead of direct API)",
    },
    "no-rewrite-anthropic-tools": {
      type: "boolean",
      default: false,
      description:
        "Don't rewrite Anthropic server-side tools (web_search, etc.) to custom tool format",
    },
    "security-research-mode": {
      type: "string",
      description:
        "Enable Security Research Mode with passphrase (for authorized penetration testing, CTF, and security education)",
    },
  },
  run({ args }) {
    // Check for unknown arguments
    const knownArgs = new Set([
      "_",
      "port",
      "p",
      "host",
      "H",
      "verbose",
      "v",
      "account-type",
      "a",
      "manual",
      "no-rate-limit",
      "retry-interval",
      "request-interval",
      "recovery-timeout",
      "consecutive-successes",
      "github-token",
      "g",
      "setup-claude-code",
      "claude-model",
      "claude-small-model",
      "show-github-token",
      "proxy-env",
      "no-history",
      "history-limit",
      "no-auto-truncate",
      "compress-tool-results",
      "redirect-anthropic",
      "no-rewrite-anthropic-tools",
      "security-research-mode",
    ])
    const unknownArgs = Object.keys(args).filter((key) => !knownArgs.has(key))
    if (unknownArgs.length > 0) {
      consola.warn(
        `Unknown argument(s): ${unknownArgs.map((a) => `--${a}`).join(", ")}`,
      )
    }

    return runServer({
      port: Number.parseInt(args.port, 10),
      host: args.host,
      verbose: args.verbose,
      accountType: args["account-type"],
      manual: args.manual,
      rateLimit: !args["no-rate-limit"],
      retryInterval: Number.parseInt(args["retry-interval"], 10),
      requestInterval: Number.parseInt(args["request-interval"], 10),
      recoveryTimeout: Number.parseInt(args["recovery-timeout"], 10),
      consecutiveSuccesses: Number.parseInt(args["consecutive-successes"], 10),
      githubToken: args["github-token"],
      setupClaudeCode: args["setup-claude-code"],
      claudeModel: args["claude-model"],
      claudeSmallModel: args["claude-small-model"],
      showGitHubToken: args["show-github-token"],
      proxyEnv: args["proxy-env"],
      history: !args["no-history"],
      historyLimit: Number.parseInt(args["history-limit"], 10),
      autoTruncate: !args["no-auto-truncate"],
      compressToolResults: args["compress-tool-results"],
      redirectAnthropic: args["redirect-anthropic"],
      rewriteAnthropicTools: !args["no-rewrite-anthropic-tools"],
      securityResearchPassphrase: args["security-research-mode"],
    })
  },
})
