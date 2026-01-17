import { defineCommand } from "citty"
import consola from "consola"
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

// Pattern to match Claude Code's context window function
const ORIGINAL_PATTERN =
  /function HR\(A\)\{if\(A\.includes\("\[1m\]"\)\)return 1e6;return 200000\}/
const PATCHED_PATTERN =
  /function HR\(A\)\{if\(A\.includes\("\[1m\]"\)\)return 1e6;return \d+\}/

/**
 * Search volta tools directory for Claude Code
 */
function findInVoltaTools(voltaHome: string): Array<string> {
  const paths: Array<string> = []
  const toolsDir = join(voltaHome, "tools", "image", "node")

  if (!existsSync(toolsDir)) return paths

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
  const match = content.match(PATCHED_PATTERN)
  if (!match) return null

  const limitMatch = match[0].match(/return (\d+)\}$/)
  return limitMatch ? Number.parseInt(limitMatch[1], 10) : null
}

/**
 * Patch Claude Code to use a different context limit
 */
function patchClaudeCode(cliPath: string, newLimit: number): boolean {
  const content = readFileSync(cliPath, "utf8")

  // Check if already patched with the same value
  const currentLimit = getCurrentLimit(content)
  if (currentLimit === newLimit) {
    consola.info(`Already patched with limit ${newLimit}`)
    return true
  }

  // Try to patch
  const replacement = `function HR(A){if(A.includes("[1m]"))return 1e6;return ${newLimit}}`

  let newContent: string
  if (ORIGINAL_PATTERN.test(content)) {
    newContent = content.replace(ORIGINAL_PATTERN, replacement)
  } else if (PATCHED_PATTERN.test(content)) {
    newContent = content.replace(PATCHED_PATTERN, replacement)
  } else {
    return false
  }

  writeFileSync(cliPath, newContent)
  return true
}

/**
 * Restore Claude Code to original 200k limit
 */
function restoreClaudeCode(cliPath: string): boolean {
  const content = readFileSync(cliPath, "utf8")

  const currentLimit = getCurrentLimit(content)
  if (currentLimit === 200000) {
    consola.info("Already at original 200000 limit")
    return true
  }

  if (!PATCHED_PATTERN.test(content)) {
    return false
  }

  const original =
    'function HR(A){if(A.includes("[1m]"))return 1e6;return 200000}'
  const newContent = content.replace(PATCHED_PATTERN, original)
  writeFileSync(cliPath, newContent)
  return true
}

function showStatus(currentLimit: number | null): void {
  if (currentLimit === null) {
    consola.warn("Could not detect current limit - CLI may have been updated")
    consola.info("Look for the HR function pattern in cli.js")
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
      showStatus(currentLimit)
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
