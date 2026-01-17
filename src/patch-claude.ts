import { defineCommand } from "citty"
import consola from "consola"
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

// Supported Claude Code versions for patching
// Format: { pattern version -> [min version, max version] }
const SUPPORTED_VERSIONS = {
  // v2a: function HR(A){...return 200000} pattern (2.0.0-2.1.10)
  v2a: { min: "2.0.0", max: "2.1.10" },
  // v2b: var BS9=200000 variable pattern (2.1.11+)
  v2b: { min: "2.1.11", max: "2.1.12" }, // Update max when new versions are verified
}

// Patterns for different Claude Code versions
const PATTERNS = {
  // Function pattern (v2a: 2.0.0-2.1.10)
  funcOriginal:
    /function HR\(A\)\{if\(A\.includes\("\[1m\]"\)\)return 1e6;return 200000\}/,
  funcPatched:
    /function HR\(A\)\{if\(A\.includes\("\[1m\]"\)\)return 1e6;return \d+\}/,
  // Variable pattern (v2b: 2.1.11+)
  variable: /var BS9=(\d+)/,
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
  // v2b (2.1.11+) uses variable pattern
  if (
    compareVersions(version, SUPPORTED_VERSIONS.v2b.min) >= 0
    && compareVersions(version, SUPPORTED_VERSIONS.v2b.max) <= 0
  ) {
    return "variable"
  }
  return null
}

/**
 * Get supported version range string for error messages
 */
function getSupportedRangeString(): string {
  return `${SUPPORTED_VERSIONS.v2a.min}-${SUPPORTED_VERSIONS.v2a.max}, ${SUPPORTED_VERSIONS.v2b.min}-${SUPPORTED_VERSIONS.v2b.max}`
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
 * Find Claude Code CLI path by checking common locations
 */
function findClaudeCodePath(): string | null {
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

  // Return the first existing path
  return possiblePaths.find((p) => existsSync(p)) ?? null
}

/**
 * Get current context limit from Claude Code
 */
function getCurrentLimit(content: string): number | null {
  // Try variable pattern first (v2b: 2.1.11+)
  const varMatch = content.match(PATTERNS.variable)
  if (varMatch) {
    return Number.parseInt(varMatch[1], 10)
  }

  // Try function pattern (v2a: 2.0.0-2.1.10)
  const funcMatch = content.match(PATTERNS.funcPatched)
  if (funcMatch) {
    const limitMatch = funcMatch[0].match(/return (\d+)\}$/)
    return limitMatch ? Number.parseInt(limitMatch[1], 10) : null
  }

  return null
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

/**
 * Patch Claude Code to use a different context limit
 */
function patchClaudeCode(cliPath: string, newLimit: number): boolean {
  const content = readFileSync(cliPath, "utf8")

  // Check version support
  const versionCheck = checkVersionSupport(cliPath)
  if (!versionCheck.supported) {
    consola.error(versionCheck.error)
    return false
  }

  consola.info(`Claude Code version: ${versionCheck.version}`)

  // Check if already patched with the same value
  const currentLimit = getCurrentLimit(content)
  if (currentLimit === newLimit) {
    consola.info(`Already patched with limit ${newLimit}`)
    return true
  }

  let newContent: string
  if (versionCheck.patternType === "variable") {
    // v2b (2.1.11+): replace var BS9=NNNN
    newContent = content.replace(PATTERNS.variable, `var BS9=${newLimit}`)
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
  return true
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

  const currentLimit = getCurrentLimit(content)
  if (currentLimit === 200000) {
    consola.info("Already at original 200000 limit")
    return true
  }

  let newContent: string
  if (versionCheck.patternType === "variable") {
    // v2b (2.1.11+): replace var BS9=NNNN
    newContent = content.replace(PATTERNS.variable, "var BS9=200000")
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
    consola.info("Look for the BS9 variable or HR function pattern in cli.js")
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
  run({ args }) {
    // Find Claude Code path
    const cliPath = args.path || findClaudeCodePath()

    if (!cliPath) {
      consola.error("Could not find Claude Code installation")
      consola.info("Searched in: volta, npm global, bun global")
      consola.info("Use --path to specify the path to cli.js manually")
      process.exit(1)
    }

    if (!existsSync(cliPath)) {
      consola.error(`File not found: ${cliPath}`)
      process.exit(1)
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

    if (patchClaudeCode(cliPath, limit)) {
      consola.success(`Patched context window: 200000 → ${limit}`)
      consola.info(
        "Note: You may need to re-run this after Claude Code updates",
      )
    } else {
      consola.error("Failed to patch - pattern not found")
      consola.info("Claude Code may have been updated to a new version")
      consola.info("Check the cli.js for the HR function pattern")
      process.exit(1)
    }
  },
})
