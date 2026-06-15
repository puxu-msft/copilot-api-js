/**
 * Barrel re-export for the lineage subsystem.
 *
 * Callers (history write path, lineage query API, backfill script)
 * import from this module rather than reaching into ./hash or
 * ./canonicalize directly.
 */

export { canonicalizeMessages, canonicalJson, sha256Hex } from "./canonicalize"
export { computeLineageDigest, computePostResponseHash, computeRootHash, computeTurnHashes, packTurnHashes, unpackTurnHashes } from "./digest"
export { LINEAGE_SCHEMA_VERSION, type LineageDigest } from "./types"
