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
 * Phase 1 scope: only the `/v1/messages` (Anthropic) builder is registered — the leg every
 * reverse grid targets. The messages route resolves its strategies through here keyed by
 * `env.targetEndpoint` (always `/v1/messages` for anthropic-direct today → byte-identical to the
 * inlined `buildAnthropicStrategies` call it replaced). The `/chat/completions` (CC) and
 * `/responses` builders land with their translation legs (Phase 2+ forward `anthropic→cc`, whose
 * supply — e.g. the truncation baseline of the TRANSLATED CC body — does not exist until the hub
 * produces it); registering them now would be a guess, tracked for that phase.
 */

import type { Model } from "~/lib/models/client"
import type { UpstreamEndpoint } from "~/lib/pipeline/envelope"
import type { RetryStrategy as EnvRetryStrategy } from "~/lib/pipeline/types"

import { ENDPOINT } from "~/lib/models/endpoint"

import {
  //
  type AnthropicStrategiesDeps,
  buildAnthropicStrategies,
} from "./anthropic/strategies"

/** The Anthropic (`/v1/messages` leg) strategy supply — the sanitize chain + probe + baseline. */
export type AnthropicStrategySupply = AnthropicStrategiesDeps

/**
 * The per-leg supply bag: one optional slot per format-specific builder. A caller fills the slot
 * for the leg(s) it can route to; {@link assembleStrategiesForEndpoint} reads the one matching the
 * resolved `targetEndpoint`. (A single-slot union today; more slots are added with each leg.)
 */
export interface StrategySupply {
  /** Anthropic `/v1/messages`-leg supply (from the codec today, from the hub on a reverse leg). */
  anthropic?: AnthropicStrategySupply
}

/**
 * Assemble the retry-strategy stack for an outbound leg from the format-decoupled {@link StrategySupply}.
 * Keyed by `targetEndpoint`: `/v1/messages` → the Anthropic stack. Throws if the leg's required supply
 * is absent (a wiring bug — a route routing to a leg it can't supply), and for legs whose builder has
 * not landed yet (CC/Responses forward legs, Phase 2+).
 */
export function assembleStrategiesForEndpoint(targetEndpoint: UpstreamEndpoint, supply: StrategySupply): ReadonlyArray<EnvRetryStrategy> {
  switch (targetEndpoint) {
    case ENDPOINT.MESSAGES: {
      if (!supply.anthropic) throw new Error("[strategy-registry] /v1/messages leg requires the anthropic supply (resanitize/betaProbe/baseline)")
      return buildAnthropicStrategies(supply.anthropic)
    }
    default: {
      // CC/Responses builders land with their translation legs (Phase 2+); until then the CC/Responses
      // routes still build their own native strategies inline (not yet routed through this registry).
      throw new Error(`[strategy-registry] no strategy builder registered for the ${targetEndpoint} leg yet`)
    }
  }
}

export type { AnthropicStrategiesDeps, Model }
