import sqlite from "node:sqlite"

function openConnection() {
  const db = new sqlite.DatabaseSync(":memory:")
  const state = { mode: null, reentrantRequest: null, helper: null }
  db.function("maintenance_mode", () => state.mode === null ? 0 : 1)
  db.function("request_reentrant_scope", () => {
    state.reentrantRequest = captureError(() => state.helper("maintenance", () => undefined))
    return 0
  })
  db.exec(`
    CREATE TABLE summaries(id INTEGER PRIMARY KEY, value TEXT);
    CREATE TRIGGER summaries_guard BEFORE INSERT ON summaries
    WHEN maintenance_mode() <> 1 BEGIN
      SELECT RAISE(ABORT, 'controlled maintenance mode required');
    END;
    CREATE TRIGGER summaries_reentrant AFTER INSERT ON summaries
    WHEN NEW.value = 'reentrant' BEGIN
      SELECT request_reentrant_scope();
    END;
  `)
  return { db, state }
}

const one = openConnection()
const two = openConnection()

function captureError(fn) {
  try { fn(); return null } catch (error) { return String(error) }
}

function withMaintenanceScope(mode, callback, hooks = {}) {
  if (one.state.mode !== null) throw new Error(`nested controlled maintenance scope rejected: active=${one.state.mode}, requested=${mode}`)
  if (one.db.prepare("SELECT maintenance_mode() AS mode").get().mode !== 0) throw new Error("entry mode must be off")
  one.state.mode = mode
  let primaryError
  try {
    hooks.begin?.()
    const result = callback()
    if (result !== null && (typeof result === "object" || typeof result === "function") && typeof result.then === "function") {
      throw new TypeError("controlled maintenance scope callback must be synchronous")
    }
    hooks.commit?.()
    return result
  } catch (error) {
    primaryError = error
    try { hooks.rollback?.() } catch { /* operational error wins */ }
    throw error
  } finally {
    if (process.env.B2_MUTATE_CLEANUP !== "1") one.state.mode = null
    try { hooks.afterClear?.() } catch (cleanupError) { if (primaryError === undefined) throw cleanupError }
  }
}
one.state.helper = withMaintenanceScope

function ordinaryWriteRejected(connection) {
  try { connection.exec("INSERT INTO summaries(value) VALUES ('ordinary')"); return false }
  catch (error) { return String(error).includes("controlled maintenance mode required") }
}
function rowExists(value) {
  if (process.env.B2_MUTATE_SIDE_EFFECT_ORACLE === "1") return true
  return one.db.prepare("SELECT count(*) AS count FROM summaries WHERE value=?").get(value).count === 1
}

const results = {}
function runCase(name, expectedError, body, extraCheck = () => true) {
  let observedError = null
  let value
  try { value = body() } catch (error) { observedError = String(error) }
  const post = {
    mode: one.db.prepare("SELECT maintenance_mode() AS mode").get().mode,
    ordinaryWriteRejected: ordinaryWriteRejected(one.db),
    secondConnectionMode: two.db.prepare("SELECT maintenance_mode() AS mode").get().mode,
    secondConnectionWriteRejected: ordinaryWriteRejected(two.db),
  }
  const passed = (expectedError === null ? observedError === null : observedError?.includes(expectedError) === true)
    && post.mode === 0 && post.ordinaryWriteRejected && post.secondConnectionMode === 0 && post.secondConnectionWriteRejected && extraCheck()
  results[name] = { passed, expectedError, observedError, value, post }
  if (!passed) throw new Error(`case failed: ${name}`)
}

