import { defineCommand } from "citty"
import consola from "consola"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"

/**
 * Get Claude Code version from package.json
 */
function getClaudeCodeVersion(cliPath: string): string | null {
  try {
    const packageJsonPath = join(dirname(cliPath), "package.json")
    if (!existsSync(packageJsonPath)) return null

    const packageJson: unknown = JSON.parse(readFileSync(packageJsonPath, "utf8"))
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
        const claudePath = join(toolsDir, version, "lib", "node_modules", "@anthropic-ai", "claude-code", "cli.js")
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
    possiblePaths.push(join(npmPrefix, "lib", "node_modules", "@anthropic-ai", "claude-code", "cli.js"))
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
    possiblePaths.push(join(bunGlobal, "node_modules", "@anthropic-ai", "claude-code", "cli.js"))
  }

  // Return all existing paths (deduplicated)
  return [...new Set(possiblePaths.filter((p) => existsSync(p)))]
}

export const listClaudeCode = defineCommand({
  meta: {
    name: "list-claude-code",
    description: "List all locally installed Claude Code versions",
  },
  run() {
    const installations = findAllClaudeCodePaths()

    if (installations.length === 0) {
      consola.info("No Claude Code installations found")
      consola.info("Searched in: volta, npm global, bun global")
      return
    }

    consola.info(`Found ${installations.length} Claude Code installation(s):`)

    for (const [i, path] of installations.entries()) {
      const version = getClaudeCodeVersion(path) ?? "unknown"
      consola.info(`  ${i + 1}. v${version}  ${path}`)
    }
  },
})
