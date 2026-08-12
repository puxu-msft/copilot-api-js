/**
 * The `(source, target)` {@link ModelIdentity} pair one candidate translates between — RFC §6.
 *
 * This is the adapter between the envelope's routing vocabulary and the bridge's. The envelope speaks
 * `ClientFormat` (four values) and `UpstreamEndpoint` (four values); the bridge speaks
 * `ModelIdentity["protocol"]`, which has **two**, because RFC §2 scopes the bridge to Anthropic ↔
 * Responses and rules out Gemini and the real Chat-Completions leg. Requests outside that scope are
 * not a degraded pair — they have no pair at all, and this module says so by returning `undefined`
 * rather than inventing a third protocol value or silently picking the nearer one.
 */

import type {
  //
  ClientFormat,
  RequestEnvelope,
  UpstreamEndpoint,
} from "~/lib/pipeline/envelope"

import type { ModelIdentity } from "./types"

import { currentUpstreamProvider } from "./model-identity"

export type BridgePair = Readonly<{ source: ModelIdentity; target: ModelIdentity }>

/**
 * Exhaustive `Record`s rather than `switch`: adding a `ClientFormat` or an `UpstreamEndpoint` then
 * fails to compile here, which is the point. A `switch` with a `default` arm — which is what the
 * lint rule asks for — would swallow exactly that signal and route the new value to "no pair"
 * silently.
 *
 * `openai-cc` and `gemini` are `undefined` deliberately, not "close enough to Responses": RFC §2
 * scopes the bridge to Anthropic ↔ Responses. Both Responses transports map to one protocol because
 * the bridge's concern is the wire grammar, not whether it arrived over HTTP or a socket.
 */
const PROTOCOL_BY_CLIENT_FORMAT: Readonly<Record<ClientFormat, ModelIdentity["protocol"] | undefined>> = {
  anthropic: "anthropic",
  "openai-responses": "responses",
  "openai-cc": undefined,
  gemini: undefined,
}

const PROTOCOL_BY_ENDPOINT: Readonly<Record<UpstreamEndpoint, ModelIdentity["protocol"] | undefined>> = {
  "/v1/messages": "anthropic",
  "/responses": "responses",
  "ws:/responses": "responses",
  "/chat/completions": undefined,
}

/**
 * Derive a pair from the routing facts alone, or `undefined` if this is not an Anthropic ↔ Responses
 * request. Separated from {@link bridgePairFor} so the mapping can be exercised over its whole
 * input space (every `ClientFormat` × every `UpstreamEndpoint`) without standing up an envelope.
 *
 * Both sides name the **same resolved model** — that is correct rather than degenerate, and it is the
 * whole point of the bridge: one model reached over two protocols. The client's `@responses`-style
 * suffix has already been split off into `request.routeOverride` by S1, so the resolved id is what
 * both legs refer to, and the pair's information lives in the two `protocol` values.
 */
export function bridgePairOf(routing: Readonly<{ clientFormat: ClientFormat; targetEndpoint: UpstreamEndpoint; model: string }>): BridgePair | undefined {
  const sourceProtocol = PROTOCOL_BY_CLIENT_FORMAT[routing.clientFormat]
  const targetProtocol = PROTOCOL_BY_ENDPOINT[routing.targetEndpoint]
  if (sourceProtocol === undefined || targetProtocol === undefined) return undefined

  const provider = currentUpstreamProvider()
  return Object.freeze({
    source: Object.freeze({ protocol: sourceProtocol, provider, model: routing.model }),
    target: Object.freeze({ protocol: targetProtocol, provider, model: routing.model }),
  })
}

/**
 * This candidate's pair, read off the envelope.
 *
 * `target` comes from `attempt.targetEndpoint` rather than anything request-level because a fallback
 * candidate may route elsewhere than its ancestor — which is exactly why RFC §6 resolves policy per
 * candidate instead of per request.
 */
export function bridgePairFor(env: RequestEnvelope): BridgePair | undefined {
  return bridgePairOf({ clientFormat: env.request.clientFormat, targetEndpoint: env.attempt.targetEndpoint, model: env.request.model.id })
}
