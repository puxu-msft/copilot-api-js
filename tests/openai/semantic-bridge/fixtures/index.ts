import type {
  //
  MessageParam,
  MessagesPayload,
} from "~/types/api/anthropic"
import type {
  //
  ResponsesInputItem,
  ResponsesOutputItem,
  ResponsesPayload,
  ResponsesResponse,
} from "~/types/api/openai-responses"

import { buildClaudeSignatureCarrier } from "~/lib/anthropic/claude-signature-carrier"
import { buildSyntheticReasoningSignature } from "~/lib/anthropic/synthetic-reasoning"

/**
 * KNOWN-LOSS fixtures captured by C0.2. `expectedAfterMigration` names the C4–C8 slice that implements
 * the target behavior in a new mapper/emitter; these legacy-translator assertions remain green until
 * C9/C10 explicitly rewrite them during production cutover.
 */
export const expectedAfterMigration = {
  sdkLifecycle: "C8.1 emits the complete Responses item/content lifecycle accepted by the official SDK",
  orderedTurns: "C4 preserves source text/tool ordinals unless a named target-protocol rule requires a reorder",
  serverTools: "C5 gives all four server-tool quadrants an explicit native or correlated-text disposition",
  scenarioBRequest: "C7 applies the Scenario B carrier policy to request consumers as well as response renderers",
  multiReasoning: "C8.2 keeps every reasoning item independent, including its own visible and opaque state",
  encryptedOnly: "C8.2 preserves encrypted-only reasoning even when its visible summary is empty",
  functionArguments: "C8.1 uses authoritative function arguments from the start/done item when no delta exists",
  incompleteTerminal: "C8.1 emits the lifecycle event matching the incomplete response terminal",
  capabilities: "C6 rejects or records typed degradation for unsupported top-level capabilities instead of silently pruning them",
  sameModelReplay: "G4 remains invariant through C11: same-model native Claude assistant content is replayed byte-for-byte and in source order",
} as const

export function anthropicPayload(messages: Array<MessageParam>, over?: Partial<MessagesPayload>): MessagesPayload {
  return { model: "gpt-5.5", max_tokens: 128, messages, ...over }
}

export function responsesPayload(input: Array<ResponsesInputItem>, over?: Partial<ResponsesPayload>): ResponsesPayload {
  return { model: "claude-opus-4.8", input, ...over }
}

export function responsesResponse(output: Array<ResponsesOutputItem>, over?: Partial<ResponsesResponse>): ResponsesResponse {
  return {
    id: "resp_known_loss",
    object: "response",
    created_at: 1,
    status: "completed",
    model: "gpt-5.5",
    output,
    usage: null,
    tools: [],
    tool_choice: "auto",
    parallel_tool_calls: true,
    store: false,
    ...over,
  }
}

export const orderedAnthropicAssistant: MessageParam = {
  role: "assistant",
  content: [
    { type: "text", text: "before" },
    { type: "tool_use", id: "toolu_order", name: "lookup", input: { q: 1 } },
    { type: "text", text: "after" },
  ],
}

export const orderedResponsesInput: Array<ResponsesInputItem> = [
  { type: "function_call", id: "fc_order", call_id: "call_order", name: "lookup", arguments: "{}" },
  { type: "message", role: "assistant", content: [{ type: "output_text", text: "after-tool" }] },
]

export const multiReasoningOutput: Array<ResponsesOutputItem> = [
  { type: "reasoning", id: "r1", summary: [{ type: "summary_text", text: "first" }], encrypted_content: "enc-first" },
  { type: "message", id: "m1", role: "assistant", status: "completed", content: [{ type: "output_text", text: "visible", annotations: [] }] },
  { type: "reasoning", id: "r2", summary: [{ type: "summary_text", text: "second" }], encrypted_content: "enc-second" },
]

export const encryptedOnlyOutput: Array<ResponsesOutputItem> = [
  { type: "reasoning", id: "r-encrypted", summary: [], encrypted_content: "opaque-without-summary" },
]

export const scenarioBReasoningHistory: MessageParam = {
  role: "assistant",
  content: [{ type: "thinking", thinking: "prior summary", signature: buildSyntheticReasoningSignature("opaque-must-strip") }],
}

export const sameModelClaudeAssistant: MessageParam = {
  role: "assistant",
  content: [
    { type: "thinking", thinking: "private chain", signature: "claude-signature-byte-exact" },
    { type: "redacted_thinking", data: "redacted-byte-exact" },
    { type: "text", text: "visible answer" },
    { type: "tool_use", id: "toolu_same_model", name: "lookup", input: { key: "value" } },
  ],
}

export const sameModelClaudeToolResult: MessageParam = {
  role: "user",
  content: [{ type: "tool_result", tool_use_id: "toolu_same_model", content: "done" }],
}

export const sameModelReasoningCarrier = buildClaudeSignatureCarrier("claude-signature-byte-exact")
