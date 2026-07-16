/**
 * HTTP guard for GET /history/api/sessions (per-session aggregate) + the
 * agentId / mainAgentOnly query filters newly wired into GET /history/api/entries.
 *
 * Inserts a couple of terminal entries across two sessions (one from a subagent,
 * the rest main-agent) via the real insert+finalize path, then exercises the routes
 * through the full test app:
 *   - /api/sessions returns { sessions: [...] } with the GROUP BY aggregate.
 *   - /api/entries?agentId=X filters to that subagent's entries.
 *   - /api/entries?mainAgentOnly=true returns only entries with a NULL agent_id.
 */

import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type {
  //
  EntrySummary,
  HistoryEntry,
  SessionSummary,
} from "~/lib/history"

import { commitV3HistoryEntry } from "../helpers/history-v3-fixtures"
import { generateId } from "~/lib/utils"

import { useIsolatedRuntime } from "../helpers/isolated-fixture"
import { createFullTestApp } from "../helpers/test-app"

useIsolatedRuntime()

const app = createFullTestApp()

interface SeedOpts {
  sessionId: string
  agentId?: string
  model: string
}

/** Insert + finalize one completed terminal entry so it lands in entries_v2 as a non-active row. */
async function seedEntry(opts: SeedOpts): Promise<string> {
  const id = generateId()
  const entry: HistoryEntry = {
    id,
    sessionId: opts.sessionId,
    agentId: opts.agentId,
    startedAt: Date.now(),
    endpoint: "anthropic-messages",
    model: { requested: opts.model },
    clientRequest: { format: "anthropic-messages", model: opts.model, messages: [{ role: "user", content: "hi" }], stream: true },
  }
  commitV3HistoryEntry({
    ...entry,
    state: "completed",
    attempts: [{ index: 0, durationMs: 0, upstreamResponse: { success: true, model: opts.model, usage: { input_tokens: 10, output_tokens: 5 }, body: null } }],
    _index: { derived: { responseSuccess: true, attemptCount: 1 } },
  })
  return id
}

describe("GET /history/api/sessions + entries agent filters", () => {
  test("returns { sessions: [...] } aggregate across sessions", async () => {
    await seedEntry({ sessionId: "session-A", agentId: "agent-1", model: "claude-a" })
    await seedEntry({ sessionId: "session-A", model: "claude-b" })
    await seedEntry({ sessionId: "session-B", model: "gpt-x" })

    const res = await app.request("/history/api/sessions")
    expect(res.status).toBe(200)
    const body = (await res.json()) as { sessions: Array<SessionSummary> }
    expect(Array.isArray(body.sessions)).toBe(true)
    expect(body.sessions).toHaveLength(2)

    const byId = new Map(body.sessions.map((s) => [s.sessionId, s]))
    expect(byId.get("session-A")?.requestCount).toBe(2)
    expect(byId.get("session-A")?.agentCount).toBe(1)
    expect(byId.get("session-B")?.requestCount).toBe(1)
    expect(byId.get("session-B")?.agentCount).toBe(0)
  })

  test("?agentId=X filters to that subagent's entries", async () => {
    await seedEntry({ sessionId: "session-C", agentId: "agent-9", model: "claude-a" })
    await seedEntry({ sessionId: "session-C", model: "claude-b" })

    const res = await app.request("/history/api/entries?agentId=agent-9")
    expect(res.status).toBe(200)
    const body = (await res.json()) as { entries: Array<EntrySummary> }
    expect(body.entries.length).toBeGreaterThan(0)
    expect(body.entries.every((e) => e.agentId === "agent-9")).toBe(true)
  })

  test("?mainAgentOnly=true returns only NULL agent_id entries", async () => {
    await seedEntry({ sessionId: "session-D", agentId: "agent-7", model: "claude-a" })
    await seedEntry({ sessionId: "session-D", model: "claude-b" })

    const res = await app.request("/history/api/entries?mainAgentOnly=true")
    expect(res.status).toBe(200)
    const body = (await res.json()) as { entries: Array<EntrySummary> }
    expect(body.entries.length).toBeGreaterThan(0)
    expect(body.entries.every((e) => e.agentId === undefined)).toBe(true)
  })
})
