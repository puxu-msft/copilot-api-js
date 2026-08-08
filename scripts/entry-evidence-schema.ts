export type SkipReason = "native-unavailable" | "todo" | "whole-suite-skip" | "reviewed-environment"

export interface TestcaseSkip {
  kind: "testcase"
  file: string
  classname: string
  name: string
  ordinal: number
  count: number
  reason: SkipReason
}

export interface SuiteSkip {
  kind: "suite"
  file: string
  suite_name: string
  count: number
  reason: Exclude<SkipReason, "todo">
}

export interface DiscoveryBaseline {
  schema_version: 1
  runner_git_blob: string
  minimum_executed: number
  files: Array<string>
  allowed_skipped: Array<TestcaseSkip | SuiteSkip>
}

const TOP_LEVEL_KEYS = ["schema_version", "runner_git_blob", "minimum_executed", "files", "allowed_skipped"]
const TESTCASE_KEYS = ["kind", "file", "classname", "name", "ordinal", "count", "reason"]
const SUITE_KEYS = ["kind", "file", "suite_name", "count", "reason"]
const REASONS = new Set<SkipReason>(["native-unavailable", "todo", "whole-suite-skip", "reviewed-environment"])
const SUITE_REASONS = new Set<Exclude<SkipReason, "todo">>(["native-unavailable", "whole-suite-skip", "reviewed-environment"])
const SEPARATOR = String.fromCharCode(0)

function fail(message: string): never {
  throw new Error(`discovery baseline: ${message}`)
}

function requireObject(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(message)
  return value as Record<string, unknown>
}

function requireExactKeys(value: Record<string, unknown>, keys: Array<string>, message: string): void {
  if (Object.keys(value).join(SEPARATOR) !== keys.join(SEPARATOR)) fail(message)
}

function requireFile(value: unknown, message: string): string {
  if (typeof value !== "string" || value.startsWith("./") || value.includes("..") || !/^tests\/.*\.(unit|it|http)\.test\.ts$/.test(value)) fail(message)
  return value
}

function requirePositiveInt(value: unknown, message: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) fail(message)
  return value as number
}

function compareStrings(left: string, right: string): number {
  return Buffer.from(left).compare(Buffer.from(right))
}

function parseSkip(value: unknown): TestcaseSkip | SuiteSkip {
  const entry = requireObject(value, "skip entry must be an object")
  if (entry.kind === "testcase") {
    requireExactKeys(entry, TESTCASE_KEYS, "testcase skip has unexpected fields")
    const file = requireFile(entry.file, "testcase skip file is invalid")
    if (typeof entry.classname !== "string" || typeof entry.name !== "string") fail("testcase skip identity is invalid")
    const ordinal = requirePositiveInt(entry.ordinal, "testcase skip ordinal is invalid")
    const count = requirePositiveInt(entry.count, "testcase skip count is invalid")
    if (typeof entry.reason !== "string" || !REASONS.has(entry.reason as SkipReason)) fail("testcase skip reason is invalid")
    return { kind: "testcase", file, classname: entry.classname, name: entry.name, ordinal, count, reason: entry.reason as SkipReason }
  }
  if (entry.kind === "suite") {
    requireExactKeys(entry, SUITE_KEYS, "suite skip has unexpected fields")
    const file = requireFile(entry.file, "suite skip file is invalid")
    if (typeof entry.suite_name !== "string") fail("suite skip name is invalid")
    const count = requirePositiveInt(entry.count, "suite skip count is invalid")
    if (typeof entry.reason !== "string" || !SUITE_REASONS.has(entry.reason as Exclude<SkipReason, "todo">)) fail("suite skip reason is invalid")
    return { kind: "suite", file, suite_name: entry.suite_name, count, reason: entry.reason as Exclude<SkipReason, "todo"> }
  }
  fail("skip kind is invalid")
}

function skipSortKey(skip: TestcaseSkip | SuiteSkip): string {
  return skip.kind === "testcase"
    ? [skip.kind, skip.file, skip.classname, skip.name, skip.ordinal].join(SEPARATOR)
    : [skip.kind, skip.file, skip.suite_name].join(SEPARATOR)
}

export function parseDiscoveryBaseline(raw: string): DiscoveryBaseline {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch (error) {
    throw new Error(`discovery baseline: invalid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  const baseline = requireObject(value, "top level must be an object")
  requireExactKeys(baseline, TOP_LEVEL_KEYS, "top-level fields are not canonical")
  if (baseline.schema_version !== 1) fail("schema_version is invalid")
  if (typeof baseline.runner_git_blob !== "string" || !/^[0-9a-f]{40}$/.test(baseline.runner_git_blob)) fail("runner_git_blob is invalid")
  if (!Number.isSafeInteger(baseline.minimum_executed) || (baseline.minimum_executed as number) < 0) fail("minimum_executed is invalid")
  if (!Array.isArray(baseline.files)) fail("files must be an array")
  const files = baseline.files.map((file) => requireFile(file, "file is invalid"))
  if (new Set(files).size !== files.length || files.some((file, index) => index > 0 && compareStrings(files[index - 1], file) >= 0))
    fail("files are not unique bytewise sorted")
  if (!Array.isArray(baseline.allowed_skipped)) fail("allowed_skipped must be an array")
  const allowed_skipped = baseline.allowed_skipped.map(parseSkip)
  const keys = allowed_skipped.map(skipSortKey)
  if (new Set(keys).size !== keys.length || keys.some((key, index) => index > 0 && compareStrings(keys[index - 1], key) >= 0))
    fail("allowed_skipped are not unique bytewise sorted")
  const parsed: DiscoveryBaseline = {
    schema_version: 1,
    runner_git_blob: baseline.runner_git_blob,
    minimum_executed: baseline.minimum_executed as number,
    files,
    allowed_skipped,
  }
  if (raw !== `${JSON.stringify(parsed, null, 2)}\n`) fail("raw bytes are not canonical")
  return parsed
}
