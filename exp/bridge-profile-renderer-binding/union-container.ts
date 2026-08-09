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

// --- Posture O (added round 5): generic alias with a WIDE DEFAULT, used bare ---
// Looks like it satisfies "use a union alias for the container value type", but the
// alias is still an OPEN generic: `HelperProfile` bare == `Profile<BridgeTargetFormat>`.
// MEASURED: NO error on the mismatch below. This posture broke the round-4 invariant,
// which only said "union of concrete instantiations" — hence the tightened wording
// "zero type parameters, closed union".
type HelperProfile<TF extends BridgeTargetFormat = BridgeTargetFormat> = Profile<TF>

export const postureO = {
  anthropic: { targetFormat: "anthropic-messages", errorRenderer: responsesRenderer },
} satisfies Record<string, HelperProfile>

// --- Posture Q (added round 6): hand-written lookalike that never uses Profile<TF> ---
// `targetFormat` and `errorRenderer` are each declared wide, independently — the two are
// never correlated because the generic construct is bypassed entirely.
// MEASURED: NO error on the mismatch below.
//
// This is NOT another hole in the invariant, and the fix is NOT a fourth type-level cell:
// TS cannot express "this container's value type must BE this named alias", and
// structurally-similar stand-ins are unbounded — naming them one at a time never
// terminates. Closed one layer up instead, by a source-level architecture guard
// asserting the registry's declared value type references the frozen alias.
// See P1 Task 1.6 Step 5c.
interface ProfileBase {
  readonly targetFormat: BridgeTargetFormat
  readonly errorRenderer: AnthropicRenderer | ResponsesRenderer
}

export const postureQ: Record<string, ProfileBase> = {
  anthropic: { targetFormat: "anthropic-messages", errorRenderer: responsesRenderer },
}
