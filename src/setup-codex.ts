import { defineCommand } from "citty"
import consola from "consola"
import { promises as fsPromises } from "node:fs"
import { dirname } from "node:path"
import invariant from "tiny-invariant"

import { atomicWriteText } from "~/lib/atomic-fs"

import { applyCodexConfig } from "./lib/codex-config"
import { applyConfigToState } from "./lib/config/config"
import {
  //
  ensurePaths,
  PATHS,
} from "./lib/config/paths"
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

/** Preferred order when auto-selecting a default reasoning effort from a model's capabilities. */
const EFFORT_PREFERENCE = ["high", "medium", "low", "minimal", "xhigh", "max"] as const

/** Read a model's advertised reasoning-effort levels (string array), or `undefined`. */
function getReasoningEfforts(model: Model): ReadonlyArray<string> | undefined {
  const value = model.capabilities?.supports?.reasoning_effort
  return Array.isArray(value) && value.every((x) => typeof x === "string") ? value : undefined
}

/**
 * Pick a default reasoning effort for a model: the first preferred level the
 * model advertises, falling back to its first advertised level. Returns
 * `undefined` when the model exposes no reasoning-effort levels.
 */
function pickDefaultEffort(model: Model): string | undefined {
  const efforts = getReasoningEfforts(model)
  if (!efforts || efforts.length === 0) return undefined
  for (const preferred of EFFORT_PREFERENCE) {
    if (efforts.includes(preferred)) return preferred
  }
  return efforts[0]
}

/** Read existing file content, returning empty string when missing or unreadable. */
async function readTextOrEmpty(path: string): Promise<string> {
  try {
    return await fsPromises.readFile(path, "utf8")
  } catch {
    // Missing or unreadable — treat as empty so we never overwrite content we
    // could not parse; applyCodexConfig operates on the empty baseline.
    return ""
  }
}

/** Inputs for {@link writeCodexConfig}. */
export interface WriteCodexConfigInput {
  /** Absolute path to the Codex `config.toml` to update (injected for testability). */
  configPath: string
  /** Proxy base URL with the `/v1` suffix Codex expects. */
  baseUrl: string
  /** Model id to write as the user-owned default. */
  model: string
  /** Reasoning effort to write as a user-owned scalar (omitted when undefined). */
  modelReasoningEffort?: string
}

/** Outcome of {@link writeCodexConfig}. */
export interface WriteCodexConfigResult {
  /** Whether the file content changed (false → no write performed). */
  changed: boolean
  /** The content now on disk (or already present when unchanged). */
  content: string
}

/**
 * Read → apply the managed block → atomically write `config.toml`. Pure of any
 * global path state (the caller injects `configPath`), so it is unit-testable
 * against a temp dir without ever touching the real `~/.codex`. Skips the write
 * entirely when `applyCodexConfig` reports no change (idempotent).
 */
export async function writeCodexConfig(input: WriteCodexConfigInput): Promise<WriteCodexConfigResult> {
  const existingContent = await readTextOrEmpty(input.configPath)
  const { content, changed } = applyCodexConfig({
    baseUrl: input.baseUrl,
    existingContent,
    model: input.model,
    modelReasoningEffort: input.modelReasoningEffort,
  })
  if (!changed) return { changed: false, content: existingContent }

  await fsPromises.mkdir(dirname(input.configPath), { recursive: true })
  await atomicWriteText(input.configPath, content)
  return { changed: true, content }
}

/** Options for {@link runSetupCodex}. */
interface SetupCodexOptions {
  port: number
  host?: string
  model?: string
  effort?: string
  accountType: "individual" | "business" | "enterprise"
  githubToken?: string
  verbose: boolean
}

/** Resolve a model id to its Model object, exiting with a clear error if missing. */
function resolveModelOrExit(modelId: string, models: ReadonlyArray<Model>): Model {
  const found = models.find((m) => m.id === modelId)
  if (!found) {
    const available = models.map((m) => m.id).join(", ")
    consola.error(`Invalid model: ${modelId}\nAvailable models: ${available}`)
    process.exit(1)
  }
  return found
}

/**
 * Write Codex CLI configuration (`~/.codex/config.toml`) so it routes through
 * the Copilot API proxy. Reuses the standard model-resolution chain to fetch
 * available models, then applies the managed block via {@link applyCodexConfig}.
 */
export async function runSetupCodex(options: SetupCodexOptions): Promise<void> {
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
  if (options.model) {
    selectedModel = resolveModelOrExit(options.model, availableModels)
  } else {
    const id = await consola.prompt("Select a model to use with Codex", {
      type: "select",
      options: availableModelIds,
    })
    selectedModel = resolveModelOrExit(id, availableModels)
  }

  const effort = options.effort ?? pickDefaultEffort(selectedModel)

  // Codex expects the `/v1` suffix on the provider base_url.
  const displayHost = options.host ?? "localhost"
  const baseUrl = `http://${displayHost}:${options.port}/v1`

  const configPath = PATHS.CODEX_CONFIG_TOML
  const { changed } = await writeCodexConfig({
    configPath,
    baseUrl,
    model: selectedModel.id,
    modelReasoningEffort: effort,
  })

  if (!changed) {
    consola.success(`Codex already configured for Copilot API — no changes needed (${configPath}).`)
    return
  }
  consola.success(`Updated ${configPath}`)

  consola.box(
    `Codex configured!\n\n`
      + `Model: ${selectedModel.id}\n`
      + `Reasoning effort: ${effort ?? "(model default)"}\n`
      + `Base URL: ${baseUrl}\n\n`
      + `Run 'codex' to start Codex CLI.`,
  )
}

export const setupCodex = defineCommand({
  meta: {
    name: "setup-codex",
    description: "Setup Codex CLI configuration (~/.codex/config.toml) to use Copilot API as backend",
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
      description: "Model to use with Codex (skips interactive selection)",
    },
    effort: {
      alias: "e",
      type: "string",
      description: "Reasoning effort to write (default: derived from the model's capabilities)",
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
    return runSetupCodex({
      port: Number.parseInt(args.port, 10),
      host: args.host,
      model: args.model,
      effort: args.effort,
      accountType: args["account-type"] as "individual" | "business" | "enterprise",
      githubToken: args["github-token"],
      verbose: args.verbose,
    })
  },
})
