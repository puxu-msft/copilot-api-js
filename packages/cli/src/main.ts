#!/usr/bin/env node

import {
  //
  defineCommand,
  runMain,
} from "citty"
import consola from "consola"

import { historySearchDaemonCommand } from "~/lib/history/search/daemon-entry"

import { login } from "./auth"
import { debug } from "./debug"
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
    // The history-search sidecar's own service command — a first-class,
    // documented, independently-run service (history-search-out-of-process
    // plan Phase 3′; see contrib/systemd/history-search.service for a systemd
    // unit). NOT spawned/supervised by the main `start` server — an operator
    // starts it directly (e.g. via systemd) whenever they want full-text
    // History search; the main process degrades to empty search results
    // whenever it is not reachable.
    "history-search-daemon": historySearchDaemonCommand,
  },
})

await runMain(main)

// When runMain() returns, the command has finished.
// The `start` subcommand keeps the event loop alive (HTTP server),
// so this line only executes for one-shot commands (debug, auth, etc.).
// Explicit exit is needed because `bun run --watch` keeps the process alive otherwise.
process.exit(0)
