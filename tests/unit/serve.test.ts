import {
  //
  describe,
  expect,
  mock,
  test,
} from "bun:test"

import type { ServerInstance } from "~/lib/serve"

import {
  //
  needsIpv6Only,
  startServerMulti,
} from "~/lib/serve"

function fakeInstance(label: string): ServerInstance & { closed: boolean; forceClose: boolean; label: string } {
  const inst = {
    label,
    closed: false,
    forceClose: false,
    nodeServers: [],
    async close(force?: boolean): Promise<void> {
      inst.closed = true
      inst.forceClose = Boolean(force)
    },
  } as ServerInstance & { closed: boolean; forceClose: boolean; label: string }
  return inst
}

describe("needsIpv6Only", () => {
  test("returns true for :: when 0.0.0.0 is also present", () => {
    expect(needsIpv6Only("::", ["0.0.0.0", "::"])).toBe(true)
  })

  test("returns false for :: when bound alone", () => {
    expect(needsIpv6Only("::", ["::"])).toBe(false)
  })

  test("returns false for non-:: hostnames", () => {
    expect(needsIpv6Only("0.0.0.0", ["0.0.0.0", "::"])).toBe(false)
    expect(needsIpv6Only("127.0.0.1", ["127.0.0.1", "::1"])).toBe(false)
    expect(needsIpv6Only("::1", ["127.0.0.1", "::1"])).toBe(false)
  })

  test("returns false for :: when only paired with non-IPv4-wildcard hosts", () => {
    expect(needsIpv6Only("::", ["127.0.0.1", "::"])).toBe(false)
  })
})

describe("startServerMulti", () => {
  test("invokes startOne for each hostname and aggregates instances", async () => {
    const calls: Array<string | undefined> = []
    const startOne = mock(async (host: string | undefined) => {
      calls.push(host)
      return fakeInstance(host ?? "default")
    })

    const result = await startServerMulti(["127.0.0.1", "::1"], startOne)

    expect(calls).toEqual(["127.0.0.1", "::1"])
    expect(startOne).toHaveBeenCalledTimes(2)
    expect(result.nodeServers).toEqual([])
  })

  test("falls back to a single undefined host when no hostnames provided", async () => {
    const calls: Array<string | undefined> = []
    const startOne = mock(async (host: string | undefined) => {
      calls.push(host)
      return fakeInstance("default")
    })

    await startServerMulti(undefined, startOne)
    await startServerMulti([], startOne)

    expect(calls).toEqual([undefined, undefined])
  })

  test("warns but continues when one bind fails and at least one succeeds", async () => {
    const startOne = mock(async (host: string | undefined): Promise<ServerInstance> => {
      if (host === "::1") throw new Error("boom")
      return fakeInstance(host ?? "default")
    })

    const result = await startServerMulti(["127.0.0.1", "::1"], startOne)
    expect(result).toBeDefined()
  })

  test("throws the first error when all binds fail", async () => {
    const startOne = mock(async () => {
      throw new Error("bind failed")
    })

    await expect(startServerMulti(["127.0.0.1", "::1"], startOne)).rejects.toThrow("bind failed")
  })

  test("composite close() closes every bound instance", async () => {
    const a = fakeInstance("a")
    const b = fakeInstance("b")
    const queue = [a, b]
    const startOne = async () => queue.shift()!

    const result = await startServerMulti(["127.0.0.1", "::1"], startOne)
    await result.close()

    expect(a.closed).toBe(true)
    expect(b.closed).toBe(true)
    expect(a.forceClose).toBe(false)
    expect(b.forceClose).toBe(false)
  })

  test("composite close(force=true) forwards force to every instance", async () => {
    const a = fakeInstance("a")
    const b = fakeInstance("b")
    const queue = [a, b]
    const startOne = async () => queue.shift()!

    const result = await startServerMulti(["127.0.0.1", "::1"], startOne)
    await result.close(true)

    expect(a.forceClose).toBe(true)
    expect(b.forceClose).toBe(true)
  })
})
