import { defineCommand } from "citty"
import consola from "consola"
import {
  //
  existsSync,
  promises as fsPromises,
} from "node:fs"
import { homedir } from "node:os"
import {
  //
  dirname,
  join,
} from "node:path"
import invariant from "tiny-invariant"

import { applyConfigToState } from "~/lib/config/config"
import { ensurePaths } from "~/lib/config/paths"
import { cacheVSCodeVersion } from "~/lib/copilot-api"
import {
  //
  cacheModels,
  type Model,
} from "~/lib/models/client"
import { initProxy } from "~/lib/proxy"
import {
  //
  setCliState,
  state,
} from "~/lib/state"
import { initTokenManagers } from "~/lib/token"

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

// ============================================================================
// Generic JSON leaf-path diff (pure)
//
// The setup writes real JSON files, so the diff must reflect the actual bytes
// that will land. We walk both the existing object and the proposed final
// object down to their leaves (primitives and arrays; plain objects are
// recursed into) and partition every differing leaf path into added / changed
// / removed. This is target-file agnostic: `.claude.json` renders
// `hasCompletedOnboarding`, `settings.json` renders `env.ANTHROPIC_MODEL`, etc.
// ============================================================================

/** A plain JSON object (recursed into during the leaf walk). */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * Collect every leaf of `obj` into `out`, keyed by dotted path. Plain objects
 * are recursed into; arrays and primitives are treated as leaf values (arrays
 * compared as a whole — element order is significant). An empty object
 * contributes no leaf, so pruning all of an object's keys surfaces as removals.
 */
function collectLeaves(obj: Record<string, unknown>, prefix: string, out: Map<string, unknown>): void {
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key
    if (isPlainObject(value)) collectLeaves(value, path, out)
    else out.set(path, value)
  }
}

/** Structural equality for leaf values (primitives / arrays), order-sensitive. */
function leafEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/** A single JSON leaf-path change. `before`/`after` absent means added/removed. */
export interface JsonLeafChange {
  path: string
  before?: unknown
  after?: unknown
}

/** Leaf-path changes between an existing object and the proposed one. */
export interface JsonDiff {
  added: Array<JsonLeafChange>
  changed: Array<JsonLeafChange>
  removed: Array<JsonLeafChange>
}

/** Diff two JSON objects at leaf-path granularity, partitioned by change kind. */
export function computeJsonDiff(before: Record<string, unknown>, after: Record<string, unknown>): JsonDiff {
  const beforeLeaves = new Map<string, unknown>()
  const afterLeaves = new Map<string, unknown>()
  collectLeaves(before, "", beforeLeaves)
  collectLeaves(after, "", afterLeaves)

  const added: Array<JsonLeafChange> = []
  const changed: Array<JsonLeafChange> = []
  const removed: Array<JsonLeafChange> = []

  for (const [path, afterValue] of afterLeaves) {
    if (!beforeLeaves.has(path)) added.push({ path, after: afterValue })
    else if (!leafEqual(beforeLeaves.get(path), afterValue)) changed.push({ path, before: beforeLeaves.get(path), after: afterValue })
  }
  for (const [path, beforeValue] of beforeLeaves) {
    if (!afterLeaves.has(path)) removed.push({ path, before: beforeValue })
  }

  const byPath = (x: JsonLeafChange, y: JsonLeafChange): number => x.path.localeCompare(y.path)
  added.sort(byPath)
  changed.sort(byPath)
  removed.sort(byPath)
  return { added, changed, removed }
}

/** True when the diff would alter anything. */
export function hasJsonDiff(diff: JsonDiff): boolean {
  return diff.added.length > 0 || diff.changed.length > 0 || diff.removed.length > 0
}

/** Max rendered length of a single leaf value before truncation. */
const DIFF_VALUE_MAX_LEN = 80

/**
 * Render a leaf value as compact JSON, truncated when long. Leaf values come
 * from parsed JSON (primitives and arrays), so `JSON.stringify` always yields a
 * string here — never `undefined`.
 */
function formatLeafValue(value: unknown): string {
  const text = JSON.stringify(value)
  return text.length > DIFF_VALUE_MAX_LEN ? `${text.slice(0, DIFF_VALUE_MAX_LEN)}...` : text
}

/** Render a diff as an intuitive `+ / ~ / -` block (empty string when no changes). */
export function formatJsonDiff(diff: JsonDiff): string {
  const lines: Array<string> = []
  for (const { path, after } of diff.added) lines.push(`  + ${path}: ${formatLeafValue(after)}`)
  for (const { path, before, after } of diff.changed) lines.push(`  ~ ${path}: ${formatLeafValue(before)} → ${formatLeafValue(after)}`)
  for (const { path, before } of diff.removed) lines.push(`  - ${path}: ${formatLeafValue(before)}`)
  return lines.join("\n")
}

