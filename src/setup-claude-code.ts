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

/** Env keys Claude Code no longer uses — always stripped so re-running cleans up. */
const DEPRECATED_ENV_KEYS = ["ANTHROPIC_SMALL_FAST_MODEL"] as const

/**
 * Essential env vars — the minimum needed for Claude Code to talk to the
 * Copilot API proxy. Always written. Preserves a user-customized
 * `ANTHROPIC_AUTH_TOKEN` if present.
 */
export function buildEssentialEnv(serverUrl: string, model: Model, smallModel: Model, existingEnv: Record<string, string> = {}): Record<string, string> {
  const mainModelId = withClaudeCode1mSuffix(model.id, getMaxPromptTokens(model))
  const smallModelId = withClaudeCode1mSuffix(smallModel.id, getMaxPromptTokens(smallModel))
  return {
    ANTHROPIC_BASE_URL: serverUrl,
    // Preserve user-customized auth token if set; fallback to placeholder.
    ANTHROPIC_AUTH_TOKEN: existingEnv.ANTHROPIC_AUTH_TOKEN || "copilot-api",
    ANTHROPIC_MODEL: mainModelId,
    ANTHROPIC_DEFAULT_SONNET_MODEL: mainModelId,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: smallModelId,
  }
}

/**
 * Opinionated extension env vars — telemetry off, prompt-cache header,
 * auto-compact tuning. These are recommendations, not requirements, so they
 * are only written when explicitly opted in (`--with-extras`). Any of these
 * the user has already set are preserved regardless (see `buildClaudeCodeEnv`).
 */
export function buildExtensionEnv(model: Model, existingEnv: Record<string, string> = {}): Record<string, string> {
  const mainMax = getMaxPromptTokens(model)
  return {
    DISABLE_NON_ESSENTIAL_MODEL_CALLS: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    CLAUDE_CODE_ENABLE_TELEMETRY: "0",
    // Disable the upstream x-anthropic-billing-header which breaks prompt
    // caching on non-Anthropic gateways like Copilot.
    CLAUDE_CODE_ATTRIBUTION_HEADER: "0",
    // Default 85 leaves a 15% margin before the model rejects oversized prompts.
    CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: existingEnv.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE || "85",
    ...(mainMax ? { CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(mainMax) } : {}),
  }
}

/**
 * Build the Claude Code `settings.env` block from resolved Model objects.
 *
 * Pure function: no fs/network. Respects existing config — user-set keys are
 * carried over untouched; only the deprecated keys are dropped and the
 * essential keys (+ extensions when `includeExtensions`) are set.
 */
export function buildClaudeCodeEnv(
  serverUrl: string,
  model: Model,
  smallModel: Model,
  existingEnv: Record<string, string> = {},
  options: { includeExtensions?: boolean } = {},
): Record<string, string> {
  // Carry over the user's existing env, minus deprecated keys.
  const deprecated = new Set<string>(DEPRECATED_ENV_KEYS)
  const carryOver = Object.fromEntries(Object.entries(existingEnv).filter(([key]) => !deprecated.has(key)))

  return {
    ...carryOver,
    ...buildEssentialEnv(serverUrl, model, smallModel, existingEnv),
    ...(options.includeExtensions ? buildExtensionEnv(model, existingEnv) : {}),
  }
}

/** A single proposed env-var change (a value of `undefined` means removed). */
interface EnvChange {
  key: string
  before: string | undefined
  after: string | undefined
}

/** Partitioned changes between an existing env block and the proposed one. */
export interface EnvChangeSet {
  added: Array<EnvChange>
  changed: Array<EnvChange>
  removed: Array<EnvChange>
}

/** Diff the proposed env against the existing one, partitioned by change kind. */
export function computeEnvChanges(before: Record<string, string>, after: Record<string, string>): EnvChangeSet {
  const added: Array<EnvChange> = []
  const changed: Array<EnvChange> = []
  const removed: Array<EnvChange> = []

  for (const key of Object.keys(after)) {
    if (!(key in before)) added.push({ key, before: undefined, after: after[key] })
    else if (before[key] !== after[key]) changed.push({ key, before: before[key], after: after[key] })
  }
  for (const key of Object.keys(before)) {
    if (!(key in after)) removed.push({ key, before: before[key], after: undefined })
  }

  return { added, changed, removed }
}

/** True when the change set would alter anything. */
export function hasEnvChanges(changes: EnvChangeSet): boolean {
  return changes.added.length > 0 || changes.changed.length > 0 || changes.removed.length > 0
}

/** True when the change set overwrites or deletes an existing user value. */
function isDestructive(changes: EnvChangeSet): boolean {
  return changes.changed.length > 0 || changes.removed.length > 0
}

/** Render a change set as an intuitive `+ / ~ / -` description. */
export function formatEnvChanges(changes: EnvChangeSet): string {
  const lines: Array<string> = []
  for (const { key, after } of changes.added) lines.push(`  + ${key} = ${after}`)
  for (const { key, before, after } of changes.changed) lines.push(`  ~ ${key}: ${before} → ${after}`)
  for (const { key } of changes.removed) lines.push(`  - ${key}  (removed)`)
  return lines.join("\n")
}

