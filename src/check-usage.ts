import { defineCommand } from "citty"
import consola from "consola"

import { applyConfigToState } from "./lib/config/config"
import { ensurePaths } from "./lib/config/paths"
import { initProxy } from "./lib/proxy"
import { setGitHubToken } from "./lib/state"
import { GitHubTokenManager } from "./lib/token"
import { getCopilotUsage, type QuotaDetail } from "./lib/token/copilot-client"
import { getGitHubUser } from "./lib/token/github-client"

export const checkUsage = defineCommand({
  meta: {
    name: "check-usage",
    description: "Show current GitHub Copilot usage/quota information",
  },
  async run() {
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
      const premium = usage.quota_snapshots.premium_interactions
      const premiumTotal = premium.entitlement
      const premiumUsed = premiumTotal - premium.remaining
      const premiumPercentUsed = premiumTotal > 0 ? (premiumUsed / premiumTotal) * 100 : 0
      const premiumPercentRemaining = premium.percent_remaining

      // Helper to summarize a quota snapshot
      function summarizeQuota(name: string, snap: QuotaDetail | undefined) {
        if (!snap) return `${name}: N/A`
        const total = snap.entitlement
        const used = total - snap.remaining
        const percentUsed = total > 0 ? (used / total) * 100 : 0
        const percentRemaining = snap.percent_remaining
        return `${name}: ${used}/${total} used (${percentUsed.toFixed(1)}% used, ${percentRemaining.toFixed(1)}% remaining)`
      }

      const premiumLine = `Premium: ${premiumUsed}/${premiumTotal} used (${premiumPercentUsed.toFixed(1)}% used, ${premiumPercentRemaining.toFixed(1)}% remaining)`
      const chatLine = summarizeQuota("Chat", usage.quota_snapshots.chat)
      const completionsLine = summarizeQuota("Completions", usage.quota_snapshots.completions)

      consola.box(
        `Copilot Usage (plan: ${usage.copilot_plan})\n`
          + `Quota resets: ${usage.quota_reset_date}\n`
          + `\nQuotas:\n`
          + `  ${premiumLine}\n`
          + `  ${chatLine}\n`
          + `  ${completionsLine}`,
      )
    } catch (err) {
      consola.error("Failed to fetch Copilot usage:", err)
      process.exit(1)
    }
  },
})
