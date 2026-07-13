// PoC 探针 2+3：STRICT INTEGER 对 REAL 行为 + BLOB(Uint8Array) 往返，bun:sqlite vs node:sqlite
const isBun = typeof Bun !== "undefined"
const RT = isBun ? `Bun ${Bun.version} (bun:sqlite)` : `Node ${process.version} (node:sqlite)`
console.log(`\n########## ${RT} ##########`)

let db, run, get
if (isBun) {
  const { Database } = await import("bun:sqlite")
  db = new Database(":memory:")
  run = (sql, ...a) => db.query(sql).run(...a)
  get = (sql, ...a) => db.query(sql).get(...a)
} else {
  const { DatabaseSync } = await import("node:sqlite")
  db = new DatabaseSync(":memory:")
  run = (sql, ...a) => db.prepare(sql).run(...a)
  get = (sql, ...a) => db.prepare(sql).get(...a)
}

// ---------- PROBE 2: STRICT INTEGER 列插 REAL ----------
run(`CREATE TABLE t (id INTEGER PRIMARY KEY, cost_micro INTEGER NOT NULL, cost_real REAL NOT NULL) STRICT`)
// 2a: 直插浮点到 INTEGER 列
try {
  run(`INSERT INTO t (id, cost_micro, cost_real) VALUES (1, ?, ?)`, 3.7, 3.7)
  const r = get(`SELECT cost_micro, cost_real, typeof(cost_micro) tm, typeof(cost_real) tr FROM t WHERE id=1`)
  console.log(`  P2a 浮点3.7插STRICT INTEGER列: 未报错! 存值=${r.cost_micro} typeof=${r.tm} (REAL列=${r.cost_real}/${r.tr})`)
} catch (e) {
  console.log(`  P2a 浮点3.7插STRICT INTEGER列: 抛异常 → "${String(e.message).slice(0,70)}"`)
}
// 2b: 整数浮点 4.0（无损可转）
try {
  run(`INSERT INTO t (id, cost_micro, cost_real) VALUES (2, ?, ?)`, 4.0, 4.0)
  const r = get(`SELECT cost_micro, typeof(cost_micro) tm FROM t WHERE id=2`)
  console.log(`  P2b 4.0(整数浮点)插INTEGER: 存值=${r.cost_micro} typeof=${r.tm}`)
} catch (e) { console.log(`  P2b 4.0插INTEGER: 抛 "${String(e.message).slice(0,60)}"`) }
// 2c: scaled-int 正解（round(cost*1e6)）
const cost = 0.0000037
run(`INSERT INTO t (id, cost_micro, cost_real) VALUES (3, ?, ?)`, Math.round(cost * 1e6), cost)
const r3 = get(`SELECT cost_micro, cost_real FROM t WHERE id=3`)
console.log(`  P2c scaled-int round(${cost}*1e6)=${r3.cost_micro} (还原 ${r3.cost_micro/1e6}), REAL列直存=${r3.cost_real}`)

// ---------- PROBE 3: BLOB (Uint8Array) 往返 ----------
run(`CREATE TABLE b (id INTEGER PRIMARY KEY, blob BLOB)`)
const orig = new Uint8Array([0x28, 0xb5, 0x2f, 0xfd, 0, 255, 128, 42])  // 含 zstd 魔数字节
run(`INSERT INTO b (id, blob) VALUES (1, ?)`, orig)
const rb = get(`SELECT blob FROM b WHERE id=1`)
const got = rb.blob instanceof Uint8Array ? rb.blob : new Uint8Array(rb.blob)
const same = got.length === orig.length && orig.every((v, i) => v === got[i])
console.log(`  P3 BLOB 往返: 返回类型=${rb.blob?.constructor?.name} len=${got.length} 字节一致=${same}`)

db.close?.()
console.log(`  done.`)
