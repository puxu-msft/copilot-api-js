/**
 * Constructing a {@link ModelIdentity} — the `(protocol, provider, model)` triple RFC §3.3 compares
 * before replaying opaque carrier bytes.
 *
 * **Ruled 2026-08-11 (user): provider is read live, not frozen per request.** The alternative was to
 * freeze it at ingress alongside `TranslationConfigSnapshot`, which would make a request's provider
 * immune to a mid-flight config reload. That was rejected on scope grounds — provenance comparison
 * is not a core goal of this project and does not warrant a second request-scoped snapshot.
 *
 * The accepted consequence, stated plainly so nobody rediscovers it as a bug: if `accountType` or
 * `ghc_api_base_url` changes while a request is in flight, that request's retry leg can compute a
 * different provider from its first attempt, and the two legs would then disagree about whether an
 * opaque carrier may be preserved. The blast radius is one preserve/strip decision — no wire
 * corruption, no lost delivery.
 */

import { copilotBaseUrl } from "~/lib/copilot-api"
import { state } from "~/lib/state"

import type { ModelIdentity } from "./types"

/**
 * The upstream leg's identity, as a canonical origin (`https://api.business.githubcopilot.com`).
 *
 * RFC §6.1 says provider is filled in by "the actual upstream leg" — the serving side, **not** the
 * model's vendor (`Model.vendor` is `"Anthropic"`/`"OpenAI"`, the maker, which is a different axis).
 *
 * Normalizing to `URL.origin` rather than keeping the raw string is what stops a cosmetic difference
 * — a trailing slash, an uppercased host, an explicit default port — from reading as a *different*
 * provider and stripping an opaque carrier that was in fact replayable. `copilotBaseUrl` already
 * trims trailing slashes; `.origin` additionally lowercases the host and drops a default port.
 */
export function currentUpstreamProvider(): string {
  return new URL(copilotBaseUrl(state)).origin
}

/** Build the identity for one side of a pair. `model` must be the FINAL resolved id, never a client alias. */
export function modelIdentityFor(protocol: ModelIdentity["protocol"], model: string): ModelIdentity {
  return { protocol, provider: currentUpstreamProvider(), model }
}
