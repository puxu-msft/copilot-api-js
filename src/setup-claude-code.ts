import { defineCommand } from "citty"
import consola from "consola"
import {
  //
  existsSync,
  promises as fsPromises,
} from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import invariant from "tiny-invariant"

import { applyConfigToState } from "./lib/config/config"
import { ensurePaths } from "./lib/config/paths"
import { cacheVSCodeVersion } from "./lib/copilot-api"
import {
  //
  cacheModels,
  type Model,
} from "./lib/models/client"
import { initProxy } from "./lib/proxy"
import {
  //
  setCliState,
  state,
} from "./lib/state"
import { initTokenManagers } from "./lib/token"

/**
 * 1M-context band: Claude Code switches to its 1M-context client path only
 * when `ANTHROPIC_MODEL` ends with `[1m]`. The band edges (not hard caps)
 * bracket real 1M models, which advertise ~900K–1M input tokens. Future 2M+
 * tiers should get their own band rather than widening this one.
 */
const CLAUDE_CODE_1M_BAND_LOW = 800_000
const CLAUDE_CODE_1M_BAND_HIGH = 1_500_000
const CLAUDE_MODEL_1M_SUFFIX = "[1m]"

/**
 * Append `[1m]` to model IDs whose advertised `max_prompt_tokens` falls in
 * the 1M tier (800K–1.5M). Claude Code keys its 1M-context client path off
 * this suffix in `ANTHROPIC_MODEL`; without it, even a 1M-capable model runs
 * the 200K compaction strategy. No-op for IDs already carrying the suffix or
 * for models below/above the band.
 */
export function withClaudeCode1mSuffix(modelId: string, maxPromptTokens?: number): string {
  if (modelId.endsWith(CLAUDE_MODEL_1M_SUFFIX)) return modelId
  if (!maxPromptTokens || maxPromptTokens <= CLAUDE_CODE_1M_BAND_LOW) return modelId
  if (maxPromptTokens >= CLAUDE_CODE_1M_BAND_HIGH) return modelId
  return `${modelId}${CLAUDE_MODEL_1M_SUFFIX}`
}

/** Read advertised prompt-token limit, or `undefined` when unknown. */
function getMaxPromptTokens(model: Model): number | undefined {
  return model.capabilities?.limits?.max_prompt_tokens
}

/**
 * Build the Claude Code `settings.env` block from resolved Model objects.
 *
 * Pure function: no fs/network. Caller passes the merged existing env so
 * user-customized keys (e.g. `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`)
 * are preserved.
 *
 * - Applies `[1m]` suffix to all model env vars based on each model's own limits.
 * - Explicitly omits the deprecated `ANTHROPIC_SMALL_FAST_MODEL` key so re-running
 *   setup cleans up old configs.
 * - Uses the main model's prompt-token limit for `CLAUDE_CODE_AUTO_COMPACT_WINDOW`
 *   (the main model dominates the conversation; small model only runs short
 *   summarizer calls).
 */
export function buildClaudeCodeEnv(
  serverUrl: string,
  model: Model,
  smallModel: Model,
  existingEnv: Record<string, string> = {},
): Record<string, string> {
  const mainMax = getMaxPromptTokens(model)
  const smallMax = getMaxPromptTokens(smallModel)

  // Preserve user-customized auth token if set; fallback to placeholder.
  const authToken = existingEnv.ANTHROPIC_AUTH_TOKEN || "copilot-api"

  // Default 85 leaves a 15% margin before the model rejects oversized prompts.
  const autoCompactPct = existingEnv.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE || "85"

  // Strip the deprecated key from carry-over env (Claude Code replaced it
  // with ANTHROPIC_DEFAULT_HAIKU_MODEL). Pulling it here ensures it cannot
  // sneak back via the `...existingEnv` spread below.
  const { ANTHROPIC_SMALL_FAST_MODEL: _deprecated, ...carryOver } = existingEnv

  const mainModelId = withClaudeCode1mSuffix(model.id, mainMax)
  const smallModelId = withClaudeCode1mSuffix(smallModel.id, smallMax)

  return {
    ...carryOver,
    ANTHROPIC_BASE_URL: serverUrl,
    ANTHROPIC_AUTH_TOKEN: authToken,
    ANTHROPIC_MODEL: mainModelId,
    ANTHROPIC_DEFAULT_SONNET_MODEL: mainModelId,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: smallModelId,
    DISABLE_NON_ESSENTIAL_MODEL_CALLS: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    CLAUDE_CODE_ENABLE_TELEMETRY: "0",
    // Disable the upstream x-anthropic-billing-header which breaks prompt
    // caching on non-Anthropic gateways like Copilot.
    CLAUDE_CODE_ATTRIBUTION_HEADER: "0",
    CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: autoCompactPct,
    ...(mainMax ? { CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(mainMax) } : {}),
  }
}

/**
 * Write Claude Code configuration files for use with Copilot API.
 * Creates/updates:
 * - $HOME/.claude.json - Sets hasCompletedOnboarding: true
 * - $HOME/.claude/settings.json - Sets env variables for Copilot API
 */
