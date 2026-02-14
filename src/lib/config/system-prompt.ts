/**
 * System Prompt Manager: collection + config-based overrides.
 *
 * - **Collection**: Saves original system prompts to disk (dedup by MD5).
 *   Opt-in via --collect-system-prompts flag.
 * - **Overrides**: Applies per-line replacement rules from config.yaml.
 *   Always active.
 */

import consola from "consola"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"

import type { TextBlockParam } from "~/types/api/anthropic"
import type { ContentPart, Message } from "~/types/api/openai"

import { state } from "~/lib/state"

import { PATHS } from "./paths"

// ============================================================================
// Types
// ============================================================================

export interface SystemPromptOverride {
  from: string
  to: string
  method: "line" | "regex"
}

export interface SystemPromptConfig {
  system_prompt_overrides?: Array<SystemPromptOverride>
  system_prompt_prepend?: string
  system_prompt_append?: string
}

interface CollectedPrompt {
  hash: string
  format: "anthropic" | "openai"
  timestamp: string
  raw: unknown
}

// ============================================================================
// Config Loading (mtime-cached)
// ============================================================================

let cachedConfig: SystemPromptConfig | null = null
let configLastMtimeMs: number = 0

export async function loadConfig(): Promise<SystemPromptConfig> {
  try {
    const stat = await fs.stat(PATHS.CONFIG_YAML)
    if (cachedConfig && stat.mtimeMs === configLastMtimeMs) {
      return cachedConfig
    }
    const content = await fs.readFile(PATHS.CONFIG_YAML, "utf8")
    const { parse } = await import("yaml")
    const parsed = parse(content)
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- yaml.parse returns null for empty files
    cachedConfig = (parsed as SystemPromptConfig) ?? {}
    configLastMtimeMs = stat.mtimeMs
    return cachedConfig
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return {}
    }
    consola.warn("[SystemPromptManager] Failed to load config.yaml:", err)
    return {}
  }
}

/** Exposed for testing: reset the mtime cache */
export function resetConfigCache(): void {
  cachedConfig = null
  configLastMtimeMs = 0
}

// ============================================================================
// Collection (opt-in via --collect-system-prompts)
// ============================================================================

function computeHash(data: unknown): string {
  const serialized = JSON.stringify(data)
  return createHash("md5").update(serialized).digest("hex")
}

function formatTimestamp(): string {
  const now = new Date()
  const YY = String(now.getFullYear()).slice(2)
  const MM = String(now.getMonth() + 1).padStart(2, "0")
  const dd = String(now.getDate()).padStart(2, "0")
  const HH = String(now.getHours()).padStart(2, "0")
  const mm = String(now.getMinutes()).padStart(2, "0")
  const ss = String(now.getSeconds()).padStart(2, "0")
  return `${YY}${MM}${dd}_${HH}${mm}${ss}`
}

async function collectSystemPrompt(raw: unknown, format: "anthropic" | "openai", hash: string): Promise<void> {
  // Check if a file with this hash already exists (any timestamp)
  const prefix = "system_prompts_"
  const suffix = `_${hash}.json`
  try {
    const files = await fs.readdir(PATHS.APP_DIR)
    if (files.some((f) => f.startsWith(prefix) && f.endsWith(suffix))) {
      return // Already collected
    }
  } catch {
    // Directory doesn't exist yet — proceed to write
  }

  const filePath = path.join(PATHS.APP_DIR, `${prefix}${formatTimestamp()}${suffix}`)
  const entry: CollectedPrompt = {
    hash,
    format,
    timestamp: new Date().toISOString(),
    raw,
  }
  await fs.writeFile(filePath, JSON.stringify(entry, null, 2))
}

// ============================================================================
// Override Application
// ============================================================================

/**
 * Apply overrides to a text block.
 * - line: split by newlines, if a trimmed line matches trimmed `from`, replace that line with `to`
 * - regex: apply regex on the entire text with gms flags (multiline: ^$ match line boundaries, dotAll: . matches \n)
 */
