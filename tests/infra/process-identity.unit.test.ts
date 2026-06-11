import {
  //
  afterEach,
  describe,
  expect,
  test,
} from "bun:test"

import {
  //
  getProcessIdentity,
  initProcessIdentity,
  resetProcessIdentityForTests,
} from "~/lib/process-identity"

describe("process-identity", () => {
  afterEach(() => {
    resetProcessIdentityForTests()
  })

  test("initProcessIdentity captures pid, version, and a boot time", () => {
    const id = initProcessIdentity("1.2.3")
    expect(id.pid).toBe(process.pid)
    expect(id.version).toBe("1.2.3")
    expect(id.bootTime).toBeGreaterThan(0)
    expect(id.synthetic).toBeUndefined()
  })

  test("first init wins — a second init returns the original snapshot", () => {
    const first = initProcessIdentity("1.0.0")
    const second = initProcessIdentity("2.0.0")
    expect(second).toBe(first)
    expect(second.version).toBe("1.0.0")
  })

  test("getProcessIdentity returns the captured identity after init", () => {
    initProcessIdentity("9.9.9")
    expect(getProcessIdentity().version).toBe("9.9.9")
  })

  test("getProcessIdentity before init returns a synthetic fallback (not a silent real-looking value)", () => {
    resetProcessIdentityForTests()
    const id = getProcessIdentity()
    expect(id.synthetic).toBe(true)
    expect(id.bootTime).toBe(0)
    expect(id.version).toBe("unknown")
    expect(id.pid).toBe(process.pid)
  })

  test("running inside this git checkout resolves a short sha and dirty flag", () => {
    // This repo IS a git checkout, so the boot-time git probe should succeed.
    // gitSha is a non-empty short hash; gitDirty is a boolean (this tree is
    // typically dirty during development, but we only assert the type/shape so
    // the test is deterministic regardless of working-tree state).
    const id = initProcessIdentity("1.0.0")
    expect(typeof id.gitSha).toBe("string")
    expect((id.gitSha ?? "").length).toBeGreaterThan(0)
    expect(typeof id.gitDirty).toBe("boolean")
  })
})
