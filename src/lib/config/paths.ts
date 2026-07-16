import { statSync } from "node:fs"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

function computeAppDir(): string {
  const override = process.env.XDG_DATA_HOME
  const base = override && override.length > 0 ? override : path.join(os.homedir(), ".local", "share")
  return path.join(base, "copilot-api")
}

const APP_DIR = computeAppDir()

const GITHUB_TOKEN_PATH = path.join(APP_DIR, "github_token")

/**
 * Resolve the Codex CLI home directory, honoring `CODEX_HOME` when set
 * (mirrors Codex's own resolution), falling back to `~/.codex`.
 */
function computeCodexHome(): string {
  const override = process.env.CODEX_HOME
  return override && override.length > 0 ? override : path.join(os.homedir(), ".codex")
}

/**
 * Locate the bundled default `config.yaml` shipped inside the npm package.
 *
 * Walks up from the current module file looking for `config.yaml`. Works in
 * both modes:
 *   - dev (`bun run src/main.ts`):  src/lib/config/paths.ts → walks up to repo root
 *   - prod (`node dist/main.mjs`):  dist/main.mjs (this module is bundled into
 *                                   it by tsdown) → walks up to package root
 *
 * Returns the resolved absolute path. Throws if not found within 6 levels —
 * indicates a broken install (config.yaml stripped from the package).
 */
function locateBundledConfig(): string {
  const startDir = import.meta.dirname
  let dir = startDir
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, "config.yaml")
    try {
      // sync stat is acceptable: module load happens once at startup
      const stats = statSync(candidate)
      if (stats.isFile()) return candidate
    } catch {
      // not found at this level; keep walking
    }
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  throw new Error(`[paths] Bundled config.yaml not found; searched upward from ${startDir}. This indicates a broken install.`)
}

export const PATHS = {
  APP_DIR,
  GITHUB_TOKEN_PATH,
  /** User config file (override). May not exist; absent → use bundled defaults. */
  CONFIG_YAML: path.join(APP_DIR, "config.yaml"),
  /** Bundled default config.yaml that ships with the package. */
  BUNDLED_CONFIG_YAML: locateBundledConfig(),
  LEARNED_LIMITS: path.join(APP_DIR, "learned-limits.json"),
  REQUEST_TELEMETRY: path.join(APP_DIR, "request-telemetry.json"),
  /** Independent SQLite DB for tiered telemetry (raw/hourly/daily rollup + cumulative). Own retention lifecycle, separate from history.db. `REQUEST_TELEMETRY` (legacy JSON) is read only for migration/backfill. */
  TELEMETRY_DB: path.join(APP_DIR, "telemetry.db"),
  NEGOTIATION_STATES: path.join(APP_DIR, "negotiation-states.json"),
  /** Legacy V2 artifact. The online server must not open, migrate, or delete it. */
  HISTORY_DB: path.join(APP_DIR, "history.db"),
  /** Online History V3 store. Starts empty and never backfills from HISTORY_DB. */
  HISTORY_V3_DB: path.join(APP_DIR, "history-v3.db"),
  /** Sidecar SQLite DB for the durable (session,agent) thinking-quarantine store (L3). */
  THINKING_QUARANTINE_DB: path.join(APP_DIR, "thinking-quarantine.db"),
  /** Rotating file log for non-HTTP consola output (startup, auth, warnings, errors). */
  COPILOT_LOG: path.join(APP_DIR, "copilot-api.log"),
  /** Codex CLI config file (`$CODEX_HOME/config.toml`, default `~/.codex/config.toml`). */
  CODEX_CONFIG_TOML: path.join(computeCodexHome(), "config.toml"),
}

export async function ensurePaths(): Promise<void> {
  await fs.mkdir(PATHS.APP_DIR, { recursive: true })
  await ensureFile(PATHS.GITHUB_TOKEN_PATH)
}

async function ensureFile(filePath: string): Promise<void> {
  const isWindows = process.platform === "win32"
  try {
    await fs.access(filePath, fs.constants.W_OK)
    // File exists — on Unix, ensure secure permissions (owner read/write only).
    // Windows NTFS doesn't support Unix permission bits; chmod is a no-op and
    // stat.mode returns a synthetic value (e.g. 0o666), so skip the check entirely.
    if (!isWindows) {
      const stats = await fs.stat(filePath)
      const currentMode = stats.mode & 0o777
      if (currentMode !== 0o600) {
        await fs.chmod(filePath, 0o600)
      }
    }
  } catch {
    await fs.writeFile(filePath, "")
    if (!isWindows) {
      await fs.chmod(filePath, 0o600)
    }
  }
}
