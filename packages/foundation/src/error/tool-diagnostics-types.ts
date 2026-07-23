/**
 * Upstream tool-schema diagnostics — the pure DATA shape (SoT).
 *
 * The behavior that produces it (`summarizeToolsForDiagnostics` /
 * `logToolDiagnostics`) stays in core `upstream-diagnostics.ts` (it reads
 * `state`); only this type lives in foundation so `http-error` (a foundation
 * leaf) can reference it without a foundation→core edge. Core consumers keep
 * importing `ToolDiagnostics` via `~/lib/upstream-diagnostics` (re-export).
 */

/** Diagnostics summary for the tools sent on a failing (400) upstream request. */
export interface ToolDiagnostics {
  /** Total number of tools sent on the request. */
  count: number
  /** Tool names not matching `^[A-Za-z0-9_-]{1,64}$` (capped at MAX_DIAGNOSTIC_ITEMS). */
  invalidNames?: Array<string>
  /** Per-tool list of suspicious schema-keyword paths (capped at MAX_DIAGNOSTIC_ITEMS). */
  suspiciousSchemas?: Array<{ name: string; keys: Array<string> }>
}
