import { createHash, randomUUID } from "node:crypto"
import { closeSync, constants, linkSync, openSync, realpathSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import path from "node:path"

const RECEIPT_KEYS = [
  "schema_version",
  "validator_path",
  "validator_git_blob",
  "entry_sha",
  "pointer_sha",
  "manifest_path",
  "manifest_sha256",
  "discovery_baseline_path",
  "discovery_baseline_sha256",
  "discovery_runner_git_blob",
  "validated_at",
  "verdict",
] as const

const VALIDATOR_PATH = "scripts/validate-entry-evidence.ts"
const DISCOVERY_BASELINE_PATH = "tests/infra/entry-test-discovery-baseline.json"

export interface EntryEvidenceReceiptV1 {
  schema_version: 1
  validator_path: typeof VALIDATOR_PATH
  validator_git_blob: string
  entry_sha: string
  pointer_sha: string
  manifest_path: string
  manifest_sha256: string
  discovery_baseline_path: typeof DISCOVERY_BASELINE_PATH
  discovery_baseline_sha256: string
  discovery_runner_git_blob: string
  validated_at: string
  verdict: "green"
}

export interface EntryEvidenceReceiptV1Expected {
  entrySha: string
  currentHeadSha: string
  pointerSha: string
  pointerReachableFromMaster: (pointerSha: string) => boolean
  manifestPath: string
  manifestSha256: string
  discoveryBaselinePath: string
  discoveryBaselineSha256: string
  discoveryRunnerGitBlob: string
  validatorGitBlob: string
  receiptSha256: string
  tree: string
}

export interface EntryEvidenceReceiptValidation {
  valid: boolean
  receipt?: EntryEvidenceReceiptV1
  errors: string[]
}

function isSha(value: unknown, length: number): value is string {
  return typeof value === "string" && new RegExp(`^[0-9a-f]{${length}}$`).test(value)
}

function hasExactKeys(value: Record<string, unknown>): boolean {
  const actual = Object.keys(value).sort()
  const expected = [...RECEIPT_KEYS].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function isRfc3339(value: unknown): value is string {
  if (typeof value !== "string") return false
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/.exec(value)
  if (match === null) return false
  const [, year, month, day, hour, minute, second, zone] = match
  const monthNumber = Number(month)
  const dayNumber = Number(day)
  const hourNumber = Number(hour)
  const minuteNumber = Number(minute)
  const secondNumber = Number(second)
  if (monthNumber < 1 || monthNumber > 12 || hourNumber > 23 || minuteNumber > 59 || secondNumber > 60) return false
  const yearNumber = Number(year)
  const leapYear = yearNumber % 4 === 0 && (yearNumber % 100 !== 0 || yearNumber % 400 === 0)
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  if (dayNumber < 1 || dayNumber > daysInMonth[monthNumber - 1]) return false
  if (zone !== "Z" && (Number(zone.slice(1, 3)) > 23 || Number(zone.slice(4, 6)) > 59)) return false
  return true
}

function parseReceiptObject(value: unknown): EntryEvidenceReceiptValidation {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return { valid: false, errors: ["receipt must be an object"] }
  const receipt = value as Record<string, unknown>
  if (!hasExactKeys(receipt)) return { valid: false, errors: ["receipt keys differ from v1"] }
  if (receipt.schema_version !== 1) return { valid: false, errors: ["schema_version is invalid"] }
  if (receipt.validator_path !== VALIDATOR_PATH) return { valid: false, errors: ["validator_path is invalid"] }
  if (!isSha(receipt.validator_git_blob, 40)) return { valid: false, errors: ["validator_git_blob is invalid"] }
  if (!isSha(receipt.entry_sha, 40)) return { valid: false, errors: ["entry_sha is invalid"] }
  if (!isSha(receipt.pointer_sha, 40)) return { valid: false, errors: ["pointer_sha is invalid"] }
  if (typeof receipt.manifest_path !== "string" || !path.isAbsolute(receipt.manifest_path)) return { valid: false, errors: ["manifest_path is invalid"] }
  if (!isSha(receipt.manifest_sha256, 64)) return { valid: false, errors: ["manifest_sha256 is invalid"] }
  if (receipt.discovery_baseline_path !== DISCOVERY_BASELINE_PATH) return { valid: false, errors: ["discovery_baseline_path is invalid"] }
  if (!isSha(receipt.discovery_baseline_sha256, 64)) return { valid: false, errors: ["discovery_baseline_sha256 is invalid"] }
  if (!isSha(receipt.discovery_runner_git_blob, 40)) return { valid: false, errors: ["discovery_runner_git_blob is invalid"] }
  if (!isRfc3339(receipt.validated_at)) return { valid: false, errors: ["validated_at is invalid"] }
  if (receipt.verdict !== "green") return { valid: false, errors: ["verdict is invalid"] }
  return { valid: true, receipt: receipt as unknown as EntryEvidenceReceiptV1, errors: [] }
}

function canonicalRegularFile(value: string): string | undefined {
  try {
    const canonicalPath = realpathSync(value)
    return statSync(canonicalPath).isFile() ? canonicalPath : undefined
  } catch {
    return undefined
  }
}

export function parseEntryEvidenceReceiptV1(raw: string): EntryEvidenceReceiptValidation {
  try {
    return parseReceiptObject(JSON.parse(raw))
  } catch {
    return { valid: false, errors: ["receipt is not valid JSON"] }
  }
}

export function validateEntryEvidenceReceiptV1(raw: string, expected: EntryEvidenceReceiptV1Expected): EntryEvidenceReceiptValidation {
  const parsed = parseEntryEvidenceReceiptV1(raw)
  if (!parsed.valid || parsed.receipt === undefined) return parsed
  const receipt = parsed.receipt
  const errors: string[] = []
  const canonicalTree = (() => {
    try {
      return realpathSync(expected.tree)
    } catch {
      return undefined
    }
  })()
  const canonicalManifest = canonicalRegularFile(receipt.manifest_path)
  const canonicalExpectedManifest = canonicalRegularFile(expected.manifestPath)
  if (
    canonicalTree === undefined ||
    canonicalManifest === undefined ||
    canonicalExpectedManifest === undefined ||
    canonicalManifest !== canonicalExpectedManifest ||
    canonicalManifest === canonicalTree ||
    canonicalManifest.startsWith(`${canonicalTree}${path.sep}`)
  )
    errors.push("manifest_path is invalid for tree")
  if (receipt.entry_sha !== expected.entrySha) errors.push("entry_sha differs from expected entry")
  if (receipt.entry_sha !== expected.currentHeadSha) errors.push("entry_sha differs from current HEAD")
  if (receipt.pointer_sha !== expected.pointerSha) errors.push("pointer_sha differs from expected pointer")
  try {
    if (!expected.pointerReachableFromMaster(receipt.pointer_sha)) errors.push("pointer_sha is not reachable from master")
  } catch {
    errors.push("pointer reachability oracle failed")
  }
  if (receipt.manifest_sha256 !== expected.manifestSha256) errors.push("manifest_sha256 differs from expected manifest")
  if (receipt.discovery_baseline_path !== expected.discoveryBaselinePath) errors.push("discovery_baseline_path differs from expected baseline")
  if (receipt.discovery_baseline_sha256 !== expected.discoveryBaselineSha256) errors.push("discovery_baseline_sha256 differs from expected baseline")
  if (receipt.discovery_runner_git_blob !== expected.discoveryRunnerGitBlob) errors.push("discovery_runner_git_blob differs from expected runner")
  if (receipt.validator_git_blob !== expected.validatorGitBlob) errors.push("validator_git_blob differs from expected validator")
  if (createHash("sha256").update(raw).digest("hex") !== expected.receiptSha256) errors.push("receipt_sha256 differs from expected receipt")
  return { valid: errors.length === 0, receipt, errors }
}

export function writeReceiptAtomically(receiptPath: string, body: string): void {
  const temporary = path.join(path.dirname(receiptPath), `.${path.basename(receiptPath)}.${randomUUID()}.tmp`)
  let created = false
  try {
    const descriptor = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
    created = true
    try {
      // Node's fs.writeFileSync(fd, data) loops until it writes the complete buffer before returning.
      writeFileSync(descriptor, body)
    } finally {
      closeSync(descriptor)
    }
    // link(2) is atomic and fails with EEXIST instead of replacing an existing receipt.
    linkSync(temporary, receiptPath)
    unlinkSync(temporary)
  } catch (error) {
    if (created) rmSync(temporary, { force: true })
    throw error
  }
}