// ============================================================================
// Write-decision (pure)
// ============================================================================

/** What to do with a single target file once its diff is known. */
export type WriteAction =
  | "skip-no-changes" // diff is empty — nothing to write, no prompt
  | "dry-run" // changes exist but `--dry-run` forbids writing
  | "apply" // `--yes` — write without prompting
  | "prompt" // interactive confirmation required
  | "abort-non-interactive" // changes exist, no `--yes`, and stdin is not a TTY

/**
 * Decide the write action for one target file. Pure — no IO, no prompting.
 * Precedence: no-changes > dry-run > --yes > non-interactive-abort > prompt.
 * The safe default is never to write silently: without `--yes`, a non-TTY
 * aborts rather than clobbering, and a TTY must confirm (default No).
 */
export function decideWriteAction(params: { hasChanges: boolean; dryRun: boolean; yes: boolean; isTTY: boolean }): WriteAction {
  if (!params.hasChanges) return "skip-no-changes"
  if (params.dryRun) return "dry-run"
  if (params.yes) return "apply"
  if (!params.isTTY) return "abort-non-interactive"
  return "prompt"
}

/** Options for `writeClaudeCodeConfig` — also the seam tests use for isolation. */
export interface WriteClaudeCodeConfigOptions {
  /** Home directory to write into. Defaults to `os.homedir()`. Tests pass a temp dir. */
  home?: string
  /** Write the opinionated extension env vars too. Default `false`. */
  includeExtensions?: boolean
  /** Auto-apply every file without prompting (CI / scripts). Default `false`. */
  yes?: boolean
  /** Only compute and print diffs; never write — even with `yes`. Default `false`. */
  dryRun?: boolean
  /**
   * Whether stdin is an interactive TTY. Controls the non-interactive safety
   * abort. Defaults to `process.stdin.isTTY`. Tests inject this explicitly.
   */
  isTTY?: boolean
  /**
   * Prompt implementation, called per file when confirmation is required.
   * Receives the prompt message and returns the user's y/N answer. Defaults to
   * an interactive consola confirm that defaults to No. Tests inject a
   * deterministic decision.
   */
  confirm?: (message: string) => Promise<boolean>
}

/** Raised when an existing target file cannot be parsed — we refuse to clobber it. */
class JsonParseError extends Error {
  readonly path: string
  readonly reason: unknown
  constructor(path: string, reason: unknown) {
    super(`Failed to parse ${path} as JSON`)
    this.name = "JsonParseError"
    this.path = path
    this.reason = reason
  }
}

/**
 * Read+parse a JSON object file. Returns `{}` when the file is missing (a blank
 * slate is safe to write). Never swallows a parse failure: a malformed or
 * non-object existing file throws `JsonParseError` so the caller can refuse to
 * overwrite it rather than silently clobbering the user's data.
 */
async function readJsonObject(path: string): Promise<Record<string, unknown>> {
  if (!existsSync(path)) return {}
  const buffer = await fsPromises.readFile(path)
  let parsed: unknown
  try {
    parsed = JSON.parse(buffer.toString())
  } catch (error) {
    throw new JsonParseError(path, error)
  }
  if (!isPlainObject(parsed)) throw new JsonParseError(path, `expected a JSON object, got ${Array.isArray(parsed) ? "array" : typeof parsed}`)
  return parsed
}

/** One target config file: its path and how the final content is merged. */
interface ConfigTarget {
  path: string
  /** Merge the setup's changes into the existing content (merge semantics preserved). */
  computeFinal: (existing: Record<string, unknown>) => Record<string, unknown>
}

/** Resolved per-file settings for `applyConfigTarget`. */
interface ApplyContext {
  dryRun: boolean
  yes: boolean
  isTTY: boolean
  confirm: (message: string) => Promise<boolean>
}

/**
 * Diff, show, confirm, and (maybe) write a single target file. Always prints
 * the leaf-path diff — a brand-new file shows as all `+`. Returns `true` iff
 * the file was written.
 */
