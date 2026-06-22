/**
 * Bun test preload — redirect ALL `APP_DIR`-derived persistence (feature-
 * negotiation cache, history.db, logs, learned-limits, request-telemetry,
 * config.yaml) to an ephemeral temp dir so NO test can read or clobber the
 * operator's real `~/.local/share/copilot-api`.
 *
 * Must run BEFORE any `src` module computes `PATHS` — `config/paths.ts`'s
 * `computeAppDir()` reads `XDG_DATA_HOME` at module-load time, so setting it
 * here (registered via `bunfig.toml [test].preload`, which Bun loads before any
 * test file and its imports) deterministically redirects every derived path.
 *
 * Why this exists: persistence is keyed off `XDG_DATA_HOME`. Several tests
 * mark/reset the feature-negotiation cache (`markAnthropic*Unsupported`,
 * `resetAnthropicFeatureNegotiationForTesting`) without individually sandboxing
 * `PATHS.NEGOTIATION_STATES`; `reset` persists the (cleared) maps to disk, so a
 * plain `bun test` run was overwriting the operator's real
 * `negotiation-states.json` with an empty snapshot — wiping every learned beta /
 * partner-feature / effort negotiation. The operator then re-learned (4 retries)
 * on the next request after each restart. This preload makes that impossible for
 * every test, present and future, and for every APP_DIR-derived file.
 *
 * Per-test sandboxes that set `PATHS.X = <their own tmp>` still work — they
 * override further; this is the floor, not a replacement.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const SANDBOX_MARKER = "copilot-api-test-sandbox-"

// Idempotent: a nested `bun test` (or a re-preload) must not re-root.
if (!process.env.XDG_DATA_HOME || !process.env.XDG_DATA_HOME.includes(SANDBOX_MARKER)) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), SANDBOX_MARKER))
  // `computeAppDir()` appends `copilot-api`; pre-create it so the first
  // atomic write (which does not mkdir) has a directory to land in.
  fs.mkdirSync(path.join(root, "copilot-api"), { recursive: true })
  process.env.XDG_DATA_HOME = root
  // `CODEX_CONFIG_TOML` is derived from `CODEX_HOME` (→ `~/.codex`), NOT from
  // `XDG_DATA_HOME` (see config/paths.ts `computeCodexHome`). Redirecting only
  // XDG would leave `~/.codex/config.toml` as a floor blind spot: any test (or
  // setup-codex command path) that falls back to the default `PATHS.CODEX_CONFIG_TOML`
  // would write the operator's real `~/.codex`. Pin CODEX_HOME into the same
  // sandbox so that path is floored too. (Current codex tests inject an explicit
  // `configPath`, so this is defense-in-depth, not a fix for a live leak.)
  const codexHome = path.join(root, ".codex")
  fs.mkdirSync(codexHome, { recursive: true })
  process.env.CODEX_HOME = codexHome
}
