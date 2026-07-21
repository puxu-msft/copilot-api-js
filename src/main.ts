#!/usr/bin/env node

import {
  //
  defineCommand,
  runMain,
} from "citty"
import consola from "consola"

import { login } from "./auth"
import { debug } from "./debug"
import { historySearchDaemonCommand } from "./lib/history/search/daemon-entry"
import { listClaudeCode } from "./list-claude-code"
import { logout } from "./logout"
import { setupClaudeCode } from "./setup-claude-code"
import { setupCodex } from "./setup-codex"
import { start } from "./start"

// Console rendering: initialized inside `start` via ConsoleSink (commit 4).
// One-shot commands (debug, auth, etc.) use consola's default reporter — no
// observability bus is set up for them.

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
    login,
    logout,
    start,
    debug,
    "list-claude-code": listClaudeCode,
    "setup-claude-code": setupClaudeCode,
    "setup-codex": setupCodex,
    // Hidden — no `meta.description`, so it never appears in --help's rendered
    // command list. This is the history-search sidecar's own process entry
    // point (history-search-out-of-process plan Phase 3); it exists solely as
    // src/lib/history/search/supervisor.ts's spawn target, not for direct
    // operator invocation.
    "history-search-daemon": historySearchDaemonCommand,
  },
})

await runMain(main)

// When runMain() returns, the command has finished.
// The `start` subcommand keeps the event loop alive (HTTP server),
// so this line only executes for one-shot commands (debug, auth, etc.).
// Explicit exit is needed because `bun run --watch` keeps the process alive otherwise.
process.exit(0)
