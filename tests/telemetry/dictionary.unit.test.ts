import {
  //
  afterEach,
  expect,
  test,
} from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { openTelemetryDb } from "~/lib/telemetry/db"
import {
  //
  internDim,
  internKey,
  resolveKey,
} from "~/lib/telemetry/dictionary"

const tmpDirs: Array<string> = []
function freshDb(): ReturnType<typeof openTelemetryDb> {
  const dir = mkdtempSync(join(tmpdir(), "tel-dict-"))
  tmpDirs.push(dir)
  return openTelemetryDb(join(dir, "telemetry.db"))
}
afterEach(() => {
  while (tmpDirs.length > 0) rmSync(tmpDirs.pop()!, { recursive: true, force: true })
})

test("internDim 幂等：同名返同 id", () => {
  const db = freshDb()
  const a = internDim(db, "model")
  const b = internDim(db, "model")
  expect(a).toBe(b)
  expect(internDim(db, "endpoint")).not.toBe(a) // 不同名不同 id
})

test("internKey 幂等 + 按 dim 隔离：同 (dim,key) 返同 id，跨 dim 同 key 不同 id", () => {
  const db = freshDb()
  const model = internDim(db, "model")
  const client = internDim(db, "client")
  const k1 = internKey(db, model, "opus")
  const k2 = internKey(db, model, "opus")
  expect(k1).toBe(k2)
  // 同字符串 "opus" 在不同维度下是不同 key_id（按 dim 隔离）
  expect(internKey(db, client, "opus")).not.toBe(k1)
})

test("resolveKey 反查还原 (dim,key)；未知 id 返 null", () => {
  const db = freshDb()
  const model = internDim(db, "model")
  const kid = internKey(db, model, "claude-sonnet-5")
  expect(resolveKey(db, kid)).toEqual({ dim: "model", key: "claude-sonnet-5" })
  expect(resolveKey(db, 99999)).toBeNull()
})
