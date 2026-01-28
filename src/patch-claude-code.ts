import { defineCommand } from "citty"
import consola from "consola"
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

// Supported Claude Code versions for patching
// Format: { pattern version -> [min version, max version (null = no upper limit)] }
const SUPPORTED_VERSIONS = {
  // v2a: function HR(A){...return 200000} pattern (2.0.0-2.1.10)
  v2a: { min: "2.0.0", max: "2.1.10" },
  // v2b: var XXX=200000 variable pattern (2.1.11+, no upper limit)
  v2b: { min: "2.1.11" },
}

// Patterns for different Claude Code versions
const PATTERNS = {
  // Function pattern (v2a: 2.0.0-2.1.10)
  funcOriginal:
    /function HR\(A\)\{if\(A\.includes\("\[1m\]"\)\)return 1e6;return 200000\}/,
  funcPatched:
    /function HR\(A\)\{if\(A\.includes\("\[1m\]"\)\)return 1e6;return \d+\}/,
  // Variable pattern (v2b: 2.1.11+)
  // Variable name changes between versions (BS9, NS9, etc.), so we match any identifier
  // The pattern matches: var <VARNAME>=200000 where it's followed by comma or appears in a sequence
  // We look for the 200000 value specifically since that's the context window limit
  variable: /var ([A-Za-z_$]\w*)=(\d+)(?=,\w+=20000,)/,
}

/**
 * Parse semver version string to comparable parts
 */
function parseVersion(version: string): Array<number> {
  return version.split(".").map((n) => Number.parseInt(n, 10) || 0)
}

/**
 * Compare two semver versions
 * Returns: -1 if a < b, 0 if a == b, 1 if a > b
 */
function compareVersions(a: string, b: string): number {
  const partsA = parseVersion(a)
  const partsB = parseVersion(b)
  const len = Math.max(partsA.length, partsB.length)

  for (let i = 0; i < len; i++) {
    const numA = partsA[i] || 0
    const numB = partsB[i] || 0
    if (numA < numB) return -1
    if (numA > numB) return 1
  }
  return 0
}

/**
 * Determine pattern type based on version
 */
type PatternType = "func" | "variable"

function getPatternTypeForVersion(version: string): PatternType | null {
  // v2a (2.0.0-2.1.10) uses function pattern
  if (
    compareVersions(version, SUPPORTED_VERSIONS.v2a.min) >= 0
    && compareVersions(version, SUPPORTED_VERSIONS.v2a.max) <= 0
  ) {
    return "func"
  }
  // v2b (2.1.11+) uses variable pattern (no upper limit)
  if (compareVersions(version, SUPPORTED_VERSIONS.v2b.min) >= 0) {
    return "variable"
  }
  return null
}

/**
 * Get supported version range string for error messages
 */
function getSupportedRangeString(): string {
  return `${SUPPORTED_VERSIONS.v2a.min}-${SUPPORTED_VERSIONS.v2a.max}, ${SUPPORTED_VERSIONS.v2b.min}+`
}

/**
 * Get Claude Code version from package.json
 */
function getClaudeCodeVersion(cliPath: string): string | null {
  try {
    const packageJsonPath = join(dirname(cliPath), "package.json")
    if (!existsSync(packageJsonPath)) return null

    const packageJson: unknown = JSON.parse(
      readFileSync(packageJsonPath, "utf8"),
    )
    if (
      typeof packageJson === "object"
      && packageJson !== null
      && "version" in packageJson
      && typeof packageJson.version === "string"
    ) {
      return packageJson.version
    }
    return null
  } catch {
    return null
  }
}

/**
 * Search volta tools directory for Claude Code
 */
function findInVoltaTools(voltaHome: string): Array<string> {
  const paths: Array<string> = []

  // Check volta packages directory (npm install -g @anthropic-ai/claude-code)
  const packagesPath = join(
    voltaHome,
    "tools",
    "image",
    "packages",
    "@anthropic-ai",
    "claude-code",
    "lib",
    "node_modules",
    "@anthropic-ai",
    "claude-code",
    "cli.js",
  )
  if (existsSync(packagesPath)) {
    paths.push(packagesPath)
  }

  // Check volta node tools directory (older installation method)
  const toolsDir = join(voltaHome, "tools", "image", "node")
  if (existsSync(toolsDir)) {
    try {
      for (const version of readdirSync(toolsDir)) {
        const claudePath = join(
          toolsDir,
          version,
          "lib",
          "node_modules",
          "@anthropic-ai",
          "claude-code",
          "cli.js",
        )
        if (existsSync(claudePath)) {
          paths.push(claudePath)
        }
      }
    } catch {
      // Ignore errors reading directory
    }
  }

  return paths
}

/**
 * Find all Claude Code CLI paths by checking common locations
 */
