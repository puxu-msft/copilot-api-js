/**
 * Per-request, stateless bidirectional tool-name sanitization mapper.
 *
 * When a tool name contains characters the upstream model rejects (dots,
 * other illegal chars), is too long, or collides with another sanitized name,
 * it is rewritten to a legal name before the request is forwarded; the
 * response's tool names are restored back to the client's original names.
 *
 * The sanitization is **deterministic** (same original name → same sanitized
 * name, via sha1 truncation) and the mapper is rebuilt per request from the
 * current tool definitions. Because clients re-send the full tool list every
 * turn, the rebuilt map stays consistent across turns with no persistence.
 *
 * Logic ported from copilot-bridge's `tool-names.ts`, adapted to this project's
 * style and decoupled from any tool object shape (operates on a plain list of
 * client-original tool names).
 */

import { createHash } from "node:crypto"

/** Strict charset: letters, digits, underscore, hyphen. */
const STRICT_TOOL_NAME_CHARS_PATTERN = /^[\w-]+$/
/** Extended charset: strict + dot. */
const DOTTED_TOOL_NAME_CHARS_PATTERN = /^[\w.-]+$/
/** Length of the sha1 disambiguation/truncation suffix. */
const HASH_LENGTH = 10

/** Options controlling how names are sanitized for the target model. */
export interface ToolNameMapperOptions {
  /** Whether dots (`.`) are permitted in the sanitized name. */
  allowDots: boolean
  /** Maximum permitted sanitized name length. */
  maxNameLength: number
}

/**
 * Bidirectional tool-name mapper. Both directions are pure lookups over the
 * snapshot built by {@link createToolNameMapper}.
 */
export interface ToolNameMapper {
  /** Map a client-original tool name to its upstream (sanitized) name. */
  toUpstream(name: string): string
  /** Map an upstream (sanitized) tool name back to the client-original name. */
  toClient(name: string): string
  /** Whether `name` is a known client-original tool name in this mapper's snapshot. */
  hasOriginal(name: string): boolean
  /** Whether any client-original name was actually rewritten (vs. identity). */
  readonly hasChanges: boolean
}

const makeHash = (value: string): string => createHash("sha1").update(value).digest("hex").slice(0, HASH_LENGTH)

const getAllowedNamePattern = (allowDots: boolean): RegExp => (allowDots ? DOTTED_TOOL_NAME_CHARS_PATTERN : STRICT_TOOL_NAME_CHARS_PATTERN)

/** Replace illegal chars with `_`, collapse runs, trim edges; empty → "tool". */
const cleanToolName = (name: string, allowDots: boolean): string => {
  const invalidCharsPattern = allowDots ? /[^\w.-]/g : /[^\w-]/g
  const cleaned = name.replace(invalidCharsPattern, "_").replaceAll(/_+/g, "_")
  return cleaned.replaceAll(/^_+|_+$/g, "") || "tool"
}

const isValidToolName = (name: string, maxNameLength: number, allowDots: boolean): boolean =>
  name.length > 0 && name.length <= maxNameLength && getAllowedNamePattern(allowDots).test(name)

/** Produce a legal name for a single original name (no collision handling). */
const makeValidToolName = (name: string, maxNameLength: number, allowDots: boolean): string => {
  if (isValidToolName(name, maxNameLength, allowDots)) {
    return name
  }

  const cleaned = cleanToolName(name, allowDots)
  if (cleaned.length <= maxNameLength) {
    return cleaned
  }

  // Too long even after cleaning → truncate and append a deterministic hash.
  const hash = makeHash(name)
  const prefixLength = maxNameLength - hash.length - 1
  return `${cleaned.slice(0, prefixLength)}_${hash}`
}

/** Produce a legal name unique within `used` by appending hashed suffixes. */
const makeUniqueToolName = (name: string, used: Set<string>, maxNameLength: number, allowDots: boolean): string => {
  const candidate = makeValidToolName(name, maxNameLength, allowDots)
  if (!used.has(candidate)) {
    return candidate
  }

  for (let index = 2; ; index++) {
    const suffix = `_${makeHash(`${name}:${index}`)}`
    const prefixLength = maxNameLength - suffix.length
    const next = `${cleanToolName(name, allowDots).slice(0, prefixLength)}${suffix}`
    if (!used.has(next)) {
      return next
    }
  }
}

/**
 * Build a bidirectional tool-name mapper from the client-original tool names.
 *
 * `toolNames` is the list of **client-original custom tool names** (not tool
 * objects, and not system-injected stubs / server tools). Names are sanitized
 * in order; the first occurrence of a duplicate original name wins. Unknown
 * names passed to `toUpstream` are sanitized deterministically on the fly (so
 * stray tool_use names still map consistently); unknown names passed to
 * `toClient` are returned unchanged.
 */
export function createToolNameMapper(toolNames: ReadonlyArray<string>, opts: ToolNameMapperOptions): ToolNameMapper {
  const { allowDots, maxNameLength } = opts
  const originalToUpstream = new Map<string, string>()
  const upstreamToOriginal = new Map<string, string>()
  const used = new Set<string>()
  let hasChanges = false

  for (const name of toolNames) {
    if (originalToUpstream.has(name)) {
      continue
    }
    const upstreamName = makeUniqueToolName(name, used, maxNameLength, allowDots)
    used.add(upstreamName)
    originalToUpstream.set(name, upstreamName)
    upstreamToOriginal.set(upstreamName, name)
    if (upstreamName !== name) hasChanges = true
  }

  return {
    toUpstream: (name) => originalToUpstream.get(name) ?? makeValidToolName(name, maxNameLength, allowDots),
    toClient: (name) => upstreamToOriginal.get(name) ?? name,
    hasOriginal: (name) => originalToUpstream.has(name),
    hasChanges,
  }
}
