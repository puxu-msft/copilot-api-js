/**
 * Managed-block writer for Codex CLI's `~/.codex/config.toml`.
 *
 * Hand-rolled TOML string assembly (no TOML dependency) so user comments and
 * formatting outside the managed markers are preserved byte-for-byte — a TOML
 * serializer cannot round-trip comments. The managed block holds only the
 * proxy provider wiring (`model_provider` scalar + `[model_providers.ghc]`
 * table); user-owned scalars (`model`, `model_reasoning_effort`) live OUTSIDE
 * the block to avoid TOML duplicate-key errors, and are only written when the
 * caller supplies them and the user has not already declared them.
 *
 * `applyCodexConfig` is a pure function (no fs/network) — the caller reads the
 * existing file and persists the result. This keeps the algorithm fully
 * unit-testable without touching the real filesystem.
 */

/** Provider id used for the Copilot API proxy in Codex config. */
const PROVIDER_ID = "ghc"

const BEGIN_MARK = "# >>> copilot-api managed block — auto-generated, do not edit between markers >>>"
const END_MARK = "# <<< copilot-api managed block — edits outside this block are preserved <<<"

/**
 * Legacy markers from earlier releases (and the upstream copilot-bridge
 * project we forked the approach from). Recognized and stripped so upgrading
 * users never end up with duplicate managed blocks.
 */
const LEGACY_MARKER_PAIRS: ReadonlyArray<readonly [string, string]> = [
  [
    "# >>> copilot-bridge managed block — auto-generated, do not edit between markers >>>",
    "# <<< copilot-bridge managed block — edits outside this block are preserved <<<",
  ],
  ["# >>> copilot-bridge managed (do not edit) >>>", "# <<< copilot-bridge managed (do not edit) <<<"],
]

/** Top-level scalar keys owned by the user / Codex itself — never inside our block. */
type UserScalar = "model" | "model_reasoning_effort"

/** Input for {@link applyCodexConfig}. */
export interface ApplyCodexConfigInput {
  /** Proxy base URL (Codex needs the `/v1` suffix, e.g. `http://localhost:4141/v1`). */
  baseUrl: string
  /** Current file content (empty string when the file is missing or unreadable). */
  existingContent: string
  /** Optional default model to write as a user-owned scalar (outside the block). */
  model?: string
  /** Optional reasoning effort to write as a user-owned scalar (outside the block). */
  modelReasoningEffort?: string
}

/** Result of {@link applyCodexConfig}. */
export interface ApplyCodexConfigResult {
  /** The full file content to persist. */
  content: string
  /** Whether `content` differs from `existingContent`. */
  changed: boolean
}

/** Escape a string for use inside a TOML basic (double-quoted) string. */
function tomlEscape(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', String.raw`\"`)
}

/** Build the managed block text (markers + provider wiring). */
function buildManagedBlock(baseUrl: string): string {
  return [
    BEGIN_MARK,
    `model_provider = "${PROVIDER_ID}"`,
    "",
    `[model_providers.${PROVIDER_ID}]`,
    `name = "${PROVIDER_ID}"`,
    `base_url = "${tomlEscape(baseUrl)}"`,
    `wire_api = "responses"`,
    `preferred_auth_method = "apikey"`,
    END_MARK,
  ].join("\n")
}

/**
 * Remove a marker-delimited block (and every repeat of it) from `content`,
 * collapsing the surrounding blank lines. Content outside the markers is kept.
 */
function stripMarkerBlock(content: string, begin: string, end: string): string {
  let next = content
  while (true) {
    const beginIdx = next.indexOf(begin)
    if (beginIdx === -1) break
    const endIdx = next.indexOf(end, beginIdx)
    if (endIdx === -1) break
    const before = next.slice(0, beginIdx).replace(/\n*$/, "")
    const after = next.slice(endIdx + end.length).replace(/^\n+/, "")
    if (before.length === 0) next = after
    else if (after.length === 0) next = `${before}\n`
    else next = `${before}\n\n${after}`
  }
  return next
}

/** Strip the current managed block plus all known legacy blocks. */
function stripAllManagedBlocks(content: string): string {
  let next = stripMarkerBlock(content, BEGIN_MARK, END_MARK)
  for (const [begin, end] of LEGACY_MARKER_PAIRS) {
    next = stripMarkerBlock(next, begin, end)
  }
  return next
}

/**
 * Split content into the top-level section (everything before the first TOML
 * table header `[...]`) and the rest. Codex's own top-level scalars
 * (`model`, `model_reasoning_effort`) live in the top section.
 */