function findAllClaudeCodePaths(): Array<string> {
  const possiblePaths: Array<string> = []
  const home = process.env.HOME || ""

  // Check volta installation
  const voltaHome = process.env.VOLTA_HOME || join(home, ".volta")
  if (existsSync(voltaHome)) {
    possiblePaths.push(...findInVoltaTools(voltaHome))
  }

  // Check npm global installation
  const npmPrefix = process.env.npm_config_prefix
  if (npmPrefix) {
    possiblePaths.push(
      join(
        npmPrefix,
        "lib",
        "node_modules",
        "@anthropic-ai",
        "claude-code",
        "cli.js",
      ),
    )
  }

  // Check common global npm paths
  const globalPaths = [
    join(home, ".npm-global", "lib", "node_modules"),
    "/usr/local/lib/node_modules",
    "/usr/lib/node_modules",
  ]

  for (const base of globalPaths) {
    possiblePaths.push(join(base, "@anthropic-ai", "claude-code", "cli.js"))
  }

  // Check bun global installation
  const bunGlobal = join(home, ".bun", "install", "global")
  if (existsSync(bunGlobal)) {
    possiblePaths.push(
      join(bunGlobal, "node_modules", "@anthropic-ai", "claude-code", "cli.js"),
    )
  }

  // Return all existing paths (deduplicated)
  return [...new Set(possiblePaths.filter((p) => existsSync(p)))]
}

interface InstallationInfo {
  path: string
  version: string | null
  limit: number | null
}

/**
 * Get installation info for a CLI path
 */
function getInstallationInfo(cliPath: string): InstallationInfo {
  const version = getClaudeCodeVersion(cliPath)
  const content = readFileSync(cliPath, "utf8")
  const limit = getCurrentLimit(content)
  return { path: cliPath, version, limit }
}

/**
 * Get current context limit from Claude Code
 * Returns both the limit value and the variable name (for v2b pattern)
 */
interface LimitInfo {
  limit: number
  varName?: string
}

function getCurrentLimitInfo(content: string): LimitInfo | null {
  // Try variable pattern first (v2b: 2.1.11+)
  const varMatch = content.match(PATTERNS.variable)
  if (varMatch) {
    return {
      limit: Number.parseInt(varMatch[2], 10),
      varName: varMatch[1],
    }
  }

  // Try function pattern (v2a: 2.0.0-2.1.10)
  const funcMatch = content.match(PATTERNS.funcPatched)
  if (funcMatch) {
    const limitMatch = funcMatch[0].match(/return (\d+)\}$/)
    return limitMatch ? { limit: Number.parseInt(limitMatch[1], 10) } : null
  }

  return null
}

/**
 * Get current context limit from Claude Code (legacy wrapper)
 */
function getCurrentLimit(content: string): number | null {
  const info = getCurrentLimitInfo(content)
  return info?.limit ?? null
}

interface VersionCheckResult {
  supported: boolean
  version: string | null
  patternType: PatternType | null
  error?: string
}

/**
 * Check if Claude Code version is supported for patching
 */
function checkVersionSupport(cliPath: string): VersionCheckResult {
  const version = getClaudeCodeVersion(cliPath)

  if (!version) {
    return {
      supported: false,
      version: null,
      patternType: null,
      error: "Could not detect Claude Code version",
    }
  }

  const patternType = getPatternTypeForVersion(version)
  if (!patternType) {
    return {
      supported: false,
      version,
      patternType: null,
      error: `Version ${version} is not supported. Supported: ${getSupportedRangeString()}`,
    }
  }

  return { supported: true, version, patternType }
}

type PatchResult = "success" | "already_patched" | "failed"

/**
 * Patch Claude Code to use a different context limit
 */
function patchClaudeCode(cliPath: string, newLimit: number): PatchResult {
  const content = readFileSync(cliPath, "utf8")

  // Check version support
  const versionCheck = checkVersionSupport(cliPath)
  if (!versionCheck.supported) {
    consola.error(versionCheck.error)
    return "failed"
  }

  consola.info(`Claude Code version: ${versionCheck.version}`)

  // Get current limit info (includes variable name for v2b)
  const limitInfo = getCurrentLimitInfo(content)
  if (limitInfo?.limit === newLimit) {
    return "already_patched"
  }

  let newContent: string
  if (versionCheck.patternType === "variable") {
    // v2b (2.1.11+): replace var <VARNAME>=NNNN, preserving the variable name
    if (!limitInfo?.varName) {
      consola.error("Could not detect variable name for patching")
      return "failed"
    }
    newContent = content.replace(
      PATTERNS.variable,
      `var ${limitInfo.varName}=${newLimit}`,
    )
  } else {
    // v2a (2.0.0-2.1.10): replace function
    const replacement = `function HR(A){if(A.includes("[1m]"))return 1e6;return ${newLimit}}`
    const pattern =
      PATTERNS.funcOriginal.test(content) ?
        PATTERNS.funcOriginal
      : PATTERNS.funcPatched
    newContent = content.replace(pattern, replacement)
  }

  writeFileSync(cliPath, newContent)
  return "success"
}

/**
 * Restore Claude Code to original 200k limit
 */
