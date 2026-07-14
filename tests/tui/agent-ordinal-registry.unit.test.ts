/**
 * `AgentOrdinalRegistry` — first-seen subagent numbering, scoped per session.
 */

import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import { AgentOrdinalRegistry } from "~/lib/tui/agent-ordinal-registry"

describe("AgentOrdinalRegistry", () => {
  test("assigns 1,2,3… in first-seen order within a session and is stable on repeat", () => {
    const reg = new AgentOrdinalRegistry()
    expect(reg.ordinalFor("S1", "ag-a")).toBe(1)
    expect(reg.ordinalFor("S1", "ag-b")).toBe(2)
    expect(reg.ordinalFor("S1", "ag-a")).toBe(1) // stable — not reassigned
    expect(reg.ordinalFor("S1", "ag-c")).toBe(3)
  })

  test("numbering restarts per session (same agentId in another session → its own ordinal)", () => {
    const reg = new AgentOrdinalRegistry()
    reg.ordinalFor("S1", "ag-a")
    reg.ordinalFor("S1", "ag-b")
    expect(reg.ordinalFor("S2", "ag-a")).toBe(1) // first agent of S2, independent of S1
  })

  test("main agent (no agentId) and no-session requests are not numbered", () => {
    const reg = new AgentOrdinalRegistry()
    expect(reg.ordinalFor("S1", undefined)).toBeUndefined()
    expect(reg.ordinalFor(undefined, "ag-a")).toBeUndefined()
    expect(reg.ordinalFor(undefined, undefined)).toBeUndefined()
  })
})