export async function writeClaudeCodeConfig(serverUrl: string, model: Model, smallModel: Model): Promise<void> {
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
  await fsPromises.writeFile(claudeJsonPath, JSON.stringify(claudeJson, null, 2) + "\n")
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

  const existingEnv = (settings.env as Record<string, string> | undefined) ?? {}
  settings.env = buildClaudeCodeEnv(serverUrl, model, smallModel, existingEnv)

  await fsPromises.writeFile(settingsPath, JSON.stringify(settings, null, 2) + "\n")
  consola.success(`Updated ${settingsPath}`)

  const env = settings.env as Record<string, string>
  consola.box(
    `Claude Code configured!\n\n`
      + `Model: ${env.ANTHROPIC_MODEL}\n`
      + `Small Model: ${env.ANTHROPIC_DEFAULT_HAIKU_MODEL}\n`
      + `API URL: ${serverUrl}\n\n`
      + `Run 'claude' to start Claude Code.`,
  )
}

interface SetupClaudeCodeOptions {
  port: number
  host?: string
  model?: string
  smallModel?: string
  accountType: "individual" | "business" | "enterprise"
  githubToken?: string
  verbose: boolean
}

/** Resolve a model id to its Model object, exiting with a clear error if missing. */
function resolveModelOrExit(modelId: string, models: ReadonlyArray<Model>, label: string): Model {
  const found = models.find((m) => m.id === modelId)
  if (!found) {
    const available = models.map((m) => m.id).join(", ")
    consola.error(`Invalid ${label}: ${modelId}\nAvailable models: ${available}`)
    process.exit(1)
  }
  return found
}

export async function runSetupClaudeCode(options: SetupClaudeCodeOptions): Promise<void> {
  if (options.verbose) {
    consola.level = 5
    consola.info("Verbose logging enabled")
  }

  setCliState({ accountType: options.accountType })

  // Load config and initialize proxy before any network requests
  await ensurePaths()
  const config = await applyConfigToState()
  if (config.proxy) {
    initProxy({ url: config.proxy, fromEnv: false })
  } else {
    initProxy({ url: undefined, fromEnv: true })
  }

  // Authenticate and fetch models
  await cacheVSCodeVersion()
  await initTokenManagers({ cliToken: options.githubToken })
  await cacheModels()

  invariant(state.models, "Models should be loaded by now")
  const availableModels = state.models.data
  const availableModelIds = availableModels.map((m) => m.id)

  let selectedModel: Model
  let selectedSmallModel: Model

  if (options.model && options.smallModel) {
    selectedModel = resolveModelOrExit(options.model, availableModels, "model")
    selectedSmallModel = resolveModelOrExit(options.smallModel, availableModels, "small model")
  } else if (options.model || options.smallModel) {
    consola.error("Both --model and --small-model must be provided together, or neither for interactive selection")
    process.exit(1)
  } else {
    // Interactive selection — prompt with bare ids (preserves existing UX),
    // then resolve to Model objects.
    const mainId = await consola.prompt("Select a model to use with Claude Code", {
      type: "select",
      options: availableModelIds,
    })

    const smallId = await consola.prompt("Select a small model to use with Claude Code", {
      type: "select",
      options: availableModelIds,
    })

    selectedModel = resolveModelOrExit(mainId, availableModels, "model")
    selectedSmallModel = resolveModelOrExit(smallId, availableModels, "small model")
  }

  const displayHost = options.host ?? "localhost"
  const serverUrl = `http://${displayHost}:${options.port}`

  await writeClaudeCodeConfig(serverUrl, selectedModel, selectedSmallModel)
}

export const setupClaudeCode = defineCommand({
  meta: {
    name: "setup-claude-code",
    description: "Setup Claude Code configuration files to use Copilot API as backend",
  },
  args: {
    port: {
      alias: "p",
      type: "string",
      default: "4141",
      description: "Port the Copilot API server will run on",
    },
    host: {
      alias: "H",
      type: "string",
      description: "Host the Copilot API server will bind to (default: localhost)",
    },
    model: {
      alias: "m",
      type: "string",
      description: "Model to use with Claude Code (skips interactive selection, requires --small-model)",
    },
    "small-model": {
      alias: "s",
      type: "string",
      description: "Small/fast model to use with Claude Code (skips interactive selection, requires --model)",
    },
    "account-type": {
      alias: "a",
      type: "string",
      default: "individual",
      description: "Account type to use (individual, business, enterprise)",
    },
    "github-token": {
      alias: "g",
      type: "string",
      description: "Provide GitHub token directly (must be generated using the `auth` subcommand)",
    },
    verbose: {
      alias: "v",
      type: "boolean",
      default: false,
      description: "Enable verbose logging",
    },
  },
  run({ args }) {
    return runSetupClaudeCode({
      port: Number.parseInt(args.port, 10),
      host: args.host,
      model: args.model,
      smallModel: args["small-model"],
      accountType: args["account-type"] as "individual" | "business" | "enterprise",
      githubToken: args["github-token"],
      verbose: args.verbose,
    })
  },
})
