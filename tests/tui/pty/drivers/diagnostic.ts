import { createDiagnosticEvent } from "~/lib/diagnostics"

export function diagnostic(message: string) {
  return {
    kind: "system.diagnostic" as const,
    diagnostic: createDiagnosticEvent({ level: "info", event: "test.pty", message, origin: "native" }),
  }
}
