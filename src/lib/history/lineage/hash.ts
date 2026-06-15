/**
 * Lineage hash chain computations.
 *
 * See `docs/rfc/request-lineage.md` §3.4. Two-level cumulative SHA-256:
 * `turnHashes` over `messages[]` for prefix-equality checks, plus
 * `postResponseHash` that a successor will produce when it echoes this
 * entry's assistant response back into its own chain.
 */

import type { MessageParam } from "~/types/api/anthropic"

import {
  //
  canonicalJson,
  sha256Hex,
} from "./canonicalize"

/**
 * Cumulative chain over already-canonicalized messages:
 *
 *   turnHashes[i] = sha256(turnHashes[i-1] || canonicalJson(messages[i]))
 *
 * The cumulative property gives us a single-hex-string prefix-equality
 * oracle: `B.turnHashes[k] === A.turnHashes[k]` iff their first k+1
 * messages canonicalize identically.
 *
 * Per-message `canonicalJson` is computed once per iteration (O(message
 * size)), not recomputed from scratch per turn — total cost is O(total
 * bytes across messages), not O(N²).
 */
export function computeTurnHashes(canonicalMessages: ReadonlyArray<MessageParam>): Array<string> {
  const out: Array<string> = []
  let prev = ""
  for (const m of canonicalMessages) {
    const cj = canonicalJson(m)
    prev = sha256Hex(prev + cj)
    out.push(prev)
  }
  return out
}

/**
 * The hash a *successor* request will produce at position
 * `turnHashes.length` in its own chain when it echoes back this entry's
 * assistant response as the next message.
 *
 *   postResponseHash = sha256(turnHashes.last || canonicalJson(canonicalizedAssistantMessage))
 *
 * `assistantMessage` must already be canonicalized via the same rules as
 * the request messages.
 */
export function computePostResponseHash(turnHashes: ReadonlyArray<string>, canonicalAssistantMessage: MessageParam): string {
  const seed = turnHashes.at(-1) ?? ""
  return sha256Hex(seed + canonicalJson(canonicalAssistantMessage))
}

/**
 * Bind the conversation root to the agent's system + tools, not just
 * msg[0]. Msg[0] alone collides across distinct conversations whose
 * boilerplate `<system-reminder>` strips down to the same shape
 * (empirically verified — see RFC §2.2).
 *
 *   rootHash = sha256(sha256(canonical(system)) || sha256(canonical(tools)) || sha256(canonical(msg[0])))
 *
 * Inputs are hashed independently then chained so a missing/empty
 * input still produces a stable hash (sha256 of `null` is well-defined).
 */
export function computeRootHash(system: unknown, tools: unknown, canonicalFirstMessage: MessageParam | undefined): string {
  return sha256Hex(sha256Hex(canonicalJson(system ?? null)) + sha256Hex(canonicalJson(tools ?? null)) + sha256Hex(canonicalJson(canonicalFirstMessage ?? null)))
}

/** Pack an array of 64-hex SHA-256s into raw 32-byte concatenated Buffer. */
export function packTurnHashes(turnHashes: ReadonlyArray<string>): Buffer {
  const buf = Buffer.alloc(turnHashes.length * 32)
  for (const [i, h] of turnHashes.entries()) {
    if (h.length !== 64) throw new Error(`packTurnHashes: expected 64-hex, got length ${h.length}`)
    buf.write(h, i * 32, 32, "hex")
  }
  return buf
}

/** Inverse of `packTurnHashes`. Returns lowercase-hex strings. */
export function unpackTurnHashes(buf: Buffer | Uint8Array): Array<string> {
  const view = Buffer.isBuffer(buf) ? buf : Buffer.from(buf)
  if (view.length % 32 !== 0) throw new Error(`unpackTurnHashes: blob length ${view.length} not a multiple of 32`)
  const n = view.length / 32
  // eslint-disable-next-line unicorn/no-new-array
  const out: Array<string> = new Array<string>(n)
  for (let i = 0; i < n; i++) {
    out[i] = view.toString("hex", i * 32, (i + 1) * 32)
  }
  return out
}

/** Re-export so callers don't need to dip into ./canonicalize. */

export { canonicalizeMessages, canonicalJson, sha256Hex } from "./canonicalize"
