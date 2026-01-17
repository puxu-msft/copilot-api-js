#!/usr/bin/env node

import { defineCommand } from "citty"
import clipboard from "clipboardy"
import consola from "consola"
import { serve, type ServerHandler } from "srvx"
import invariant from "tiny-invariant"

import type { Model } from "./services/copilot/get-models"

import { initHistory } from "./lib/history"
import { ensurePaths } from "./lib/paths"
import { initProxyFromEnv } from "./lib/proxy"
import { generateEnvScript } from "./lib/shell"
import { state } from "./lib/state"
import { setupCopilotToken, setupGitHubToken } from "./lib/token"
import { initTui } from "./lib/tui"
import { cacheModels, cacheVSCodeVersion } from "./lib/utils"
import { server } from "./server"

function formatModelInfo(model: Model): string {
  const limits = model.capabilities?.limits
  const contextK =
    limits?.max_prompt_tokens ?
      `${Math.round(limits.max_prompt_tokens / 1000)}k`
    : "?"
  const outputK =
    limits?.max_output_tokens ?
      `${Math.round(limits.max_output_tokens / 1000)}k`
    : "?"
  const features = [
    model.capabilities?.supports?.tool_calls && "tools",
    model.preview && "preview",
  ]
    .filter(Boolean)
    .join(", ")
  const featureStr = features ? ` (${features})` : ""
  return `  - ${model.id.padEnd(28)} context: ${contextK.padStart(5)}, output: ${outputK.padStart(4)}${featureStr}`
}

interface RunServerOptions {
  port: number
  host?: string
  verbose: boolean
  accountType: string
  manual: boolean
  rateLimit?: number
  rateLimitWait: boolean
  githubToken?: string
  claudeCode: boolean
  showToken: boolean
  proxyEnv: boolean
  history: boolean
  historyLimit: number
  autoCompact: boolean
}

export async function runServer(options: RunServerOptions): Promise<void> {
  if (options.proxyEnv) {
    initProxyFromEnv()
  }

  if (options.verbose) {
    consola.level = 5
    consola.info("Verbose logging enabled")
  }

  state.accountType = options.accountType
  if (options.accountType !== "individual") {
    consola.info(`Using ${options.accountType} plan GitHub account`)
  }

  state.manualApprove = options.manual
  state.rateLimitSeconds = options.rateLimit
  state.rateLimitWait = options.rateLimitWait
  state.showToken = options.showToken
  state.autoCompact = options.autoCompact

  if (options.autoCompact) {
    consola.info(
      "Auto-compact enabled: will compress context when exceeding token limits",
    )
  }

  // Initialize history recording if enabled
  initHistory(options.history, options.historyLimit)
  if (options.history) {
    const limitText =
      options.historyLimit === 0 ? "unlimited" : `max ${options.historyLimit}`
    consola.info(`History recording enabled (${limitText} entries)`)
  }

  // Initialize TUI for request logging
  initTui({ enabled: true })

  await ensurePaths()
  await cacheVSCodeVersion()

  if (options.githubToken) {
    state.githubToken = options.githubToken
    consola.info("Using provided GitHub token")
  } else {
    await setupGitHubToken()
  }

  await setupCopilotToken()
  await cacheModels()

  consola.info(
    `Available models:\n${state.models?.data.map((m) => formatModelInfo(m)).join("\n")}`,
  )

  const displayHost = options.host ?? "localhost"
  const serverUrl = `http://${displayHost}:${options.port}`

  if (options.claudeCode) {
    invariant(state.models, "Models should be loaded by now")

    const selectedModel = await consola.prompt(
      "Select a model to use with Claude Code",
      {
        type: "select",
        options: state.models.data.map((model) => model.id),
      },
    )

    const selectedSmallModel = await consola.prompt(
      "Select a small model to use with Claude Code",
      {
        type: "select",
        options: state.models.data.map((model) => model.id),
      },
    )

    const command = generateEnvScript(
      {
        ANTHROPIC_BASE_URL: serverUrl,
        ANTHROPIC_AUTH_TOKEN: "dummy",
        ANTHROPIC_MODEL: selectedModel,
        ANTHROPIC_DEFAULT_SONNET_MODEL: selectedModel,
        ANTHROPIC_SMALL_FAST_MODEL: selectedSmallModel,
        ANTHROPIC_DEFAULT_HAIKU_MODEL: selectedSmallModel,
        DISABLE_NON_ESSENTIAL_MODEL_CALLS: "1",
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      },
      "claude",
    )

    try {
      clipboard.writeSync(command)
      consola.success("Copied Claude Code command to clipboard!")
    } catch {
      consola.warn(
        "Failed to copy to clipboard. Here is the Claude Code command:",
      )
      consola.log(command)
    }
  }

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
    "rate-limit": {
      alias: "r",
      type: "string",
      description: "Rate limit in seconds between requests",
    },
    wait: {
      alias: "w",
      type: "boolean",
      default: false,
      description:
        "Wait instead of error when rate limit is hit. Has no effect if rate limit is not set",
    },
    "github-token": {
      alias: "g",
      type: "string",
      description:
        "Provide GitHub token directly (must be generated using the `auth` subcommand)",
    },
    "claude-code": {
      alias: "c",
      type: "boolean",
      default: false,
      description:
        "Generate a command to launch Claude Code with Copilot API config",
    },
    "show-token": {
      type: "boolean",
      default: false,
      description: "Show GitHub and Copilot tokens on fetch and refresh",
    },
    "proxy-env": {
      type: "boolean",
      default: false,
      description: "Initialize proxy from environment variables",
    },
    history: {
      type: "boolean",
      default: false,
      description: "Enable request history recording and Web UI at /history",
    },
    "history-limit": {
      type: "string",
      default: "1000",
      description:
        "Maximum number of history entries to keep in memory (0 = unlimited)",
    },
    "auto-compact": {
      type: "boolean",
      default: false,
      description:
        "Automatically compress conversation history when exceeding model token limits",
    },
  },
  run({ args }) {
    const rateLimitRaw = args["rate-limit"]
    const rateLimit =
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      rateLimitRaw === undefined ? undefined : Number.parseInt(rateLimitRaw, 10)

    return runServer({
      port: Number.parseInt(args.port, 10),
      host: args.host,
      verbose: args.verbose,
      accountType: args["account-type"],
      manual: args.manual,
      rateLimit,
      rateLimitWait: args.wait,
      githubToken: args["github-token"],
      claudeCode: args["claude-code"],
      showToken: args["show-token"],
      proxyEnv: args["proxy-env"],
      history: args.history,
      historyLimit: Number.parseInt(args["history-limit"], 10),
      autoCompact: args["auto-compact"],
    })
  },
})
