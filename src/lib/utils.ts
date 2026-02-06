import consola from "consola"

import { getModels } from "~/services/copilot/get-models"
import { getVSCodeVersion } from "~/services/get-vscode-version"

import { state } from "./state"

export const sleep = (ms: number) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

export const isNullish = (value: unknown): value is null | undefined => value === null || value === undefined

/** Convert bytes to KB with rounding */
export function bytesToKB(bytes: number): number {
  return Math.round(bytes / 1024)
}

/** Extract error message with fallback */
export function getErrorMessage(error: unknown, fallback = "Unknown error"): string {
  return error instanceof Error ? error.message : fallback
}

/** Generate unique ID (timestamp + random) */
export function generateId(randomLength = 7): string {
  return (
    Date.now().toString(36)
    + Math.random()
      .toString(36)
      .slice(2, 2 + randomLength)
  )
}

export async function cacheModels(): Promise<void> {
  const models = await getModels()
  state.models = models
}

export const cacheVSCodeVersion = async () => {
  const response = await getVSCodeVersion()
  state.vsCodeVersion = response

  consola.info(`Using VSCode version: ${response}`)
}
