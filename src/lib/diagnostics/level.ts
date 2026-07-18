import type { DiagnosticLevel } from "./types"

export type DiagnosticLevelThreshold = "silent" | DiagnosticLevel

const RANK: Record<DiagnosticLevel, number> = { trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60 }

export function isDiagnosticLevelEnabled(level: DiagnosticLevel, threshold: DiagnosticLevelThreshold): boolean {
  return threshold !== "silent" && RANK[level] >= RANK[threshold]
}
