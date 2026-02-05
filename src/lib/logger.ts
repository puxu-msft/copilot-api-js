/**
 * Unified logger configuration.
 *
 * Configures consola with consistent timestamp formatting across the application.
 * This should be imported early in the application lifecycle.
 */

import consola from "consola"
import pc from "picocolors"

/**
 * Format time as HH:MM:SS
 */
export function formatLogTime(date: Date = new Date()): string {
  const h = String(date.getHours()).padStart(2, "0")
  const m = String(date.getMinutes()).padStart(2, "0")
  const s = String(date.getSeconds()).padStart(2, "0")
  return `${h}:${m}:${s}`
}

/**
 * Get log prefix based on log type (includes timestamp)
 */
export function getLogPrefix(type: string): string {
  const time = pc.dim(formatLogTime())

  switch (type) {
    case "error":
    case "fatal": {
      return `${pc.red("✖")} ${time}`
    }
    case "warn": {
      return `${pc.yellow("⚠")} ${time}`
    }
    case "info": {
      return `${pc.cyan("ℹ")} ${time}`
    }
    case "success": {
      return `${pc.green("✔")} ${time}`
    }
    case "debug":
    case "trace": {
      return `${pc.gray("●")} ${time}`
    }
    case "log": {
      return time
    }
    default: {
      return time
    }
  }
}

/**
 * Custom reporter that adds timestamps to all log output.
 */
export const timestampReporter = {
  log: (logObj: { args: Array<unknown>; type: string }) => {
    const message = logObj.args
      .map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg)))
      .join(" ")

    const prefix = getLogPrefix(logObj.type)
    process.stdout.write(`${prefix} ${message}\n`)
  },
}

/**
 * Configure the default consola instance to use timestamps.
 * Call this early in the application lifecycle.
 */
export function configureLogger(): void {
  consola.setReporters([timestampReporter])
  consola.options.formatOptions.date = false
}
