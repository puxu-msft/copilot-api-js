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

/** Extract error message with fallback. For HTTPError, extracts the actual API error response. */
export function getErrorMessage(error: unknown, fallback = "Unknown error"): string {
  if (error instanceof Error) {
    // For HTTPError, extract the actual API error details instead of the generic wrapper message
    if ("responseText" in error && typeof (error as { responseText: unknown }).responseText === "string") {
      const responseText = (error as { responseText: string }).responseText
      const status = "status" in error ? (error as { status: number }).status : undefined
      try {
        const parsed = JSON.parse(responseText) as { error?: { message?: string; type?: string } }
        if (parsed.error?.message) {
          return status ? `HTTP ${status}: ${parsed.error.message}` : parsed.error.message
        }
      } catch {
        // responseText is not JSON, use it directly if reasonable
        if (responseText.length > 0 && responseText.length < 500) {
          return status ? `HTTP ${status}: ${responseText}` : responseText
        }
      }
      return status ? `HTTP ${status}: ${error.message}` : error.message
    }
    return error.message
  }
  return fallback
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
