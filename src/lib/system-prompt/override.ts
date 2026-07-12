/**
 * System prompt override application.
 *
 * Applies config-driven override / prepend / append rules for Anthropic,
 * OpenAI Chat Completions, and Responses instructions.
 *
 * Each rule/entry carries an optional two-axis scope — `model` (name regex) and
 * `endpoint` (inbound {@link ClientFormat}) — evaluated with AND semantics: a
 * rule applies only when both present axes match (an absent axis matches all).
 * Callers pass the resolved model name and the endpoint the request arrived on;
 * omitting `endpoint` skips any rule/entry that declares an endpoint scope
 * (symmetric with the existing `model` behavior).
 */

import type { ClientFormat } from "~/lib/pipeline/envelope"
import type { TextBlockParam } from "~/types/api/anthropic"
import type {
  //
  ContentPart,
  Message,
} from "~/types/api/openai-chat-completions"

import { applyConfigToState } from "../config/config"
import {
  //
  state,
  type CompiledRewriteRule,
  type CompiledSystemPromptEntry,
} from "../state"

/**
 * Two-axis scope match (AND). An absent axis matches all; a present axis with no
 * corresponding caller value does NOT match (skip). Mirrors the historical
 * model-only skip semantics, now generalized to the endpoint axis too.
 */
function scopeMatches(
  scope: { modelPattern?: RegExp; endpointSet?: ReadonlySet<string> },
  model: string | undefined,
  endpoint: ClientFormat | undefined,
): boolean {
  if (scope.modelPattern && (!model || !scope.modelPattern.test(model))) return false
  if (scope.endpointSet && (!endpoint || !scope.endpointSet.has(endpoint))) return false
  return true
}

/** Filter scoped prepend/append entries by model+endpoint, then join with "\n\n". Returns "" if none match. */
function joinScopedEntries(entries: Array<CompiledSystemPromptEntry>, model: string | undefined, endpoint: ClientFormat | undefined): string {
  return entries
    .filter((e) => scopeMatches(e, model, endpoint))
    .map((e) => e.text)
    .join("\n\n")
}

/**
 * Apply overrides to a text block.
 * - line: split by newlines, if a trimmed line matches trimmed `from`, replace that line with `to`
 * - regex: apply regex on the entire text with gms flags (multiline: ^$ match line boundaries, dotAll: . matches \n)
 */
export function applyOverrides(text: string, rules: Array<CompiledRewriteRule>, model?: string, endpoint?: ClientFormat): string {
  let result = text
  for (const rule of rules) {
    // Skip rule whose model/endpoint scope doesn't match this request.
    if (!scopeMatches(rule, model, endpoint)) continue
    if (rule.method === "line") {
      const lines = result.split("\n")
      result = lines.map((line) => (line.trim() === (rule.from as string).trim() ? rule.to : line)).join("\n")
    } else {
      result = result.replace(rule.from as RegExp, rule.to)
    }
  }
  return result
}

/**
 * Process a plain-text system prompt: apply overrides, prepend, and append.
 *
 * Shared core logic used by all format-specific processors (Anthropic, OpenAI, Responses).
 */
export async function processSystemPromptText(text: string, model?: string, endpoint?: ClientFormat): Promise<string> {
  await applyConfigToState()

  let result = text
  if (state.systemPromptOverrides.length > 0) {
    result = applyOverrides(result, state.systemPromptOverrides, model, endpoint)
  }
  const prepend = joinScopedEntries(state.systemPromptPrepend, model, endpoint)
  if (prepend) {
    result = prepend + "\n\n" + result
  }
  const append = joinScopedEntries(state.systemPromptAppend, model, endpoint)
  if (append) {
    result = result + "\n\n" + append
  }
  return result
}

export async function processAnthropicSystem(
  system: string | Array<TextBlockParam> | undefined,
  model?: string,
  endpoint?: ClientFormat,
): Promise<string | Array<TextBlockParam> | undefined> {
  if (!system) return system

  if (typeof system === "string") {
    return processSystemPromptText(system, model, endpoint)
  }

  await applyConfigToState()

  let result: Array<TextBlockParam> = system
  if (state.systemPromptOverrides.length > 0) {
    result = result.map((block) => ({
      ...block,
      text: applyOverrides(block.text, state.systemPromptOverrides, model, endpoint),
    }))
  }

  const prepend = joinScopedEntries(state.systemPromptPrepend, model, endpoint)
  if (prepend) {
    result = [{ type: "text" as const, text: prepend }, ...result]
  }

  const append = joinScopedEntries(state.systemPromptAppend, model, endpoint)
  if (append) {
    result = [...result, { type: "text" as const, text: append }]
  }

  return result
}

export async function processOpenAIMessages(messages: Array<Message>, model?: string, endpoint?: ClientFormat): Promise<Array<Message>> {
  await applyConfigToState()

  const systemMessages = messages.filter((m) => m.role === "system" || m.role === "developer")
  if (systemMessages.length === 0) {
    let result = messages
    const prepend = joinScopedEntries(state.systemPromptPrepend, model, endpoint)
    if (prepend) {
      result = [{ role: "system" as const, content: prepend }, ...result]
    }
    const append = joinScopedEntries(state.systemPromptAppend, model, endpoint)
    if (append) {
      result = [...result, { role: "system" as const, content: append }]
    }
    return result
  }

  let result =
    state.systemPromptOverrides.length > 0 ?
      messages.map((msg) => {
        if (msg.role !== "system" && msg.role !== "developer") return msg

        if (typeof msg.content === "string") {
          return { ...msg, content: applyOverrides(msg.content, state.systemPromptOverrides, model, endpoint) }
        }

        if (Array.isArray(msg.content)) {
          return {
            ...msg,
            content: msg.content.map((part: ContentPart) => {
              if (part.type === "text") {
                return { ...part, text: applyOverrides(part.text, state.systemPromptOverrides, model, endpoint) }
              }
              return part
            }),
          }
        }

        return msg
      })
    : messages

  const prepend = joinScopedEntries(state.systemPromptPrepend, model, endpoint)
  if (prepend) {
    result = [{ role: "system" as const, content: prepend }, ...result]
  }

  const append = joinScopedEntries(state.systemPromptAppend, model, endpoint)
  if (append) {
    result = [...result, { role: "system" as const, content: append }]
  }

  return result
}

/**
 * Process Responses API `instructions` field (system prompt equivalent).
 *
 * Applies the same overrides, prepend, and append as Anthropic/OpenAI system prompts.
 * Preserves null/undefined pass-through — only processes non-empty strings.
 */
export async function processResponsesInstructions(
  instructions: string | null | undefined,
  model?: string,
  endpoint?: ClientFormat,
): Promise<string | null | undefined> {
  if (!instructions) return instructions
  return processSystemPromptText(instructions, model, endpoint)
}