export function applyOverrides(text: string, overrides: Array<SystemPromptOverride>): string {
  let result = text
  for (const override of overrides) {
    if (override.method === "line") {
      const lines = result.split("\n")
      result = lines.map((line) => (line.trim() === override.from.trim() ? override.to : line)).join("\n")
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- explicit match for extensibility
    } else if (override.method === "regex") {
      try {
        const regex = new RegExp(override.from, "gms")
        result = result.replace(regex, override.to)
      } catch {
        // Invalid regex — silently skip
      }
    }
  }
  return result
}

// ============================================================================
// Public API: Anthropic
// ============================================================================

export async function processAnthropicSystem(
  system: string | Array<TextBlockParam> | undefined,
): Promise<string | Array<TextBlockParam> | undefined> {
  if (!system) return system

  // Collect (fire-and-forget, only if enabled)
  if (state.collectSystemPrompts) {
    const hash = computeHash(system)
    collectSystemPrompt(system, "anthropic", hash).catch(() => {})
  }

  // Load config
  const config = await loadConfig()
  const overrides = config.system_prompt_overrides
  const prepend = config.system_prompt_prepend
  const append = config.system_prompt_append

  // Apply overrides per block
  let result = system
  if (overrides?.length) {
    result =
      typeof result === "string" ?
        applyOverrides(result, overrides)
      : result.map((block) => ({
          ...block,
          text: applyOverrides(block.text, overrides),
        }))
  }

  // Apply prepend
  if (prepend) {
    result =
      typeof result === "string" ? prepend + "\n\n" + result : [{ type: "text" as const, text: prepend }, ...result]
  }

  // Apply append
  if (append) {
    result =
      typeof result === "string" ? result + "\n\n" + append : [...result, { type: "text" as const, text: append }]
  }

  return result
}

// ============================================================================
// Public API: OpenAI
// ============================================================================

export async function processOpenAIMessages(messages: Array<Message>): Promise<Array<Message>> {
  // Extract system/developer messages
  const systemMessages = messages.filter((m) => m.role === "system" || m.role === "developer")
  if (systemMessages.length === 0) {
    // Even with no system messages, we may need to prepend/append
    const config = await loadConfig()
    let result = messages
    if (config.system_prompt_prepend) {
      result = [{ role: "system" as const, content: config.system_prompt_prepend }, ...result]
    }
    if (config.system_prompt_append) {
      result = [...result, { role: "system" as const, content: config.system_prompt_append }]
    }
    return result
  }

  // Collect (fire-and-forget, only if enabled)
  if (state.collectSystemPrompts) {
    const hash = computeHash(systemMessages)
    collectSystemPrompt(systemMessages, "openai", hash).catch(() => {})
  }

  // Load config
  const config = await loadConfig()
  const overrides = config.system_prompt_overrides
  const prepend = config.system_prompt_prepend
  const append = config.system_prompt_append

  // Apply overrides to system/developer messages
  let result =
    overrides?.length ?
      messages.map((msg) => {
        if (msg.role !== "system" && msg.role !== "developer") return msg

        if (typeof msg.content === "string") {
          return { ...msg, content: applyOverrides(msg.content, overrides) }
        }

        if (Array.isArray(msg.content)) {
          return {
            ...msg,
            content: msg.content.map((part: ContentPart) => {
              if (part.type === "text") {
                return { ...part, text: applyOverrides(part.text, overrides) }
              }
              return part
            }),
          }
        }

        return msg
      })
    : messages

  // Apply prepend — insert a system message at the beginning
  if (prepend) {
    result = [{ role: "system" as const, content: prepend }, ...result]
  }

  // Apply append — insert a system message at the end
  if (append) {
    result = [...result, { role: "system" as const, content: append }]
  }

  return result
}
