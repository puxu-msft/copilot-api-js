import { dlopen, FFIType } from "bun:ffi"
import { Database } from "bun:sqlite"

const extension = `${import.meta.dir}/maintenance_mode_extension.local`
const native = dlopen(extension, {
  maintenance_mode_set: { args: [FFIType.u64, FFIType.i32], returns: FFIType.i32 },
})

type Mode = "maintenance"
type Hooks = {
  begin?: () => void
  commit?: () => void
  rollback?: () => void
  afterClear?: () => void
}

function openConnection() {
  const db = new Database(":memory:")
  db.loadExtension(extension, "sqlite3_maintenancemode_init")
  const id = db.query("SELECT maintenance_connection_id() AS id").get()!.id as number
  db.exec(`
    CREATE TABLE summaries(id INTEGER PRIMARY KEY, value TEXT);
    CREATE TRIGGER summaries_guard BEFORE INSERT ON summaries
    WHEN maintenance_mode() <> 1 BEGIN
      SELECT RAISE(ABORT, 'controlled maintenance mode required');
    END;
  `)
  return { db, id }
}

const one = openConnection()
const two = openConnection()
let activeMode: Mode | null = null

function setNativeMode(enabled: boolean) {
  const rc = native.symbols.maintenance_mode_set(BigInt(one.id), enabled ? 1 : 0)
  if (rc !== 0) throw new Error(`native mode toggle failed: ${rc}`)
}

function withMaintenanceScope<T>(mode: Mode, callback: () => T, hooks: Hooks = {}): T {
  if (activeMode !== null) throw new Error(`nested controlled maintenance scope rejected: active=${activeMode}, requested=${mode}`)
  if ((one.db.query("SELECT maintenance_mode() AS mode").get()!.mode as number) !== 0) {
    throw new Error("entry mode must be off")
  }
  activeMode = mode
  setNativeMode(true)
  let primaryError: unknown
  try {
    hooks.begin?.()
    const result = callback()
    if (result !== null && (typeof result === "object" || typeof result === "function") && typeof (result as any).then === "function") {
      throw new TypeError("controlled maintenance scope callback must be synchronous")
    }
    hooks.commit?.()
    return result
  } catch (error) {
    primaryError = error
    try {
      hooks.rollback?.()
    } catch {
      // Fixed precedence: callback/begin/commit error wins over rollback error.
    }
    throw error
  } finally {
    if (process.env.B2_MUTATE_CLEANUP !== "1") setNativeMode(false)
    activeMode = null
    try {
      hooks.afterClear?.()
    } catch (cleanupError) {
      // Fixed precedence: prior operational error wins; otherwise cleanup error propagates.
      if (primaryError === undefined) throw cleanupError
    }
  }
}

function ordinaryWriteRejected(db: Database) {
  try {
    db.exec("INSERT INTO summaries(value) VALUES ('ordinary')")
    return false
  } catch (error) {
    return String(error).includes("controlled maintenance mode required")
  }
}

function rowExists(value: string) {
  if (process.env.B2_MUTATE_SIDE_EFFECT_ORACLE === "1") return true
  return (one.db.prepare("SELECT count(*) AS count FROM summaries WHERE value=?").get(value)!.count as number) === 1
}

const results: Record<string, unknown> = {}
function runCase(name: string, expectedError: string | null, body: () => unknown, extraCheck: () => boolean = () => true) {
  let observedError: string | null = null
  let value: unknown
  try {
    value = body()
  } catch (error) {
    observedError = String(error)
  }
  const post = {
    mode: one.db.query("SELECT maintenance_mode() AS mode").get()!.mode,
    ordinaryWriteRejected: ordinaryWriteRejected(one.db),
    secondConnectionMode: two.db.query("SELECT maintenance_mode() AS mode").get()!.mode,
    secondConnectionWriteRejected: ordinaryWriteRejected(two.db),
  }
  const passed = (expectedError === null ? observedError === null : observedError?.includes(expectedError) === true)
    && post.mode === 0
    && post.ordinaryWriteRejected
    && post.secondConnectionMode === 0
    && post.secondConnectionWriteRejected
    && extraCheck()
  results[name] = { passed, expectedError, observedError, value, post }
  if (!passed) throw new Error(`case failed: ${name}`)
}

