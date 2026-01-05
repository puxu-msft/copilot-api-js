import consola from "consola"

import type { State } from "./state"

import { HTTPError } from "./error"
import { sleep } from "./utils"

export async function checkRateLimit(state: State) {
  if (state.rateLimitSeconds === undefined) return

  const now = Date.now()

  if (!state.lastRequestTimestamp) {
    state.lastRequestTimestamp = now
    return
  }

  const elapsedSeconds = (now - state.lastRequestTimestamp) / 1000

  if (elapsedSeconds > state.rateLimitSeconds) {
    state.lastRequestTimestamp = now
    return
  }

  const waitTimeSeconds = Math.ceil(state.rateLimitSeconds - elapsedSeconds)

  if (!state.rateLimitWait) {
    consola.warn(
      `Rate limit exceeded. Need to wait ${waitTimeSeconds} more seconds.`,
    )
    throw new HTTPError(
      "Rate limit exceeded",
      429,
      JSON.stringify({ message: "Rate limit exceeded" }),
    )
  }

  const waitTimeMs = waitTimeSeconds * 1000
  consola.warn(
    `Rate limit reached. Waiting ${waitTimeSeconds} seconds before proceeding...`,
  )
  await sleep(waitTimeMs)
  // eslint-disable-next-line require-atomic-updates
  state.lastRequestTimestamp = Date.now()
  consola.info("Rate limit wait completed, proceeding with request")
  return
}
