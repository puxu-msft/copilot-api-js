#!/usr/bin/env node

import { defineCommand } from "citty"
import consola from "consola"
import fs from "node:fs/promises"

import { PATHS } from "./lib/paths"

export async function runLogout(): Promise<void> {
  try {
    await fs.unlink(PATHS.GITHUB_TOKEN_PATH)
    consola.success("Logged out successfully. GitHub token removed.")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      consola.info("No token found. Already logged out.")
    } else {
      consola.error("Failed to remove token:", error)
      throw error
    }
  }
}

export const logout = defineCommand({
  meta: {
    name: "logout",
    description: "Remove stored GitHub token and log out",
  },
  run() {
    return runLogout()
  },
})
