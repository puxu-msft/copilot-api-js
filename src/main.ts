#!/usr/bin/env node

import { defineCommand, runMain } from "citty"

import { auth } from "./auth"
import { checkUsage } from "./check-usage"
import { debug } from "./debug"
import { configureLogger } from "./lib/logger"
import { logout } from "./logout"
import { patchClaude } from "./patch-claude-code"
import { start } from "./start"

// Configure consola with timestamps before any logging
configureLogger()

const main = defineCommand({
  meta: {
    name: "copilot-api",
    description:
      "A wrapper around GitHub Copilot API to make it OpenAI compatible, making it usable for other tools.",
  },
  subCommands: {
    auth,
    logout,
    start,
    "check-usage": checkUsage,
    debug,
    "patch-claude": patchClaude,
  },
})

await runMain(main)