runCase("normalScope", null, () => withMaintenanceScope("maintenance", () => one.db.exec("INSERT INTO summaries(value) VALUES ('normal')")))
runCase("nestedSameModeFailClosed", "nested controlled maintenance scope rejected", () => withMaintenanceScope("maintenance", () => withMaintenanceScope("maintenance", () => undefined)))
runCase("nestedDifferentModeFailClosed", "nested controlled maintenance scope rejected", () => withMaintenanceScope("maintenance", () => withMaintenanceScope("other", () => undefined)))
runCase("triggerReentrantHostCallbackFailClosed", null, () => withMaintenanceScope("maintenance", () => one.db.exec("INSERT INTO summaries(value) VALUES ('reentrant')")), () => one.state.reentrantRequest?.includes("nested controlled maintenance scope rejected") === true)
runCase("promiseReturnRejected", "must be synchronous", () => withMaintenanceScope("maintenance", () => Promise.resolve("later")))
runCase("thenableReturnRejected", "must be synchronous", () => withMaintenanceScope("maintenance", () => ({ then() {} })))
runCase("promiseExecutorSideEffectPersistsWithoutTransaction", "must be synchronous", () => withMaintenanceScope("maintenance", () => new Promise((resolve) => { one.db.exec("INSERT INTO summaries(value) VALUES ('promise-side-effect')"); resolve("later") })), () => rowExists("promise-side-effect"))
runCase("thenGetterSideEffectPersistsWithoutTransaction", "must be synchronous", () => withMaintenanceScope("maintenance", () => ({ get then() { one.db.exec("INSERT INTO summaries(value) VALUES ('then-getter-side-effect')"); return () => undefined } })), () => rowExists("then-getter-side-effect"))
runCase("promiseSideEffectRollsBackWithTransaction", "must be synchronous", () => withMaintenanceScope("maintenance", () => new Promise((resolve) => { one.db.exec("INSERT INTO summaries(value) VALUES ('promise-rolled-back')"); resolve("later") }), { begin: () => one.db.exec("BEGIN"), commit: () => one.db.exec("COMMIT"), rollback: () => one.db.exec("ROLLBACK") }), () => !rowExists("promise-rolled-back"))
runCase("thenGetterSideEffectRollsBackWithTransaction", "must be synchronous", () => withMaintenanceScope("maintenance", () => ({ get then() { one.db.exec("INSERT INTO summaries(value) VALUES ('then-getter-rolled-back')"); return () => undefined } }), { begin: () => one.db.exec("BEGIN"), commit: () => one.db.exec("COMMIT"), rollback: () => one.db.exec("ROLLBACK") }), () => !rowExists("then-getter-rolled-back"))
runCase("callbackThrow", "callback failure", () => withMaintenanceScope("maintenance", () => { throw new Error("callback failure") }))
runCase("transactionBodyThrow", "transaction body failure", () => withMaintenanceScope("maintenance", () => { throw new Error("transaction body failure") }, { begin: () => one.db.exec("BEGIN"), rollback: () => one.db.exec("ROLLBACK") }))
runCase("commitThrow", "commit failure", () => withMaintenanceScope("maintenance", () => one.db.exec("INSERT INTO summaries(value) VALUES ('commit-case')"), { begin: () => one.db.exec("BEGIN"), commit: () => { one.db.exec("COMMIT"); throw new Error("commit failure") }, rollback: () => { throw new Error("rollback after commit failure") } }))
runCase("rollbackThrowOriginalWins", "body failure before rollback", () => withMaintenanceScope("maintenance", () => { throw new Error("body failure before rollback") }, { begin: () => one.db.exec("BEGIN"), rollback: () => { one.db.exec("ROLLBACK"); throw new Error("rollback failure") } }))
runCase("cleanupThrowAfterClear", "cleanup failure", () => withMaintenanceScope("maintenance", () => "completed", { afterClear: () => { throw new Error("cleanup failure") } }))
runCase("originalErrorWinsCleanupError", "original failure", () => withMaintenanceScope("maintenance", () => { throw new Error("original failure") }, { afterClear: () => { throw new Error("cleanup failure") } }))

console.log(JSON.stringify({ runtime: process.version, nestedPolicy: "all nested scopes fail closed", errorPrecedence: "operational error > rollback/cleanup error; cleanup error propagates when no prior error", reentrantObservedError: one.state.reentrantRequest, results }, null, 2))
one.db.close()
two.db.close()
