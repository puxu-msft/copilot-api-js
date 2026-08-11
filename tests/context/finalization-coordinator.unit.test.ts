import {
  //
  describe,
  it,
  expect,
  beforeEach,
} from "bun:test"

import { createFinalizationCoordinator } from "~/lib/context/finalization-coordinator"

// Keyed per-request finalization join (RFC §3.1.1). settle() 后由 terminal event 触发的异步
// 工作(History finalize / Calibration token-count / WS terminal broadcast)注册到同一 requestId;
// whenFinalized(requestId) 是 per-request join(A 不等 B),取代拿 global bus.flush() 冒充。
// 注册顺序 invariant:handler 首 await 前同步 register → orchestrator publish 返回后 seal →
// seal 后再 register 抛错(不静默漏追踪)。

describe("finalization-coordinator", () => {
  let coord: ReturnType<typeof createFinalizationCoordinator>
  beforeEach(() => {
    coord = createFinalizationCoordinator()
  })

  it("whenFinalized resolves after seal AND all registered promises settle", async () => {
    let resolved = false
    let releaseHistory!: () => void
    coord.registerFinalization("req-A", new Promise<void>((r) => (releaseHistory = r)))
    void coord.whenFinalized("req-A").then(() => (resolved = true))

    coord.sealFinalizations("req-A")
    await Promise.resolve()
    expect(resolved).toBe(false) // sealed but promise pending

    releaseHistory()
    await coord.whenFinalized("req-A")
    expect(resolved).toBe(true)
  })

  it("is per-request isolated: A's whenFinalized does not wait for B", async () => {
    coord.registerFinalization("req-A", Promise.resolve())
    coord.registerFinalization("req-B", new Promise<void>(() => {})) // B never settles
    coord.sealFinalizations("req-A")
    coord.sealFinalizations("req-B")
    // A must resolve despite B being stuck forever.
    await coord.whenFinalized("req-A")
    expect(true).toBe(true)
  })

  it("throws on registration after seal (no silent lost tracking)", () => {
    coord.registerFinalization("req-A", Promise.resolve())
    coord.sealFinalizations("req-A")
    expect(() => coord.registerFinalization("req-A", Promise.resolve())).toThrow(/sealed/i)
  })

  it("whenFinalized on an unknown/never-registered id resolves immediately (nothing to wait for)", async () => {
    await coord.whenFinalized("never-seen")
    expect(true).toBe(true)
  })

  it("tolerates a rejected finalization promise without wedging the join", async () => {
    coord.registerFinalization("req-A", Promise.reject(new Error("finalize boom")))
    coord.sealFinalizations("req-A")
    await coord.whenFinalized("req-A") // must not hang or throw
    expect(true).toBe(true)
  })

  it("drainAllFinalizations waits for every sealed request's promises", async () => {
    let releaseA!: () => void
    let releaseB!: () => void
    coord.registerFinalization("req-A", new Promise<void>((r) => (releaseA = r)))
    coord.registerFinalization("req-B", new Promise<void>((r) => (releaseB = r)))
    coord.sealFinalizations("req-A")
    coord.sealFinalizations("req-B")
    let drained = false
    const d = coord.drainAllFinalizations().then(() => (drained = true))
    await Promise.resolve()
    expect(drained).toBe(false)
    releaseA()
    releaseB()
    await d
    expect(drained).toBe(true)
  })
})
