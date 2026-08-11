/**
 * The dispatch diagnostic sink's state machine.
 *
 * The invariant under test is negative and therefore easy to fake: "a late producer cannot write".
 * Every case below asserts on the RECORDED diagnostics, not on the sink's own state field, because a
 * sink that reported `sealed` while still passing writes through would satisfy the state assertion and
 * defeat the purpose.
 */

import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import { createDispatchDiagnosticSink } from "~/lib/transport/dispatch-diagnostic-sink"

function harness(): { sink: ReturnType<typeof createDispatchDiagnosticSink>; kinds: () => Array<string> } {
  const recorded: Array<string> = []
  const sink = createDispatchDiagnosticSink((diagnostic) => recorded.push(diagnostic.kind))
  return { sink, kinds: () => [...recorded] }
}

const note = (kind: string) => ({ kind, severity: "info" as const })

describe("dispatch diagnostic sink", () => {
  test("ordinary producers write freely while open", () => {
    const { sink, kinds } = harness()

    sink.write(note("a"))
    sink.write(note("b"))

    expect(kinds()).toEqual(["a", "b"])
    expect(sink.state).toBe("open")
  })

  test("forcing silences ordinary producers but not its owner", () => {
    const { sink, kinds } = harness()
    sink.write(note("before"))

    const owner = sink.beginForcing()
    expect(owner).not.toBeNull()
    // A data/headers/error listener firing mid-teardown is describing a stream we already gave up on.
    sink.write(note("late-listener"))
    owner!.write(note("barrier_timeout"))

    expect(kinds()).toEqual(["before", "barrier_timeout"])
    expect(sink.state).toBe("forcing")
  })

  test("sealing stops everyone, including the owner that sealed it", () => {
    const { sink, kinds } = harness()
    const owner = sink.beginForcing()!
    owner.write(note("barrier_timeout"))
    owner.seal()

    sink.write(note("late-listener"))
    // The owner losing its own privilege is the load-bearing half: "final" has to mean final, or a
    // forced-teardown coroutine could keep appending after the record was published.
    owner.write(note("owner-after-seal"))

    expect(kinds()).toEqual(["barrier_timeout"])
    expect(sink.state).toBe("sealed")
  })

  test("only one forcer can ever claim authorship", () => {
    const { sink, kinds } = harness()

    const first = sink.beginForcing()
    const second = sink.beginForcing()

    expect(first).not.toBeNull()
    // Two concurrent forcers would interleave two accounts of the same teardown; the loser must write nothing.
    expect(second).toBeNull()
    first!.write(note("only-story"))
    expect(kinds()).toEqual(["only-story"])
  })

  test("forcing cannot be claimed after sealing", () => {
    const { sink } = harness()
    const owner = sink.beginForcing()!
    owner.seal()

    expect(sink.beginForcing()).toBeNull()
    expect(sink.state).toBe("sealed")
  })
})
