type BridgeTargetFormat = "anthropic-messages" | "openai-responses"

interface AnthropicRenderer { readonly targetFormat: "anthropic-messages"; formatHttp(): { a: 1 } }
interface ResponsesRenderer { readonly targetFormat: "openai-responses"; formatHttp(): { b: 2 } }

type RendererFor<TF extends BridgeTargetFormat> =
  TF extends "anthropic-messages" ? AnthropicRenderer : ResponsesRenderer

interface Profile<TF extends BridgeTargetFormat> {
  readonly targetFormat: TF
  readonly errorRenderer: RendererFor<TF>
}

const anthropicRenderer: AnthropicRenderer = { targetFormat: "anthropic-messages", formatHttp: () => ({ a: 1 }) }
const responsesRenderer: ResponsesRenderer = { targetFormat: "openai-responses", formatHttp: () => ({ b: 2 }) }

// --- Control A: the WIDENED container the reviewer says is false-green ---
export const widened = {
  anthropic: { targetFormat: "anthropic-messages", errorRenderer: responsesRenderer },
} satisfies Record<string, Profile<BridgeTargetFormat>>

// --- Candidate fix: union of concrete instantiations ---
type AnyProfile = Profile<"anthropic-messages"> | Profile<"openai-responses">

// GOOD: correct assembly must compile (false-red check).
export const good = {
  anthropic: { targetFormat: "anthropic-messages", errorRenderer: anthropicRenderer },
  responses: { targetFormat: "openai-responses", errorRenderer: responsesRenderer },
} satisfies Record<string, AnyProfile>

// BAD: mismatched assembly must FAIL to compile (false-green check).
export const bad = {
  anthropic: { targetFormat: "anthropic-messages", errorRenderer: responsesRenderer },
} satisfies Record<string, AnyProfile>
