/**
 * The single consola hijack point for the observability subsystem.
 *
 * `installConsolaRepublish` replaces consola's reporters with one that
 * snapshots/redacts every log into one canonical `system.diagnostic` bus event
 * instead of writing stdout or files. TerminalUi and StructuredFileSink render
 * the same immutable value through independent terminal/NDJSON projections.
 *
 * Reentrancy guard (H1): the bus calls `consola.warn` when a sink handler
 * throws (bus.ts publishSync catch). During a `system.diagnostic` fan-out that would
 * re-enter this reporter and re-publish, looping a disk-full FileSink error
 * into a log storm. While publishing we set a flag; any consola call that
 * arrives reentrantly is routed through `terminal-coordinator`'s `emergencyWrite`
 * (P2.2) and NOT re-published — region-aware when an interactive `TerminalUi`
 * is registered, a bare `process.stderr.write` otherwise (unchanged fallback).
 */

import consola from "consola"

import {
  //
  createDiagnosticEvent,
  projectDiagnosticArgument,
} from "~/lib/diagnostics"
import { emergencyWrite } from "~/lib/tui/terminal-coordinator"

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
    .map((arg) => projectDiagnosticArgument(arg))
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
        // a sink that logged). Break the cycle — route through the region-aware
        // coordinator (P2.2) instead of a bare stderr write, so an interactive
        // TerminalUi's bottom-of-screen panel/footer isn't corrupted by it.
        // `emergencyWrite` appends its own trailing "\n" — pass the line bare.
        emergencyWrite(`${logObj.type === "error" || logObj.type === "fatal" ? "[ERR ]" : "[LOG ]"} ${message}`)
        return
      }
      reentrant = true
      try {
        const error = logObj.args.find((arg) => arg instanceof Error)
        publisher.publish({
          kind: "system.diagnostic",
          diagnostic: createDiagnosticEvent({
            level: consolaLevel(logObj.type),
            event: "consola.log",
            message,
            args: logObj.args,
            fields: { consolaType: logObj.type },
            ...(error !== undefined && { error }),
            timeUnixMs: logObj.date?.getTime() ?? Date.now(),
            origin: "consola-adapter",
          }),
        })
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

function consolaLevel(type: string): "trace" | "debug" | "info" | "warn" | "error" | "fatal" {
  switch (type) {
    case "fatal": {
      return "fatal"
    }
    case "error": {
      return "error"
    }
    case "warn": {
      return "warn"
    }
    case "debug":
    case "verbose": {
      return "debug"
    }
    case "trace": {
      return "trace"
    }
    default: {
      return "info"
    }
  }
}