async function applyConfigTarget(target: ConfigTarget, ctx: ApplyContext): Promise<boolean> {
  // Never assume a blank slate — read and respect existing content. A parse
  // failure means we cannot safely diff, so we abort this file (never clobber).
  let existing: Record<string, unknown>
  try {
    existing = await readJsonObject(target.path)
  } catch (error) {
    if (error instanceof JsonParseError) {
      consola.error(`${target.path}: cannot parse existing file as JSON — refusing to overwrite. Fix or remove it, then re-run. (${String(error.reason)})`)
      return false
    }
    throw error
  }

  const final = target.computeFinal(existing)
  const diff = computeJsonDiff(existing, final)
  const changed = hasJsonDiff(diff)

  // Always show exactly what would change.
  consola.info(`${target.path}:\n${changed ? formatJsonDiff(diff) : "  (no changes)"}`)

  const action = decideWriteAction({ hasChanges: changed, dryRun: ctx.dryRun, yes: ctx.yes, isTTY: ctx.isTTY })
  switch (action) {
    case "skip-no-changes": {
      consola.success(`${target.path} already up to date — no changes needed.`)
      return false
    }
    case "dry-run": {
      consola.info(`${target.path}: dry run — not written.`)
      return false
    }
    case "abort-non-interactive": {
      consola.warn(`${target.path}: non-interactive; pass --yes to apply. Skipped.`)
      return false
    }
    case "prompt": {
      const approved = await ctx.confirm(`Apply these changes to ${target.path}?`)
      if (!approved) {
        consola.info(`${target.path}: skipped — no changes written.`)
        return false
      }
      break
    }
    case "apply": {
      break
    }
    default: {
      // Exhaustive over WriteAction. The safe default is NOT to write: if a new
      // WriteAction variant is ever added and left unhandled, `never` flags it at
      // compile time and this branch refuses to write rather than clobbering.
      return ((_never: never) => false)(action)
    }
  }

  const dir = dirname(target.path)
  if (!existsSync(dir)) {
    await fsPromises.mkdir(dir, { recursive: true })
    consola.info(`Created directory: ${dir}`)
  }
  await fsPromises.writeFile(target.path, JSON.stringify(final, null, 2) + "\n")
  consola.success(`Updated ${target.path}`)
  return true
}

/**
 * Write Claude Code configuration for use with Copilot API.
 *
 * Respects existing config (merge semantics): for each target file the existing
 * content is read, the setup's changes are merged in, and the resulting
 * leaf-path diff is always shown before writing. Each file is confirmed
 * independently (default No); `--yes` auto-applies, `--dry-run` writes nothing,
 * and a non-interactive shell without `--yes` aborts rather than clobbering.
 * Targets:
 * - `$HOME/.claude.json` — sets `hasCompletedOnboarding: true`
 * - `$HOME/.claude/settings.json` — sets the essential env (+ extensions if opted in)
 */
export async function writeClaudeCodeConfig(serverUrl: string, model: Model, smallModel: Model, options: WriteClaudeCodeConfigOptions = {}): Promise<void> {
  const home = options.home ?? homedir()
  const claudeJsonPath = join(home, ".claude.json")
  const settingsPath = join(home, ".claude", "settings.json")

  const ctx: ApplyContext = {
    dryRun: options.dryRun ?? false,
    yes: options.yes ?? false,
    isTTY: options.isTTY ?? process.stdin.isTTY,
    confirm: options.confirm ?? ((message: string) => consola.prompt(message, { type: "confirm", initial: false })),
  }

  const targets: Array<ConfigTarget> = [
    {
      path: claudeJsonPath,
      computeFinal: (existing) => ({ ...existing, hasCompletedOnboarding: true }),
    },
    {
      path: settingsPath,
      computeFinal: (existing) => {
        const existingEnv = (existing.env as Record<string, string> | undefined) ?? {}
        const proposedEnv = buildClaudeCodeEnv(serverUrl, model, smallModel, existingEnv, {
          includeExtensions: options.includeExtensions,
        })
        return { ...existing, env: proposedEnv }
      },
    },
  ]

  let wroteAny = false
  for (const target of targets) {
    // Sequential (not parallel): the diffs and prompts must read in order.
    const wrote = await applyConfigTarget(target, ctx)
    wroteAny = wroteAny || wrote
  }

  if (wroteAny) {
    const mainModelId = withClaudeCode1mSuffix(model.id, getMaxPromptTokens(model))
    const smallModelId = withClaudeCode1mSuffix(smallModel.id, getMaxPromptTokens(smallModel))
    consola.box(
      `Claude Code configured!\n\n`
        + `Model: ${mainModelId}\n`
        + `Small Model: ${smallModelId}\n`
        + `API URL: ${serverUrl}\n\n`
        + `Run 'claude' to start Claude Code.`,
    )
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
  /** Auto-apply all changes without prompting (CI / scripts). */
  yes: boolean
  /** Only show the diffs; never write. */
  dryRun: boolean
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
    // `--yes` auto-applies every file; `--dry-run` shows diffs but writes
    // nothing. Otherwise each changed file is confirmed interactively (default
    // No), and a non-interactive shell aborts rather than clobbering.
    yes: options.yes,
    dryRun: options.dryRun,
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
      description: "Auto-apply all changes without prompting (CI / scripts)",
    },
    "dry-run": {
      type: "boolean",
      default: false,
      description: "Show the +/~/- diff for each config file but write nothing",
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
      dryRun: args["dry-run"],
    })
  },
})