function restoreClaudeCode(cliPath: string): boolean {
  const content = readFileSync(cliPath, "utf8")

  // Check version support
  const versionCheck = checkVersionSupport(cliPath)
  if (!versionCheck.supported) {
    consola.error(versionCheck.error)
    return false
  }

  consola.info(`Claude Code version: ${versionCheck.version}`)

  const limitInfo = getCurrentLimitInfo(content)
  if (limitInfo?.limit === 200000) {
    consola.info("Already at original 200000 limit")
    return true
  }

  let newContent: string
  if (versionCheck.patternType === "variable") {
    // v2b (2.1.11+): replace var <VARNAME>=NNNN, preserving the variable name
    if (!limitInfo?.varName) {
      consola.error("Could not detect variable name for restoring")
      return false
    }
    newContent = content.replace(
      PATTERNS.variable,
      `var ${limitInfo.varName}=200000`,
    )
  } else {
    // v2a (2.0.0-2.1.10): replace function
    const original =
      'function HR(A){if(A.includes("[1m]"))return 1e6;return 200000}'
    newContent = content.replace(PATTERNS.funcPatched, original)
  }

  writeFileSync(cliPath, newContent)
  return true
}

function showStatus(cliPath: string, currentLimit: number | null): void {
  const version = getClaudeCodeVersion(cliPath)
  if (version) {
    consola.info(`Claude Code version: ${version}`)
  }

  if (currentLimit === null) {
    consola.warn("Could not detect current limit - CLI may have been updated")
    consola.info(
      "Look for a variable like 'var XXX=200000' followed by ',YYY=20000,' in cli.js",
    )
  } else if (currentLimit === 200000) {
    consola.info("Status: Original (200k context window)")
  } else {
    consola.info(`Status: Patched (${currentLimit} context window)`)
  }
}

export const patchClaude = defineCommand({
  meta: {
    name: "patch-claude",
    description:
      "Patch Claude Code's context window limit to match Copilot's limits",
  },
  args: {
    limit: {
      alias: "l",
      type: "string",
      default: "128000",
      description:
        "Context window limit in tokens (default: 128000 for Copilot)",
    },
    restore: {
      alias: "r",
      type: "boolean",
      default: false,
      description: "Restore original 200k limit",
    },
    path: {
      alias: "p",
      type: "string",
      description:
        "Path to Claude Code cli.js (auto-detected if not specified)",
    },
    status: {
      alias: "s",
      type: "boolean",
      default: false,
      description: "Show current patch status without modifying",
    },
  },
  async run({ args }) {
    let cliPath: string

    if (args.path) {
      // User specified path directly
      cliPath = args.path
      if (!existsSync(cliPath)) {
        consola.error(`File not found: ${cliPath}`)
        process.exit(1)
      }
    } else {
      // Auto-detect installations
      const installations = findAllClaudeCodePaths()

      if (installations.length === 0) {
        consola.error("Could not find Claude Code installation")
        consola.info("Searched in: volta, npm global, bun global")
        consola.info("Use --path to specify the path to cli.js manually")
        process.exit(1)
      }

      if (installations.length === 1) {
        cliPath = installations[0]
      } else {
        // Multiple installations found, let user choose
        consola.info(`Found ${installations.length} Claude Code installations:`)
        const options = installations.map((path) => {
          const info = getInstallationInfo(path)
          let status = "unknown"
          if (info.limit === 200000) {
            status = "original"
          } else if (info.limit) {
            status = `patched: ${info.limit}`
          }
          return {
            label: `v${info.version ?? "?"} (${status}) - ${path}`,
            value: path,
          }
        })

        const selected = await consola.prompt("Select installation to patch:", {
          type: "select",
          options,
        })

        if (typeof selected === "symbol") {
          // User cancelled
          process.exit(0)
        }

        cliPath = selected
      }
    }

    consola.info(`Claude Code path: ${cliPath}`)

    // Read current status
    const content = readFileSync(cliPath, "utf8")
    const currentLimit = getCurrentLimit(content)

    if (args.status) {
      showStatus(cliPath, currentLimit)
      return
    }

    if (args.restore) {
      if (restoreClaudeCode(cliPath)) {
        consola.success("Restored to original 200k limit")
      } else {
        consola.error("Failed to restore - pattern not found")
        consola.info("Claude Code may have been updated to a new version")
        process.exit(1)
      }
      return
    }

    const limit = Number.parseInt(args.limit, 10)
    if (Number.isNaN(limit) || limit < 1000) {
      consola.error("Invalid limit value. Must be a number >= 1000")
      process.exit(1)
    }

    const result = patchClaudeCode(cliPath, limit)
    if (result === "success") {
      consola.success(
        `Patched context window: ${currentLimit ?? 200000} → ${limit}`,
      )
      consola.info(
        "Note: You may need to re-run this after Claude Code updates",
      )
    } else if (result === "already_patched") {
      consola.success(`Already patched with limit ${limit}`)
    } else {
      consola.error("Failed to patch - pattern not found")
      consola.info("Claude Code may have been updated to a new version")
      process.exit(1)
    }
  },
})
