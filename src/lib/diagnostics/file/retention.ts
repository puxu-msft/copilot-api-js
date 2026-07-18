import fs from "node:fs"
import path from "node:path"

import {
  //
  fsyncDirectory,
  ownerIsDefinitelyDead,
  readOwnerManifest,
} from "./owner-manifest"

export interface RetentionResult {
  deletedSegments: number
  deletedManifests: number
  retainedUnknownOwners: number
}

/** Delete only expired regular segments whose durable owner manifest is definitely dead. */
export function sweepDiagnosticRetention(directory: string, retentionDays: number, now = Date.now()): RetentionResult {
  const result: RetentionResult = { deletedSegments: 0, deletedManifests: 0, retainedUnknownOwners: 0 }
  if (retentionDays <= 0) return result
  const cutoff = now - retentionDays * 86_400_000
  let names: Array<string>
  try {
    names = fs.readdirSync(directory)
  } catch {
    return result
  }
  for (const name of names.filter((candidate) => candidate.endsWith(".owner.json"))) {
    const manifestPath = path.join(directory, name)
    const manifest = readOwnerManifest(manifestPath)
    if (!manifest || !ownerIsDefinitelyDead(manifest)) {
      result.retainedUnknownOwners++
      continue
    }
    const segments = names.filter((candidate) => candidate.startsWith(manifest.baseName) && candidate.endsWith(".ndjson"))
    let allGone = true
    for (const segment of segments) {
      const segmentPath = path.join(directory, segment)
      try {
        const stat = fs.lstatSync(segmentPath)
        if (!stat.isFile() || stat.mtimeMs >= cutoff) {
          allGone = false
          continue
        }
        fs.unlinkSync(segmentPath)
        result.deletedSegments++
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") allGone = false
      }
    }
    if (!allGone) continue
    try {
      fs.unlinkSync(manifestPath)
      result.deletedManifests++
      fsyncDirectory(directory)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") result.retainedUnknownOwners++
    }
  }
  return result
}