/** Options for `writeClaudeCodeConfig` — also the seam tests use for isolation. */
export interface WriteClaudeCodeConfigOptions {
  /** Home directory to write into. Defaults to `os.homedir()`. Tests pass a temp dir. */
  home?: string
  /** Write the opinionated extension env vars too. Default `false`. */
  includeExtensions?: boolean
  /**
   * Decide whether to apply destructive changes (overwrites/removals of
   * existing keys). Called only when such changes exist. Defaults to an
   * interactive y/N prompt. Tests inject a deterministic decision.
   */
  confirm?: () => Promise<boolean>
}

/**
 * Write Claude Code configuration for use with Copilot API.
 *
 * Respects existing config: existing settings are merged (not clobbered), the
 * proposed change set is shown before writing, and when the change would
 * overwrite or delete keys the user already has, confirmation is requested
 * first. Updates:
 * - `$HOME/.claude.json` — sets `hasCompletedOnboarding: true`
 * - `$HOME/.claude/settings.json` — sets the essential env (+ extensions if opted in)
 */
export async function writeClaudeCodeConfig(serverUrl: string, model: Model, smallModel: Model, options: WriteClaudeCodeConfigOptions = {}): Promise<void> {
  const home = options.home ?? homedir()
  const claudeJsonPath = join(home, ".claude.json")
  const claudeDir = join(home, ".claude")
  const settingsPath = join(claudeDir, "settings.json")

  // Read existing config (respect it — never assume a blank slate).
  const claudeJson = await readJsonOrEmpty(claudeJsonPath)
  const settings = await readJsonOrEmpty(settingsPath)
  const existingEnv = (settings.env as Record<string, string> | undefined) ?? {}

  const proposedEnv = buildClaudeCodeEnv(serverUrl, model, smallModel, existingEnv, {
    includeExtensions: options.includeExtensions,
  })
  const changes = computeEnvChanges(existingEnv, proposedEnv)
  const onboardingChange = claudeJson.hasCompletedOnboarding !== true

  if (!hasEnvChanges(changes) && !onboardingChange) {
    consola.success("Claude Code already configured for Copilot API — no changes needed.")
    return
  }

  // Show an intuitive description of exactly what will change.
  if (hasEnvChanges(changes)) {
    consola.info(`Claude Code env changes (${settingsPath}):\n${formatEnvChanges(changes)}`)
  }
  if (onboardingChange) {
    consola.info(`${claudeJsonPath}: set hasCompletedOnboarding = true`)
  }

  // Only gate on confirmation when we would overwrite/remove existing keys —
  // pure additions are non-destructive and applied directly.
  if (isDestructive(changes)) {
    const confirm = options.confirm ?? (() => consola.prompt("Apply these changes?", { type: "confirm" }))
    const approved = await confirm()
    if (!approved) {
      consola.info("Aborted — no changes written.")
      return
    }
  }

  if (!existsSync(claudeDir)) {
    await fsPromises.mkdir(claudeDir, { recursive: true })
    consola.info(`Created directory: ${claudeDir}`)
  }

  claudeJson.hasCompletedOnboarding = true
  await fsPromises.writeFile(claudeJsonPath, JSON.stringify(claudeJson, null, 2) + "\n")
  consola.success(`Updated ${claudeJsonPath}`)

  settings.env = proposedEnv
  await fsPromises.writeFile(settingsPath, JSON.stringify(settings, null, 2) + "\n")
  consola.success(`Updated ${settingsPath}`)

  consola.box(
    `Claude Code configured!\n\n`
      + `Model: ${proposedEnv.ANTHROPIC_MODEL}\n`
      + `Small Model: ${proposedEnv.ANTHROPIC_DEFAULT_HAIKU_MODEL}\n`
      + `API URL: ${serverUrl}\n\n`
      + `Run 'claude' to start Claude Code.`,
  )
}

/** Read+parse a JSON object file, returning `{}` when missing or unparseable. */
async function readJsonOrEmpty(path: string): Promise<Record<string, unknown>> {
  if (!existsSync(path)) return {}
  try {
    const buffer = await fsPromises.readFile(path)
    return JSON.parse(buffer.toString()) as Record<string, unknown>
  } catch {
    consola.warn(`Failed to parse ${path}, treating as empty`)
    return {}
  }
}

interface SetupClaudeCodeOptions {
  port: number
  host?: string
  model?: string
  smallModel?: string
  accountType: "individual" | "business" | "enterprise"
  githubToken?: string
  verbose: boolean
  /** Also write the opinionated extension env vars. */
  withExtras: boolean
  /** Skip the confirmation prompt for destructive changes. */
  yes: boolean
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

  await writeClaudeCodeConfig(serverUrl, selectedModel, selectedSmallModel, {
    includeExtensions: options.withExtras,
    // `--yes` auto-approves destructive changes; otherwise the default
    // interactive prompt is used.
    confirm: options.yes ? () => Promise.resolve(true) : undefined,
  })
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
    "with-extras": {
      alias: "e",
      type: "boolean",
      default: false,
      description: "Also write opinionated extension env vars (telemetry off, auto-compact tuning, prompt-cache header)",
    },
    yes: {
      alias: "y",
      type: "boolean",
      default: false,
      description: "Skip the confirmation prompt when overwriting existing config",
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
      withExtras: args["with-extras"],
      yes: args.yes,
    })
  },
})
