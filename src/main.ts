#!/usr/bin/env node

import { defineCommand, runMain } from "citty"
import consola from "consola"

import { auth } from "./auth"
import { checkUsage } from "./check-usage"
import { debug } from "./debug"
import { initConsolaReporter } from "./lib/tui"
import { listClaudeCode } from "./list-claude-code"
import { logout } from "./logout"
import { setupClaudeCode } from "./setup-claude-code"
import { start } from "./start"

// Initialize console reporter before any logging
initConsolaReporter()

// Global error handlers - catch errors from timers, callbacks, etc.
// that would otherwise cause a silent process exit
process.on("uncaughtException", (error) => {
  consola.error("Uncaught exception:", error)
  process.exit(1)
})

process.on("unhandledRejection", (reason) => {
  consola.error("Unhandled rejection:", reason)
  process.exit(1)
})

const main = defineCommand({
  meta: {
    name: "copilot-api",
    description: "A wrapper around GitHub Copilot API to make it OpenAI compatible, making it usable for other tools.",
  },
  subCommands: {
    auth,
    logout,
    start,
    "check-usage": checkUsage,
    debug,
    "list-claude-code": listClaudeCode,
    "setup-claude-code": setupClaudeCode,
  },
})

await runMain(main)

// When runMain() returns, the command has finished.
// The `start` subcommand keeps the event loop alive (HTTP server),
// so this line only executes for one-shot commands (debug, auth, etc.).
// Explicit exit is needed because `bun run --watch` keeps the process alive otherwise.
process.exit(0)
