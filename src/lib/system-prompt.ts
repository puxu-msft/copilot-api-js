/**
 * System Prompt Manager: config-based overrides.
 *
 * - **Overrides**: Applies per-line replacement rules from config.yaml.
 *   Always active.
 */

import type { TextBlockParam } from "~/types/api/anthropic"
import type { ContentPart, Message } from "~/types/api/openai-chat-completions"

import { applyConfigToState } from "./config/config"
import { state, type CompiledRewriteRule } from "./state"

// ============================================================================
// Override Application
// ============================================================================

/**
 * Apply overrides to a text block.
 * - line: split by newlines, if a trimmed line matches trimmed `from`, replace that line with `to`
 * - regex: apply regex on the entire text with gms flags (multiline: ^$ match line boundaries, dotAll: . matches \n)
 */
export function applyOverrides(text: string, rules: Array<CompiledRewriteRule>, model?: string): string {
  let result = text
  for (const rule of rules) {
    // Skip rule if it has a model filter and the model doesn't match
    if (rule.modelPattern && (!model || !rule.modelPattern.test(model))) continue
    if (rule.method === "line") {
      const lines = result.split("\n")
      result = lines.map((line) => (line.trim() === (rule.from as string).trim() ? rule.to : line)).join("\n")
    } else {
      result = result.replace(rule.from as RegExp, rule.to)
    }
  }
  return result
}

// ============================================================================
// Core: Plain Text System Prompt Processing
// ============================================================================

/**
 * Process a plain-text system prompt: apply overrides, prepend, and append.
 *
 * Shared core logic used by all format-specific processors (Anthropic, OpenAI, Responses).
 */
export async function processSystemPromptText(text: string, model?: string): Promise<string> {
  const config = await applyConfigToState()

  let result = text
  if (state.systemPromptOverrides.length > 0) {
    result = applyOverrides(result, state.systemPromptOverrides, model)
  }
  if (config.system_prompt_prepend) {
    result = config.system_prompt_prepend + "\n\n" + result
  }
  if (config.system_prompt_append) {
    result = result + "\n\n" + config.system_prompt_append
  }
  return result
}

// ============================================================================
// Public API: Anthropic
// ============================================================================

export async function processAnthropicSystem(
  system: string | Array<TextBlockParam> | undefined,
  model?: string,
): Promise<string | Array<TextBlockParam> | undefined> {
  if (!system) return system

  // String system prompt — delegate to shared core
  if (typeof system === "string") {
    return processSystemPromptText(system, model)
  }

  // TextBlockParam[] — apply overrides, prepend, append per block
  const config = await applyConfigToState()
  const prepend = config.system_prompt_prepend
  const append = config.system_prompt_append

  let result: Array<TextBlockParam> = system
  if (state.systemPromptOverrides.length > 0) {
    result = result.map((block) => ({
      ...block,
      text: applyOverrides(block.text, state.systemPromptOverrides, model),
    }))
  }

  if (prepend) {
    result = [{ type: "text" as const, text: prepend }, ...result]
  }

  if (append) {
    result = [...result, { type: "text" as const, text: append }]
  }

  return result
}

// ============================================================================
// Public API: OpenAI
// ============================================================================

export async function processOpenAIMessages(messages: Array<Message>, model?: string): Promise<Array<Message>> {
  // Extract system/developer messages
  const systemMessages = messages.filter((m) => m.role === "system" || m.role === "developer")
  if (systemMessages.length === 0) {
    // Even with no system messages, we may need to prepend/append
    const config = await applyConfigToState()
    let result = messages
    if (config.system_prompt_prepend) {
      result = [{ role: "system" as const, content: config.system_prompt_prepend }, ...result]
    }
    if (config.system_prompt_append) {
      result = [...result, { role: "system" as const, content: config.system_prompt_append }]
    }
    return result
  }

  // Load config (also applies to state, populating systemPromptOverrides)
  const config = await applyConfigToState()
  const prepend = config.system_prompt_prepend
  const append = config.system_prompt_append

  // Apply overrides to system/developer messages
  let result =
    state.systemPromptOverrides.length > 0 ?
      messages.map((msg) => {
        if (msg.role !== "system" && msg.role !== "developer") return msg

        if (typeof msg.content === "string") {
          return { ...msg, content: applyOverrides(msg.content, state.systemPromptOverrides, model) }
        }

        if (Array.isArray(msg.content)) {
          return {
            ...msg,
            content: msg.content.map((part: ContentPart) => {
              if (part.type === "text") {
                return { ...part, text: applyOverrides(part.text, state.systemPromptOverrides, model) }
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

// ============================================================================
// Public API: Responses
// ============================================================================

/**
 * Process Responses API `instructions` field (system prompt equivalent).
 *
 * Applies the same overrides, prepend, and append as Anthropic/OpenAI system prompts.
 * Preserves null/undefined pass-through — only processes non-empty strings.
 */
export async function processResponsesInstructions(
  instructions: string | null | undefined,
  model?: string,
): Promise<string | null | undefined> {
  if (!instructions) return instructions
  return processSystemPromptText(instructions, model)
}
