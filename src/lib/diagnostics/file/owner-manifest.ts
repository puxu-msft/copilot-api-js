import fs from "node:fs"
import path from "node:path"

import type { ProcessIdentity } from "~/lib/process-identity"

import {
  //
  isProcessAlive,
  readProcStartTicks,
} from "~/lib/process-identity"

export interface DiagnosticOwnerManifest {
  schemaVersion: 1
  pid: number
  bootTime: number
  procStartTicks?: number
  createdAt: number
  baseName: string
}

/** Create a durable owner manifest before the writer opens any segment. */
export function createOwnerManifest(directory: string, identity: ProcessIdentity, baseName: string): string {
  const finalPath = path.join(directory, `${baseName}.owner.json`)
  const tempPath = `${finalPath}.${crypto.randomUUID()}.tmp`
  const payload: DiagnosticOwnerManifest = {
    schemaVersion: 1,
    pid: identity.pid,
    bootTime: identity.bootTime,
    ...(identity.procStartTicks !== undefined && { procStartTicks: identity.procStartTicks }),
    createdAt: Date.now(),
    baseName,
  }
  const fd = fs.openSync(tempPath, "wx", 0o600)
  try {
    fs.writeFileSync(fd, `${JSON.stringify(payload)}\n`)
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  fs.renameSync(tempPath, finalPath)
  fsyncDirectory(directory)
  return finalPath
}

export function readOwnerManifest(filePath: string): DiagnosticOwnerManifest | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<DiagnosticOwnerManifest>
    if (parsed.schemaVersion !== 1 || !Number.isSafeInteger(parsed.pid) || !Number.isFinite(parsed.bootTime) || typeof parsed.baseName !== "string")
      return undefined
    return parsed as DiagnosticOwnerManifest
  } catch {
    return undefined
  }
}

/** Conservative owner verdict: unknown/permission/PID-reuse ambiguity always retains. */
export function ownerIsDefinitelyDead(manifest: DiagnosticOwnerManifest): boolean {
  if (isProcessAlive(manifest.pid)) {
    if (manifest.procStartTicks === undefined) return false
    const current = readProcStartTicks(manifest.pid)
    return current !== undefined && current !== manifest.procStartTicks
  }
  return true
}

export function fsyncDirectory(directory: string): void {
  let fd: number | undefined
  try {
    fd = fs.openSync(directory, "r")
    fs.fsyncSync(fd)
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
  }
}
