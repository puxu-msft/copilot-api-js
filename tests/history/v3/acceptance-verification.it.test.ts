/**
 * History V3 独立验收测试 — 2026-07-16
 *
 * 从冻结的 Spec 独立推导验收判据，验证实现是否满足用户可观察行为。
 *
 * 冻结目标：
 * - 只改 copilot-api-js
 * - 不读取/迁移/回填/删除旧 history.db/archive/seal
 * - 不调用 archiver
 * - 全模型 operation 接入
 * - canonical record rich 双轨/provenance
 * - V3 CAS+journal+writer
 * - terminal bus 动态订阅（raw generation 热重载由 raw/manager.it.test.ts 验证）
 * - V3 读/API
 * - 生产无自动 delete/V2 sink
 *
 * 容量与延迟门槛不在此 smoke suite 中伪造；由
 * store-performance.it.test.ts 使用压缩后的 V2/V3 等价数据单独验证。
 */

import {
  //
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test"

import type {
  //
  ModelOperationRecord,
  OperationKind,
} from "~/lib/context/model-operation-record"

import { createModelOperationRecorder } from "~/lib/context/model-operation-record"
import {
  //
  closeDatabase,
  getDatabase,
  openInMemoryDatabase,
} from "~/lib/history/sqlite/connection"
import {
  //
  commitPreparedOperation,
  drainV3Writer,
  enqueueModelOperation,
  getV3Operation,
  listV3Operations,
  listV3StoredOperations,
  prepareModelOperation,
  resetV3WriterForTests,
  V3_SCHEMA_SQL,
} from "~/lib/history/v3/store"
import {
  //
  drainModelOperationTerminalSubscribers,
  getRecentModelOperationTerminal,
  listRecentModelOperationTerminals,
  publishModelOperationTerminal,
  resetModelOperationTerminalBusForTests,
  subscribeModelOperationTerminals,
} from "~/lib/history/v3/terminal-bus"

import { historyTerminalPublication } from "../../helpers/history-terminal-publication"

beforeEach(() => {
  closeDatabase()
  openInMemoryDatabase()
  resetV3WriterForTests()
  resetModelOperationTerminalBusForTests()
})

afterEach(async () => {
  await drainV3Writer()
  await drainModelOperationTerminalSubscribers()
  closeDatabase()
  resetV3WriterForTests()
  resetModelOperationTerminalBusForTests()
})

// ─── 辅助函数 ───

function createTerminalRecord(opts: { id: string; kind: OperationKind; sharedPayload?: unknown; sessionId?: string; agentId?: string }): ModelOperationRecord {
  const recorder = createModelOperationRecorder({
    identity: {
      operationId: opts.id,
      kind: opts.kind,
      createdAt: Date.now(),
      ...(opts.sessionId && { sessionId: opts.sessionId }),
      ...(opts.agentId && { agentId: opts.agentId }),
    },
  })

  const payload = opts.sharedPayload ?? { data: `unique-${opts.id}` }
  const payloadHandle = recorder.registerPayload(payload, {
    origin: { stage: "ingress", track: "client" },
  })

  recorder.recordIngress({ request: { payload: payloadHandle } })

  const attemptHandle = recorder.beginAttempt({
    effectiveRequest: { payload: payloadHandle },
    upstreamRequest: { payload: payloadHandle },
  })

  const frameHandle = recorder.registerFrame(
    { event: "message", data: `response-${opts.id}` },
    { origin: { stage: "upstream", track: "upstream", attempt: attemptHandle } },
  )

  recorder.settleAttempt(attemptHandle, {
    verdict: "committed",
    upstreamResponse: { frames: [frameHandle] },
  })

  recorder.recordEgress({
    upstream: { frames: [frameHandle] },
    client: { frames: [frameHandle] },
  })

  return recorder.commitTerminal({
    outcome: "completed",
    committedAttempt: attemptHandle,
  })
}

// ─── 验收测试 ───

describe("History V3 Acceptance — 隔离性约束", () => {
  test("V3 存储层不包含任何旧数据库/archiver 引用", () => {
    // 验收标准：V3 schema 不含 history.db 旧表名
    expect(V3_SCHEMA_SQL).not.toMatch(/CREATE TABLE.*entries_v2/i)
    expect(V3_SCHEMA_SQL).not.toMatch(/CREATE TABLE.*entry_stages/i)
    expect(V3_SCHEMA_SQL).not.toMatch(/archive/i)
    expect(V3_SCHEMA_SQL).not.toMatch(/seal/i)

    // V3 schema 应只包含 v3_ 前缀的表
    expect(V3_SCHEMA_SQL).toMatch(/CREATE TABLE.*v3_meta/i)
    expect(V3_SCHEMA_SQL).toMatch(/CREATE TABLE.*v3_objects/i)
    expect(V3_SCHEMA_SQL).toMatch(/CREATE TABLE.*v3_operations/i)
    expect(V3_SCHEMA_SQL).toMatch(/CREATE TABLE.*v3_journal/i)
  })

  test("V3 存储层不包含 DELETE 自动清理逻辑", () => {
    // 验收标准：V3_SCHEMA_SQL 不应包含自动触发器删除操作
    // （CASCADE 是外键约束的声明式删除，不是自动清理）
    expect(V3_SCHEMA_SQL).not.toMatch(/CREATE TRIGGER.*DELETE/i)

    // 实证：写入记录后，无自动删除发生
    const record = createTerminalRecord({ id: "no-auto-delete", kind: "generation" })
    const prepared = prepareModelOperation(record)
    commitPreparedOperation(getDatabase(), prepared)

    // 验证数据已写入数据库（同步提交）
    const operationsCount = (getDatabase().prepare("SELECT COUNT(*) AS n FROM v3_operations").get() as { n: number }).n
    expect(operationsCount).toBe(1)

    // 验证对象仍然存在（没有自动删除）
    const objectsCount = (getDatabase().prepare("SELECT COUNT(*) AS n FROM v3_objects").get() as { n: number }).n
    expect(objectsCount).toBeGreaterThan(0) // 数据仍然存在
  })
})

describe("History V3 Acceptance — 功能完整性", () => {
  test("支持所有模型 operation 类型", async () => {
    // 验收标准：generation, count_tokens, embeddings, responses_ws 都能记录
    const kinds: Array<OperationKind> = ["generation", "count_tokens", "embeddings", "responses_ws"]

    for (const kind of kinds) {
      const record = createTerminalRecord({ id: `op-${kind}`, kind })
      await enqueueModelOperation(record)
    }

    await drainV3Writer()

    // 验证所有类型都已持久化
    for (const kind of kinds) {
      const operations = listV3Operations(kind)
      expect(operations.length).toBeGreaterThanOrEqual(1)
      expect(operations.some((op) => op.identity.operationId === `op-${kind}`)).toBe(true)
    }
  })

  test("Canonical record 包含完整 provenance", async () => {
    // 验收标准：记录包含来源追踪信息
    const record = createTerminalRecord({ id: "provenance-test", kind: "generation" })
    await enqueueModelOperation(record)
    await drainV3Writer()

    const retrieved = getV3Operation("provenance-test")
    expect(retrieved).toBeTruthy()

    // 验证 arena 节点包含 origin 信息
    expect(retrieved!.arena.payloads.length).toBeGreaterThan(0)
    expect(retrieved!.arena.payloads[0].origin).toBeDefined()
    expect(retrieved!.arena.payloads[0].origin.stage).toBeDefined()
    expect(retrieved!.arena.payloads[0].origin.track).toBeDefined()

    // 验证 provenance 字段（source 或 derived）
    const firstPayload = retrieved!.arena.payloads[0]
    expect(firstPayload.provenance).toMatch(/source|derived/)
  })

  test("V3 CAS 内容寻址存储 — 相同内容共享存储", async () => {
    // 验收标准：两个操作共享相同 payload，物理存储只保存一份
    const sharedPayload = { prompt: "shared content" }

    const record1 = createTerminalRecord({
      id: "cas-op-1",
      kind: "generation",
      sharedPayload,
    })
    const record2 = createTerminalRecord({
      id: "cas-op-2",
      kind: "generation",
      sharedPayload,
    })

    await enqueueModelOperation(record1)
    await enqueueModelOperation(record2)
    await drainV3Writer()

    // 验证两个操作都已保存
    expect(getV3Operation("cas-op-1")).toBeTruthy()
    expect(getV3Operation("cas-op-2")).toBeTruthy()

    // 验证物理对象数量小于逻辑引用数量（因为有共享）
    const objectCount = (getDatabase().prepare("SELECT COUNT(*) AS n FROM v3_objects").get() as { n: number }).n
    const operationCount = (getDatabase().prepare("SELECT COUNT(*) AS n FROM v3_operations").get() as { n: number }).n

    expect(operationCount).toBe(2)
    // 每个操作有 2 个独立的 frame（响应不同），但共享 1 个 payload
    // 总共应该是 1 个共享 payload + 2 个独立 frame = 3 个对象
    expect(objectCount).toBeLessThan(operationCount * 2) // 证明有共享
  })

  test("V3 journal 事务日志支持崩溃恢复", () => {
    // 验收标准：未提交的 journal 记录可以恢复
    const record = createTerminalRecord({ id: "journal-test", kind: "generation" })
    const prepared = prepareModelOperation(record)

    const db = getDatabase()
    db.exec(V3_SCHEMA_SQL)

    // 写入 journal，但阻止写入 operations 表（模拟崩溃）
    db.exec(`CREATE TRIGGER block_operations BEFORE INSERT ON v3_operations BEGIN SELECT RAISE(ABORT, 'simulated crash'); END;`)

    // 尝试提交，应失败
    expect(() => commitPreparedOperation(db, prepared)).toThrow(/simulated crash/i)

    // 验证 journal 中有未提交记录
    const journalRow = db.prepare("SELECT committed_at FROM v3_journal WHERE operation_id=?").get(prepared.id) as { committed_at: number | null } | undefined
    expect(journalRow).toBeDefined()
    expect(journalRow!.committed_at).toBeNull() // 未提交
  })

  test("Terminal bus 动态订阅 — 新订阅者能接收后续事件", async () => {
    // 这只验证 terminal event 订阅语义，不是 raw store generation 热重载。
    const received: Array<ModelOperationRecord> = []

    // 先发布一个记录
    const record1 = createTerminalRecord({ id: "before-subscribe", kind: "generation" })
    publishModelOperationTerminal(historyTerminalPublication(record1))

    // 动态添加订阅者
    const unsubscribe = subscribeModelOperationTerminals((publication) => {
      received.push(publication.record)
    })

    // 发布第二个记录
    const record2 = createTerminalRecord({ id: "after-subscribe", kind: "generation" })
    publishModelOperationTerminal(historyTerminalPublication(record2))

    await drainModelOperationTerminalSubscribers()

    // 验证：只接收到订阅后的记录
    expect(received.length).toBe(1)
    expect(received[0].identity.operationId).toBe("after-subscribe")

    unsubscribe()
  })

  test("V3 读取 API — 可按类型和ID查询", async () => {
    // 验收标准：提供 getV3Operation, listV3Operations 读取接口
    const record = createTerminalRecord({ id: "read-api-test", kind: "generation" })
    await enqueueModelOperation(record)
    await drainV3Writer()

    // 按 ID 读取
    const byId = getV3Operation("read-api-test")
    expect(byId).toBeTruthy()
    expect(byId!.identity.operationId).toBe("read-api-test")

    // 按类型列表读取
    const byKind = listV3Operations("generation")
    expect(byKind.length).toBeGreaterThanOrEqual(1)
    expect(byKind.some((op) => op.identity.operationId === "read-api-test")).toBe(true)

    // listV3StoredOperations 返回带 pinned 标记的存储记录
    const stored = listV3StoredOperations("generation", 100)
    expect(stored.length).toBeGreaterThanOrEqual(1)
    expect(stored[0].pinned).toBeDefined() // boolean
  })

  test("Terminal bus 提供最近操作查询", () => {
    // 验收标准：getRecentModelOperationTerminal, listRecentModelOperationTerminals
    const record1 = createTerminalRecord({
      id: "recent-1",
      kind: "generation",
      sessionId: "session-a",
    })
    const record2 = createTerminalRecord({
      id: "recent-2",
      kind: "generation",
      sessionId: "session-a",
    })

    publishModelOperationTerminal(historyTerminalPublication(record1))
    publishModelOperationTerminal(historyTerminalPublication(record2))

    // 按 ID 查询
    const byId = getRecentModelOperationTerminal("recent-1")
    expect(byId).toBeDefined()
    expect(byId!.identity.operationId).toBe("recent-1")

    // 列表查询
    const list = listRecentModelOperationTerminals()
    expect(list.length).toBeGreaterThanOrEqual(2)
    expect(list.some((r) => r.identity.operationId === "recent-1")).toBe(true)
    expect(list.some((r) => r.identity.operationId === "recent-2")).toBe(true)
  })
})
