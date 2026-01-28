#!/usr/bin/env node

import { defineCommand } from "citty"
import consola from "consola"
import fs from "node:fs/promises"
import os from "node:os"

import { ensurePaths, PATHS } from "./lib/paths"
import { state } from "./lib/state"
import { setupGitHubToken } from "./lib/token"
import { getModels } from "./services/copilot/get-models"
import { getCopilotToken } from "./services/github/get-copilot-token"
import { getCopilotUsage } from "./services/github/get-copilot-usage"
import { getGitHubUser } from "./services/github/get-user"

interface DebugInfo {
  version: string
  runtime: {
    name: string
    version: string
    platform: string
    arch: string
  }
  paths: {
    APP_DIR: string
    GITHUB_TOKEN_PATH: string
  }
  tokenExists: boolean
  account?: {
    user: unknown
    copilot: unknown
  }
}

interface RunDebugOptions {
  json: boolean
}

async function getPackageVersion(): Promise<string> {
  try {
    const packageJsonPath = new URL("../package.json", import.meta.url).pathname
    // @ts-expect-error https://github.com/sindresorhus/eslint-plugin-unicorn/blob/v59.0.1/docs/rules/prefer-json-parse-buffer.md
    // JSON.parse() can actually parse buffers
    const packageJson = JSON.parse(await fs.readFile(packageJsonPath)) as {
      version: string
    }
    return packageJson.version
  } catch {
    return "unknown"
  }
}

function getRuntimeInfo() {
  const isBun = typeof Bun !== "undefined"

  return {
    name: isBun ? "bun" : "node",
    version: isBun ? Bun.version : process.version.slice(1),
    platform: os.platform(),
    arch: os.arch(),
  }
}

async function checkTokenExists(): Promise<boolean> {
  try {
    const stats = await fs.stat(PATHS.GITHUB_TOKEN_PATH)
    if (!stats.isFile()) return false

    const content = await fs.readFile(PATHS.GITHUB_TOKEN_PATH, "utf8")
    return content.trim().length > 0
  } catch {
    return false
  }
}

async function getAccountInfo(): Promise<{
  user: unknown
  copilot: unknown
} | null> {
  try {
    await ensurePaths()
    await setupGitHubToken()

    if (!state.githubToken) return null

    const [user, copilot] = await Promise.all([
      getGitHubUser(),
      getCopilotUsage(),
    ])

    return { user, copilot }
  } catch {
    return null
  }
}

async function getDebugInfo(includeAccount: boolean): Promise<DebugInfo> {
  const [version, tokenExists] = await Promise.all([
    getPackageVersion(),
    checkTokenExists(),
  ])

  const info: DebugInfo = {
    version,
    runtime: getRuntimeInfo(),
    paths: {
      APP_DIR: PATHS.APP_DIR,
      GITHUB_TOKEN_PATH: PATHS.GITHUB_TOKEN_PATH,
    },
    tokenExists,
  }

  if (includeAccount && tokenExists) {
    const account = await getAccountInfo()
    if (account) {
      info.account = account
    }
  }

  return info
}

function printDebugInfoPlain(info: DebugInfo): void {
  let output = `copilot-api debug

Version: ${info.version}
Runtime: ${info.runtime.name} ${info.runtime.version} (${info.runtime.platform} ${info.runtime.arch})

Paths:
- APP_DIR: ${info.paths.APP_DIR}
- GITHUB_TOKEN_PATH: ${info.paths.GITHUB_TOKEN_PATH}

Token exists: ${info.tokenExists ? "Yes" : "No"}`

  if (info.account) {
    output += `

Account Info:
${JSON.stringify(info.account, null, 2)}`
  }

  consola.info(output)
}

function printDebugInfoJson(info: DebugInfo): void {
  console.log(JSON.stringify(info, null, 2))
}

export async function runDebug(options: RunDebugOptions): Promise<void> {
  const debugInfo = await getDebugInfo(true)

  if (options.json) {
    printDebugInfoJson(debugInfo)
  } else {
    printDebugInfoPlain(debugInfo)
  }
}

// Subcommand: debug info (default behavior)
const debugInfo = defineCommand({
  meta: {
    name: "info",
    description: "Print debug information about the application",
  },
  args: {
    json: {
      type: "boolean",
      default: false,
      description: "Output debug information as JSON",
    },
  },
  run({ args }) {
    return runDebug({ json: args.json })
  },
})

// Subcommand: debug models
const debugModels = defineCommand({
  meta: {
    name: "models",
    description: "Fetch and display raw model data from Copilot API",
  },
  args: {
    "account-type": {
      type: "string",
      alias: "a",
      default: "individual",
      description:
        "The type of GitHub account (individual, business, enterprise)",
    },
    "github-token": {
      type: "string",
      alias: "g",
      description: "GitHub token to use (skips interactive auth)",
    },
  },
  async run({ args }) {
    state.accountType = args["account-type"]

    await ensurePaths()

    if (args["github-token"]) {
      state.githubToken = args["github-token"]
      consola.info("Using provided GitHub token")
    } else {
      await setupGitHubToken()
    }

    // Get Copilot token without setting up refresh interval
    const { token } = await getCopilotToken()
    state.copilotToken = token

    consola.info("Fetching models from Copilot API...")
    const models = await getModels()

    console.log(JSON.stringify(models, null, 2))
  },
})

export const debug = defineCommand({
  meta: {
    name: "debug",
    description: "Debug commands for troubleshooting",
  },
  subCommands: {
    info: debugInfo,
    models: debugModels,
  },
})
