import { defineCommand } from "citty"
import consola from "consola"
import { existsSync, promises as fsPromises } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import invariant from "tiny-invariant"

import { ensurePaths } from "./lib/config/paths"
import { cacheVSCodeVersion } from "./lib/copilot-api"
import { cacheModels } from "./lib/models/client"
import { state } from "./lib/state"
import { initTokenManagers } from "./lib/token"

/**
 * Write Claude Code configuration files for use with Copilot API.
 * Creates/updates:
 * - $HOME/.claude.json - Sets hasCompletedOnboarding: true
 * - $HOME/.claude/settings.json - Sets env variables for Copilot API
 */
export async function writeClaudeCodeConfig(serverUrl: string, model: string, smallModel: string): Promise<void> {
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

  await fsPromises.writeFile(settingsPath, JSON.stringify(settings, null, 2) + "\n")
  consola.success(`Updated ${settingsPath}`)

  consola.box(
    `Claude Code configured!\n\n`
      + `Model: ${model}\n`
      + `Small Model: ${smallModel}\n`
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

export async function runSetupClaudeCode(options: SetupClaudeCodeOptions): Promise<void> {
  if (options.verbose) {
    consola.level = 5
    consola.info("Verbose logging enabled")
  }

  state.accountType = options.accountType

  // Authenticate and fetch models
  await ensurePaths()
  await cacheVSCodeVersion()
  await initTokenManagers({ cliToken: options.githubToken })
  await cacheModels()

  invariant(state.models, "Models should be loaded by now")
  const availableModelIds = state.models.data.map((m) => m.id)

  let selectedModel: string
  let selectedSmallModel: string

  if (options.model && options.smallModel) {
    // Validate the provided models exist
    if (!availableModelIds.includes(options.model)) {
      consola.error(`Invalid model: ${options.model}\nAvailable models: ${availableModelIds.join(", ")}`)
      process.exit(1)
    }
    if (!availableModelIds.includes(options.smallModel)) {
      consola.error(`Invalid small model: ${options.smallModel}\nAvailable models: ${availableModelIds.join(", ")}`)
      process.exit(1)
    }
    selectedModel = options.model
    selectedSmallModel = options.smallModel
  } else if (options.model || options.smallModel) {
    consola.error("Both --model and --small-model must be provided together, or neither for interactive selection")
    process.exit(1)
  } else {
    // Interactive selection
    selectedModel = await consola.prompt("Select a model to use with Claude Code", {
      type: "select",
      options: availableModelIds,
    })

    selectedSmallModel = await consola.prompt("Select a small model to use with Claude Code", {
      type: "select",
      options: availableModelIds,
    })
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
