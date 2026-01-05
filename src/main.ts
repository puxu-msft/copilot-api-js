#!/usr/bin/env node

import { defineCommand, runMain } from "citty"
import consola from "consola"

import { auth } from "./auth"
import { checkUsage } from "./check-usage"
import { debug } from "./debug"
import { logout } from "./logout"
import { start } from "./start"

// Configure consola to show timestamps in log output
consola.options.formatOptions.date = true

const main = defineCommand({
  meta: {
    name: "copilot-api",
    description:
      "A wrapper around GitHub Copilot API to make it OpenAI compatible, making it usable for other tools.",
  },
  subCommands: { auth, logout, start, "check-usage": checkUsage, debug },
})

await runMain(main)
