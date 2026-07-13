/**
 * Full-format retry-strategy builder registry, keyed by the OUTBOUND leg (`targetEndpoint`).
 *
 * The v4 driver assembles its S4 retry strategies from `deps.strategies` — historically a
 * per-route factory that closes over that ROUTE's own codec (`codec.getResanitize()` /
 * `codec.getTruncateBaseline()` / the request `betaProbe`). That coupling breaks the translation
 * matrix's reverse legs: a cc/responses/gemini request routed to `/v1/messages` (Phase 5) needs
 * the ANTHROPIC strategy stack (the outbound wire is Anthropic — RFC §3.1), but its route has no
 * Anthropic codec to supply `resanitize`/`betaProbe` from.
 *
 * This registry is the fix (RFC §7.1 "策略供料" / W-strategies-builder): it maps each outbound
 * leg to a FORMAT-SPECIFIC builder that takes an explicit SUPPLY object — the sanitize chain,
 * beta probe, truncation baseline, model — decoupled from any route codec. A reverse leg fills
 * the same supply from the hub translator instead; the builder is identical.
 *
 * Registered legs:
 *   - `/v1/messages` (Anthropic) — the leg every reverse grid targets. The messages route resolves
 *     its strategies through here keyed by `env.targetEndpoint` (always `/v1/messages` for
 *     anthropic-direct → byte-identical to the inlined `buildAnthropicStrategies` call it replaced).
 *   - `/chat/completions` + `/responses` + `ws:/responses` (OpenAI-CC) — the FORWARD translate legs
 *     (Phase 7, closing the production gap where an anthropic→cc/responses request 500'd on the
 *     `no strategy builder registered` throw). All three share ONE `buildOpenAiCcStrategies` builder:
 *     the `/responses` and `ws:/responses` legs run the CC strategy stack against the TRANSLATED CC
 *     body (the CC→Responses wire step is deferred to `prepareWire`, so the auto-truncate baseline is
 *     still CC-shaped — parity with the openai-cc/gemini `via-responses` forward legs). The CC supply
 *     is the translated CC baseline the hub produces (the messages handler passes `env.body` — post-
 *     `translateOut`, i.e. already CC-shaped — as the truncation baseline).
 *
 * The `default` case still throws for any leg whose builder has not landed (a future format).
 */

import type { UpstreamEndpoint } from "~/lib/pipeline/envelope"
import type { RetryStrategy as EnvRetryStrategy } from "~/lib/pipeline/types"

import { ENDPOINT } from "~/lib/models/endpoint"

import {
  //
  type AnthropicStrategiesDeps,
  buildAnthropicStrategies,
} from "./anthropic/strategies"
import {
  //
  buildOpenAiCcStrategies,
  type OpenAiCcStrategiesDeps,
} from "./openai-cc/strategies"

/** The Anthropic (`/v1/messages` leg) strategy supply — the sanitize chain + probe + baseline. */
export type AnthropicStrategySupply = AnthropicStrategiesDeps

/** The OpenAI-CC (`/chat/completions` + `/responses` + `ws:/responses` legs) strategy supply — the CC truncation baseline + model + label. */
export type OpenAiCcStrategySupply = OpenAiCcStrategiesDeps

/**
 * The per-leg supply bag: one optional slot per format-specific builder. A caller fills the slot
 * for the leg(s) it can route to; {@link assembleStrategiesForEndpoint} reads the one matching the
 * resolved `targetEndpoint`. A caller that can route to multiple legs (the messages handler's forward
 * translate leg picks CC or Responses per-request) fills the relevant slot.
 */
export interface StrategySupply {
  /** Anthropic `/v1/messages`-leg supply (from the codec today, from the hub on a reverse leg). */
  anthropic?: AnthropicStrategySupply
  /** OpenAI-CC-leg supply (`/chat/completions` + `/responses` + `ws:/responses`); the forward `anthropic→cc/responses` translate leg fills it from the hub-translated CC body. */
  cc?: OpenAiCcStrategySupply
}

/**
 * Assemble the retry-strategy stack for an outbound leg from the format-decoupled {@link StrategySupply}.
 * Keyed by `targetEndpoint`:
 *   - `/v1/messages` → the Anthropic stack (requires `supply.anthropic`).
 *   - `/chat/completions` / `/responses` / `ws:/responses` → the OpenAI-CC stack (requires `supply.cc`).
 * Throws if the leg's required supply is absent (a wiring bug — a route routing to a leg it can't
 * supply), and for any leg whose builder has not landed yet (`default`).
 */
export function assembleStrategiesForEndpoint(targetEndpoint: UpstreamEndpoint, supply: StrategySupply): ReadonlyArray<EnvRetryStrategy> {
  switch (targetEndpoint) {
    case ENDPOINT.MESSAGES: {
      if (!supply.anthropic) throw new Error("[strategy-registry] /v1/messages leg requires the anthropic supply (resanitize/betaProbe/baseline)")
      return buildAnthropicStrategies(supply.anthropic)
    }
    case ENDPOINT.CHAT_COMPLETIONS:
    case ENDPOINT.RESPONSES:
    case ENDPOINT.WS_RESPONSES: {
      // The three CC-family forward legs share ONE builder: `/responses` + `ws:/responses` run the CC
      // strategy stack against the CC-shaped baseline (the CC→Responses wire step is deferred to
      // `prepareWire`), matching the openai-cc/gemini `via-responses` forward legs.
      if (!supply.cc) throw new Error(`[strategy-registry] ${targetEndpoint} leg requires the cc supply (truncation baseline/model/label)`)
      return buildOpenAiCcStrategies(supply.cc)
    }
    default: {
      // No builder registered for this leg yet (a future format). `targetEndpoint` narrows to `never`
      // here — every current UpstreamEndpoint is handled above — so this is a defensive guard.
      throw new Error(`[strategy-registry] no strategy builder registered for the ${String(targetEndpoint)} leg yet`)
    }
  }
}

export { type AnthropicStrategiesDeps } from "./anthropic/strategies"
export { type OpenAiCcStrategiesDeps } from "./openai-cc/strategies"
export { type Model } from "~/lib/models/client"
