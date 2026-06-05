#!/usr/bin/env node

import { defineCommand } from "citty"
import consola from "consola"
import fs from "node:fs/promises"
import os from "node:os"

import { applyConfigToState } from "./lib/config/config"
import {
  //
  ensurePaths,
  PATHS,
} from "./lib/config/paths"
import { getModels } from "./lib/models/client"
import { initProxy } from "./lib/proxy"
import {
  //
  setCliState,
  setCopilotToken,
  setGitHubToken,
  state,
} from "./lib/state"
import { GitHubTokenManager } from "./lib/token"
import {
  //
  getCopilotToken,
  getCopilotUsage,
  type QuotaDetail,
} from "./lib/token/copilot-client"
import { getGitHubUser } from "./lib/token/github-client"

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

    // Use GitHubTokenManager to get token
    const tokenManager = new GitHubTokenManager()
    const tokenInfo = await tokenManager.getToken()
    setGitHubToken(tokenInfo.token)

    if (!state.githubToken) return null

    const [user, copilot] = await Promise.all([getGitHubUser(), getCopilotUsage()])

    return { user, copilot }
  } catch {
    return null
  }
}

async function getDebugInfo(includeAccount: boolean): Promise<DebugInfo> {
  const [version, tokenExists] = await Promise.all([getPackageVersion(), checkTokenExists()])

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

/** Subcommand: debug info (default behavior) */
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

/** Subcommand: debug models */
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
      description: "The type of GitHub account (individual, business, enterprise)",
    },
    "github-token": {
      type: "string",
      alias: "g",
      description: "GitHub token to use (skips interactive auth)",
    },
  },
  async run({ args }) {
    setCliState({ accountType: args["account-type"] as "individual" | "business" | "enterprise" })

    await ensurePaths()

    if (args["github-token"]) {
      setGitHubToken(args["github-token"])
      consola.info("Using provided GitHub token")
    } else {
      // Use GitHubTokenManager to get token
      const tokenManager = new GitHubTokenManager()
      const tokenInfo = await tokenManager.getToken()
      setGitHubToken(tokenInfo.token)
    }

    // Get Copilot token without setting up refresh interval
    const { token } = await getCopilotToken()
    setCopilotToken(token)

    const models = await getModels()

    console.log(JSON.stringify(models, null, 2))
  },
})

/** Subcommand: debug usage */
const debugUsage = defineCommand({
  meta: {
    name: "usage",
    description: "Show current GitHub Copilot usage/quota information",
  },
  args: {
    json: {
      type: "boolean",
      default: false,
      description: "Print the raw /copilot_internal/user response as JSON",
    },
  },
  async run({ args }) {
    await ensurePaths()

    // Load config and initialize proxy before any network requests
    const config = await applyConfigToState()
    if (config.proxy) {
      initProxy({ url: config.proxy, fromEnv: false })
    } else {
      initProxy({ url: undefined, fromEnv: true })
    }

    // Use GitHubTokenManager to get token
    const tokenManager = new GitHubTokenManager()
    const tokenInfo = await tokenManager.getToken()
    setGitHubToken(tokenInfo.token)

    // Show logged in user
    const user = await getGitHubUser()
    consola.info(`Logged in as ${user.login}`)

    try {
      const usage = await getCopilotUsage()

      if (args.json) {
        console.log(JSON.stringify(usage, null, 2))
        return
      }

      // Per-bucket formatter. GHC may omit `quota_snapshots` entirely (free /
      // expired accounts), and even when present individual buckets may be
      // absent. We iterate over every bucket actually returned (including
      // dynamic ones) rather than hard-coding a fixed list — upstream may
      // add buckets without notice.
      function summarizeQuota(name: string, snap: QuotaDetail): string {
        if (snap.unlimited) {
          const tags: Array<string> = ["unlimited"]
          if (snap.token_based_billing) tags.push("payg")
          return `${name}: ${tags.join(", ")}`
        }
        const total = snap.entitlement
        const used = total - snap.remaining
        const percentUsed = total > 0 ? (used / total) * 100 : 0
        const percentRemaining = snap.percent_remaining
        const extras: Array<string> = []
        if (snap.overage_count > 0) extras.push(`overage ${snap.overage_count}`)
        if (snap.overage_permitted) extras.push("overage allowed")
        if (snap.token_based_billing) extras.push("payg")
        const suffix = extras.length > 0 ? ` [${extras.join(", ")}]` : ""
        return `${name}: ${used}/${total} used (${percentUsed.toFixed(1)}% used, ${percentRemaining.toFixed(1)}% remaining)${suffix}`
      }

      // Friendly labels for known buckets; anything else falls back to its raw key.
      const BUCKET_LABELS: Record<string, string> = {
        chat: "Chat",
        completions: "Completions",
        premium_interactions: "Premium Interactions",
        premium_models: "Premium Models",
      }

      const snapshots = usage.quota_snapshots
      const quotaLines: Array<string> = []
      if (snapshots) {
        for (const [key, snap] of Object.entries(snapshots)) {
          if (!snap) continue
          const label = BUCKET_LABELS[key] ?? key
          quotaLines.push(`  ${summarizeQuota(label, snap)}`)
        }
      }
      const quotaSection =
        quotaLines.length > 0 ? `\nQuotas:\n${quotaLines.join("\n")}` : `\nQuotas: none reported by upstream`

      // Account-level facts. `organization_list` / `organization_login_list`
      // are typed as unknown[] so we only show counts; users who need details
      // can pass --json.
      const accountFacts: Array<string> = [
        `Plan: ${usage.copilot_plan}`,
        `SKU: ${usage.access_type_sku}`,
        `Assigned: ${usage.assigned_date}`,
        `Chat enabled: ${usage.chat_enabled ? "yes" : "no"}`,
        `Token-based billing (account): ${usage.token_based_billing ? "yes" : "no"}`,
        `Can sign up for limited: ${usage.can_signup_for_limited ? "yes" : "no"}`,
      ]
      const orgCount = usage.organization_list.length
      if (orgCount > 0) accountFacts.push(`Organizations: ${orgCount}`)
      if (usage.analytics_tracking_id) accountFacts.push(`Analytics ID: ${usage.analytics_tracking_id}`)

      const resetLine = usage.quota_reset_date ? `\nQuota resets: ${usage.quota_reset_date}` : ""

      consola.box(`Copilot Usage\n\n${accountFacts.map((l) => `  ${l}`).join("\n")}${resetLine}${quotaSection}`)
    } catch (err) {
      consola.error("Failed to fetch Copilot usage:", err)
      process.exit(1)
    }
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
    usage: debugUsage,
  },
})
