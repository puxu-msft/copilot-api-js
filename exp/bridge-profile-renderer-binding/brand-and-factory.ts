type BridgeTargetFormat = "anthropic-messages" | "openai-responses"

interface AnthropicRenderer { readonly targetFormat: "anthropic-messages"; formatHttp(): { a: 1 } }
interface ResponsesRenderer { readonly targetFormat: "openai-responses"; formatHttp(): { b: 2 } }

type RendererFor<TF extends BridgeTargetFormat> =
  TF extends "anthropic-messages" ? AnthropicRenderer : ResponsesRenderer

// The brand: NOT exported from the defining module, so no outside code can produce it.
declare const BRAND: unique symbol

interface Profile<TF extends BridgeTargetFormat> {
  readonly [BRAND]: true
  readonly targetFormat: TF
  readonly errorRenderer: RendererFor<TF>
}

// The single typed factory. Only place that mints the brand.
declare function defineProfile<TF extends BridgeTargetFormat>(
  input: { readonly targetFormat: TF; readonly errorRenderer: RendererFor<TF> },
): Profile<TF>

declare function runBridge<TF extends BridgeTargetFormat>(profile: Profile<TF>): void

const anthropicRenderer: AnthropicRenderer = { targetFormat: "anthropic-messages", formatHttp: () => ({ a: 1 }) }
const responsesRenderer: ResponsesRenderer = { targetFormat: "openai-responses", formatHttp: () => ({ b: 2 }) }

// (1) Correct assembly through the factory: must COMPILE.
export const okProfile = defineProfile({ targetFormat: "anthropic-messages", errorRenderer: anthropicRenderer })
runBridge(okProfile)

// (2) Mismatch through the factory: must FAIL.
export const badViaFactory = defineProfile({ targetFormat: "anthropic-messages", errorRenderer: responsesRenderer })

// (3) THE VACUUM CASE — hand-written stand-in passed to the runner: must FAIL because of the brand.
interface StandIn {
  readonly targetFormat: BridgeTargetFormat
  readonly errorRenderer: AnthropicRenderer | ResponsesRenderer
}
const standIn: StandIn = { targetFormat: "anthropic-messages", errorRenderer: responsesRenderer }
runBridge(standIn)

// (4) Non-registry local temp returning the wide instantiation: does the brand still bite?
declare function makeWide(): Profile<BridgeTargetFormat>
runBridge(makeWide())
