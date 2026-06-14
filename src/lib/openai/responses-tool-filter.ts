/**
 * Responses API tool filtering.
 *
 * Some clients (notably the OpenAI Codex CLI) auto-inject an
 * `image_generation` builtin tool into every Responses request. The Copilot
 * `/responses` upstream does not support it and rejects the ENTIRE request,
 * so a single unsupported builtin tool breaks otherwise-valid calls.
 *
 * When `openai-responses.strip_image_generation_tool` is enabled, this strips
 * `image_generation` from the inbound `tools` array before the request reaches
 * upstream. Disabled by default — opt in if your client sends it.
 */

import consola from "consola"

import type {
  //
  ResponsesPayload,
  ResponsesTool,
} from "~/types/api/openai-responses"

import { state } from "~/lib/state"

/** Builtin tool identifiers stripped when strip_image_generation_tool is on. */
const STRIPPABLE_TOOL_IDS = new Set(["image_generation"])

/**
 * True when either the tool's `type` or `name` matches a strippable id.
 * Builtin tools carry the id on `type`; `name` is checked defensively in case
 * a client serializes it differently.
 */
function isStrippableTool(tool: ResponsesTool): boolean {
  const record = tool as { type?: unknown; name?: unknown }
  if (typeof record.type === "string" && STRIPPABLE_TOOL_IDS.has(record.type)) return true
  if (typeof record.name === "string" && STRIPPABLE_TOOL_IDS.has(record.name)) return true
  return false
}

/**
 * Remove `image_generation` from a Responses payload's tools, in place, when
 * `state.stripImageGenerationTool` is enabled. No-op otherwise. Returns the
 * number of tools removed so callers can log.
 */
export function stripImageGenerationTool(payload: ResponsesPayload): number {
  if (!state.stripImageGenerationTool) return 0
  if (!Array.isArray(payload.tools) || payload.tools.length === 0) return 0

  const kept = payload.tools.filter((tool) => !isStrippableTool(tool))
  const removed = payload.tools.length - kept.length
  if (removed > 0) {
    payload.tools = kept
    consola.debug(`[Responses] Stripped ${removed} image_generation tool(s) unsupported by upstream`)
  }
  return removed
}
