#!/usr/bin/env node

import { defineCommand } from "citty"
import consola from "consola"
import fs from "node:fs/promises"

import { applyConfigToState } from "~/lib/config/config"
import {
  //
  PATHS,
  ensurePaths,
} from "~/lib/config/paths"
import { initProxy } from "~/lib/proxy"
import { setCliState } from "~/lib/state"
import { installDefaultTokenRuntime } from "~/lib/token-runtime"
import {
  //
  registerSensitiveOutput,
  writeSensitiveOnce,
} from "~/lib/tui/sensitive-output"

interface RunAuthOptions {
  verbose: boolean
  showGitHubToken: boolean
}

/** Whether the given path exists as a non-empty file. */
async function tokenFileWritten(tokenPath: string): Promise<boolean> {
  try {
    const content = await fs.readFile(tokenPath, "utf8")
    return content.trim().length > 0
  } catch {
    return false
  }
}

export async function runAuth(options: RunAuthOptions): Promise<void> {
  const unregisterSensitiveOutput = registerSensitiveOutput({
    isInteractive: () => process.stdout.isTTY,
    write: (text) => {
      try {
        return process.stdout.write(text)
      } catch {
        return false
      }
    },
  })

  try {
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

    // Force interactive device authorization via the token runtime (persists the
    // token to file and sets the current GitHub credential).
    const runtime = installDefaultTokenRuntime()
    const tokenInfo = await runtime.acquireGitHubToken({ forceDeviceAuth: true })

    if (options.showGitHubToken && !writeSensitiveOnce("github-token", "GitHub token", tokenInfo.token)) {
      consola.warn("GitHub token display requested, but no healthy interactive terminal is available")
    }

    // Validate and show user info (best-effort: device auth already succeeded).
    try {
      const user = await runtime.getGitHubUser()
      consola.info(`Logged in as ${user.login}`)
    } catch {
      // Validation is informational only here; the token was obtained and saved.
    }

    // The device flow saved the token to file — confirm it landed.
    if (await tokenFileWritten(PATHS.GITHUB_TOKEN_PATH)) {
      consola.success("GitHub token written to", PATHS.GITHUB_TOKEN_PATH)
    }
  } finally {
    unregisterSensitiveOutput()
  }
}

export const login = defineCommand({
  meta: {
    name: "login",
    // `auth` retained as an alias for backward compatibility — pairs better
    // with `logout` going forward.
    alias: ["auth"],
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