runCase("normalScope", null, () => withMaintenanceScope("maintenance", () => one.db.exec("INSERT INTO summaries(value) VALUES ('normal')")))
runCase("nestedSameModeFailClosed", "nested controlled maintenance scope rejected", () =>
  withMaintenanceScope("maintenance", () => withMaintenanceScope("maintenance", () => undefined)),
)
runCase("nestedDifferentModeFailClosed", "nested controlled maintenance scope rejected", () =>
  withMaintenanceScope("maintenance", () => withMaintenanceScope("other" as Mode, () => undefined)),
)
runCase("promiseReturnRejected", "must be synchronous", () => withMaintenanceScope("maintenance", () => Promise.resolve("later")))
runCase("thenableReturnRejected", "must be synchronous", () => withMaintenanceScope("maintenance", () => ({ then() {} })))
runCase("promiseExecutorSideEffectPersistsWithoutTransaction", "must be synchronous", () => withMaintenanceScope("maintenance", () => new Promise((resolve) => {
  one.db.exec("INSERT INTO summaries(value) VALUES ('promise-side-effect')")
  resolve("later")
})), () => rowExists("promise-side-effect"))
runCase("thenGetterSideEffectPersistsWithoutTransaction", "must be synchronous", () => withMaintenanceScope("maintenance", () => ({
  get then() {
    one.db.exec("INSERT INTO summaries(value) VALUES ('then-getter-side-effect')")
    return () => undefined
  },
})), () => rowExists("then-getter-side-effect"))
runCase("promiseSideEffectRollsBackWithTransaction", "must be synchronous", () => withMaintenanceScope("maintenance", () => new Promise((resolve) => {
  one.db.exec("INSERT INTO summaries(value) VALUES ('promise-rolled-back')")
  resolve("later")
}), { begin: () => one.db.exec("BEGIN"), commit: () => one.db.exec("COMMIT"), rollback: () => one.db.exec("ROLLBACK") }), () => !rowExists("promise-rolled-back"))
runCase("thenGetterSideEffectRollsBackWithTransaction", "must be synchronous", () => withMaintenanceScope("maintenance", () => ({
  get then() {
    one.db.exec("INSERT INTO summaries(value) VALUES ('then-getter-rolled-back')")
    return () => undefined
  },
}), { begin: () => one.db.exec("BEGIN"), commit: () => one.db.exec("COMMIT"), rollback: () => one.db.exec("ROLLBACK") }), () => !rowExists("then-getter-rolled-back"))
runCase("callbackThrow", "callback failure", () => withMaintenanceScope("maintenance", () => { throw new Error("callback failure") }))
runCase("transactionBodyThrow", "transaction body failure", () => withMaintenanceScope("maintenance", () => { throw new Error("transaction body failure") }, {
  begin: () => one.db.exec("BEGIN"),
  rollback: () => one.db.exec("ROLLBACK"),
}))
runCase("commitThrow", "commit failure", () => withMaintenanceScope("maintenance", () => one.db.exec("INSERT INTO summaries(value) VALUES ('commit-case')"), {
  begin: () => one.db.exec("BEGIN"),
  commit: () => { one.db.exec("COMMIT"); throw new Error("commit failure") },
  rollback: () => { throw new Error("rollback after commit failure") },
}))
runCase("rollbackThrowOriginalWins", "body failure before rollback", () => withMaintenanceScope("maintenance", () => { throw new Error("body failure before rollback") }, {
  begin: () => one.db.exec("BEGIN"),
  rollback: () => { one.db.exec("ROLLBACK"); throw new Error("rollback failure") },
}))
runCase("cleanupThrowAfterClear", "cleanup failure", () => withMaintenanceScope("maintenance", () => "completed", {
  afterClear: () => { throw new Error("cleanup failure") },
}))
runCase("originalErrorWinsCleanupError", "original failure", () => withMaintenanceScope("maintenance", () => { throw new Error("original failure") }, {
  afterClear: () => { throw new Error("cleanup failure") },
}))

results.triggerReentrantHostCallback = {
  applicable: false,
  reason: "Bun trigger invokes a native extension UDF synchronously; this extension has no public callback channel from native SQLite back into the JavaScript host helper. Fabricating a direct helper call would not test trigger reentrancy.",
}

console.log(JSON.stringify({ runtime: `Bun ${Bun.version}`, nestedPolicy: "all nested scopes fail closed", errorPrecedence: "operational error > rollback/cleanup error; cleanup error propagates when no prior error", results }, null, 2))
one.db.close()
two.db.close()
native.close()