function splitTopSection(content: string): { top: string; rest: string } {
  const lines = content.split("\n")
  let cut = lines.length
  for (const [i, line] of lines.entries()) {
    if (/^\s*\[/.test(line)) {
      cut = i
      break
    }
  }
  return { top: lines.slice(0, cut).join("\n"), rest: lines.slice(cut).join("\n") }
}

/** Regex matching a top-level `key = "value"` scalar line. */
function scalarRegex(key: string): RegExp {
  return new RegExp(`^\\s*${key}\\s*=`, "m")
}

/** Remove every top-level `key = ...` line from a section (whole line). */
function removeTopLevelScalarLine(section: string, key: string): string {
  return section
    .split("\n")
    .filter((line) => !new RegExp(`^\\s*${key}\\s*=`).test(line))
    .join("\n")
}

/** Whether a line opens a TOML table (`[x]`) or array-of-tables (`[[x]]`) header. */
function isTomlTableHeader(line: string): boolean {
  return /^\s*\[\[?/.test(line)
}

/**
 * Parse a single-bracket table header line `[a.b.c]` into its normalized dotted
 * key (whitespace + surrounding quotes stripped per segment), or `null` when the
 * line is not a plain table header (e.g. array-of-tables `[[x]]`, or non-header).
 */
function parseTomlTableKey(line: string): string | null {
  const match = /^\s*\[([^[\]]+)\]\s*(?:#.*)?$/.exec(line)
  if (!match) return null
  return match[1]
    .split(".")
    .map((segment) => segment.trim().replaceAll(/^["']|["']$/g, ""))
    .join(".")
}

/**
 * Remove every occurrence of the TOML table `[<tableKey>]` (its header line plus
 * the body up to the next table header or EOF) from a section. Used to drop a
 * stray out-of-block `[model_providers.ghc]` the user wrote by hand — our managed
 * block re-declares that exact table, and two definitions are a TOML
 * `redefinition of table` error that breaks Codex's config load entirely.
 *
 * Only the exact-key single-bracket table is removed: sub-tables like
 * `[model_providers.ghc.x]` and array-of-tables `[[...]]` are different TOML
 * entities and are preserved.
 */
function removeTomlTable(section: string, tableKey: string): string {
  const lines = section.split("\n")
  const out: Array<string> = []
  let i = 0
  while (i < lines.length) {
    if (parseTomlTableKey(lines[i]) === tableKey) {
      i++ // skip the header
      while (i < lines.length && !isTomlTableHeader(lines[i])) i++ // skip the body
      // Consume blank lines immediately after the removed body so the seam
      // doesn't fuse a preceding blank with a trailing one into a double blank.
      // This is local to the removal site — user blank lines elsewhere in the
      // section are left byte-for-byte intact (no global reformat).
      while (i < lines.length && lines[i].trim() === "") i++
      continue
    }
    out.push(lines[i])
    i++
  }
  return out.join("\n")
}

/**
 * Write a user-owned scalar into the top section ONLY when the caller supplied
 * a value AND the key is not already present in the top section (duplicate-key
 * guard). The guard inspects only the top-level section (before the first TOML
 * table header) so a same-named key scoped inside a table — e.g.
 * `[profiles.fast]\nmodel = "..."` — does not suppress writing the top-level
 * default. When the user already declares it at top level, their value wins.
 */
function applyUserScalar(topSection: string, key: UserScalar, value: string | undefined): string {
  if (value === undefined) return topSection
  if (scalarRegex(key).test(topSection)) return topSection
  const line = `${key} = "${tomlEscape(value)}"`
  if (topSection.length === 0) return `${line}\n`
  return `${line}\n${topSection}`
}

/** Join non-empty parts with a blank line between them, trimming stray edges. */
function joinParts(parts: ReadonlyArray<string>): string {
  const cleaned = parts.map((part) => part.replaceAll(/^\n+|\n+$/g, "")).filter(Boolean)
  return cleaned.length === 0 ? "" : `${cleaned.join("\n\n")}\n`
}

/**
 * Compute the new `config.toml` content with the Copilot API managed block
 * applied. Pure function — performs no I/O.
 *
 * Algorithm:
 *  1. Strip the current managed block and all known legacy blocks (preserving
 *     user content outside the markers byte-for-byte).
 *  2. Remove any stray top-level `model_provider` scalar left outside the block
 *     (our managed block owns it — keeping a second one would be a TOML
 *     duplicate-key error). Table headers like `[model_providers.x]` are kept.
 *  3. Remove any stray out-of-block `[model_providers.ghc]` table the user wrote
 *     by hand (e.g. following the old README): our managed block re-declares that
 *     exact table, and two definitions are a fatal TOML `redefinition of table`
 *     error. Other providers' tables (`[model_providers.openai]`, sub-tables,
 *     array-of-tables) are preserved.
 *  4. Apply user-owned scalars (`model`, `model_reasoning_effort`) into the
 *     top section, guarded against TOML duplicate keys (top-level only).
 *  5. Re-emit as `<top> <managed-block> <rest>`, then a trailing newline.
 *
 * Never overwrites or reformats content outside the managed markers.
 */
export function applyCodexConfig(input: ApplyCodexConfigInput): ApplyCodexConfigResult {
  const { baseUrl, existingContent, model, modelReasoningEffort } = input

  const stripped = stripAllManagedBlocks(existingContent)
  const { top, rest } = splitTopSection(stripped)

  // Our managed block declares the top-level `model_provider`; drop any stray
  // top-level one the user wrote outside the block to avoid a duplicate key.
  let nextTop = removeTopLevelScalarLine(top, "model_provider")
  nextTop = applyUserScalar(nextTop, "model", model)
  nextTop = applyUserScalar(nextTop, "model_reasoning_effort", modelReasoningEffort)

  // Our managed block re-declares `[model_providers.ghc]`; drop any out-of-block
  // copy so Codex doesn't hit a `redefinition of table` error.
  const nextRest = removeTomlTable(rest, `model_providers.${PROVIDER_ID}`)

  const block = buildManagedBlock(baseUrl)
  const content = joinParts([nextTop, block, nextRest])

  return { content, changed: content !== existingContent }
}
