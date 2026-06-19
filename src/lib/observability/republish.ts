/**
 * The single consola hijack point for the observability subsystem.
 *
 * `installConsolaRepublish` replaces consola's reporters with one that
 * republishes every log as a `system.log` bus event instead of writing to
 * stdout. ConsoleSink then renders those events to stdout (footer-coordinated)
 * and FileSink writes them to `copilot-api.log`. This is what lets non-HTTP
 * logs reach BOTH sinks through one hijack rather than two competing ones
 * (RFC `history-storage-and-file-logging.md` §2.4 — eliminates the
 * `observability-rewrite.md` D6 double-hijack debt).
 *
 * Reentrancy guard (H1): the bus calls `consola.warn` when a sink handler
 * throws (bus.ts publishSync catch). During a `system.log` fan-out that would
 * re-enter this reporter and re-publish, looping a disk-full FileSink error
 * into a log storm. While publishing we set a flag; any consola call that
 * arrives reentrantly is written straight to stderr and NOT re-published.
 */

import consola from "consola"

import type { ScopedPublisher } from "./bus"

interface ConsolaLogObject {
  type: string
  args: Array<unknown>
  date?: Date
}

interface ConsolaReporter {
  log(logObj: ConsolaLogObject): void
}

/** Join consola args into a single line, matching the legacy footer-aware reporter. */
function joinArgs(args: Array<unknown>): string {
  return args
    .map((arg) => {
      if (typeof arg === "string") return arg
      if (arg instanceof Error) return arg.stack ?? arg.message
      return JSON.stringify(arg)
    })
    .join(" ")
    .trimEnd()
}

/**
 * Install the republish reporter. Returns an uninstall function that restores
 * the previous reporters (used by tests / shutdown).
 */
export function installConsolaRepublish(publisher: ScopedPublisher<"system">): () => void {
  const original = [...consola.options.reporters]
  let reentrant = false

  const reporter: ConsolaReporter = {
    log(logObj) {
      const message = joinArgs(logObj.args)
      if (reentrant) {
        // A consola call raised DURING our own fan-out (e.g. bus diagnostics or
        // a sink that logged). Break the cycle — write straight to stderr.
        process.stderr.write(`${logObj.type === "error" || logObj.type === "fatal" ? "[ERR ]" : "[LOG ]"} ${message}\n`)
        return
      }
      reentrant = true
      try {
        publisher.publish({ kind: "system.log", logType: logObj.type, message, time: Date.now() })
      } finally {
        reentrant = false
      }
    },
  }

  consola.setReporters([reporter])
  return () => {
    consola.setReporters(original)
  }
}
