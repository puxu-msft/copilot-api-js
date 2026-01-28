#!/usr/bin/env node

import { defineCommand, runMain } from "citty"
import consola from "consola"

import { auth } from "./auth"
import { checkUsage } from "./check-usage"
import { debug } from "./debug"
import { logout } from "./logout"
import { patchClaude } from "./patch-claude-code"
import { start } from "./start"

// Disable consola's default timestamp - we add our own in console-renderer
consola.options.formatOptions.date = false

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
