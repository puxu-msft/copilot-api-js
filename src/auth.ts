#!/usr/bin/env node

import { defineCommand } from "citty"
import consola from "consola"

import { applyConfigToState } from "./lib/config/config"
import { PATHS, ensurePaths } from "./lib/config/paths"
import { initProxy } from "./lib/proxy"
import { setCliState } from "./lib/state"
import { DeviceAuthProvider, FileTokenProvider } from "./lib/token"

interface RunAuthOptions {
  verbose: boolean
  showGitHubToken: boolean
}

export async function runAuth(options: RunAuthOptions): Promise<void> {
  if (options.verbose) {
    consola.level = 5
    consola.info("Verbose logging enabled")
  }

  setCliState({ showGitHubToken: options.showGitHubToken })

  await ensurePaths()

  // Load config and initialize proxy before any network requests
  const config = await applyConfigToState()
  if (config.proxy) {
    initProxy({ url: config.proxy, fromEnv: false })
  } else {
    initProxy({ url: undefined, fromEnv: true })
  }

  // Use DeviceAuthProvider directly for force authentication
  const deviceAuthProvider = new DeviceAuthProvider()
  const tokenInfo = await deviceAuthProvider.getToken()

  if (!tokenInfo) {
    throw new Error("Failed to obtain GitHub token via device authorization")
  }

  // Validate and show user info
  const validation = await deviceAuthProvider.validate(tokenInfo.token)
  if (validation.valid) {
    consola.info(`Logged in as ${validation.username}`)
  }

  // File provider will have already saved the token during device auth
  // But we can verify the file exists
  const fileProvider = new FileTokenProvider()
  if (await fileProvider.isAvailable()) {
    consola.success("GitHub token written to", PATHS.GITHUB_TOKEN_PATH)
  }
}

export const auth = defineCommand({
  meta: {
    name: "auth",
    description: "Run GitHub auth flow without running the server",
  },
  args: {
    verbose: {
      alias: "v",
      type: "boolean",
      default: false,
      description: "Enable verbose logging",
    },
    "show-github-token": {
      type: "boolean",
      default: false,
      description: "Show GitHub token on auth",
    },
  },
  run({ args }) {
    return runAuth({
      verbose: args.verbose,
      showGitHubToken: args["show-github-token"],
    })
  },
})
