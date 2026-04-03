import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import type { CreateUpstreamWsConnectionOptions, UpstreamWsConnection } from "~/lib/openai/upstream-ws-connection"

import { createUpstreamWsManager, setUpstreamWsConnectionFactoryForTests } from "~/lib/openai/upstream-ws"

function createConnection(overrides: Partial<UpstreamWsConnection> = {}): UpstreamWsConnection {
  return {
    connect: async () => {},
    sendRequest: async function* () {},
    isOpen: true,
    isBusy: false,
    statefulMarker: undefined,
    model: "gpt-5.2",
    close: () => {},
    ...overrides,
  }
}

describe("upstream websocket manager", () => {
  beforeEach(() => {
    setUpstreamWsConnectionFactoryForTests((opts: CreateUpstreamWsConnectionOptions) => {
      return createConnection({ model: opts.model })
    })
  })

  afterEach(() => {
    setUpstreamWsConnectionFactoryForTests(null)
  })

  test("reuses only matching marker and model when connection is idle", async () => {
    const manager = createUpstreamWsManager()
    const connection = await manager.create({
      headers: { authorization: "Bearer test" },
      model: "gpt-5.2",
    })
    ;(connection as { statefulMarker: string }).statefulMarker = "resp_123"

    expect(
      manager.findReusable({
        previousResponseId: "resp_123",
        model: "gpt-5.2",
      }),
    ).toBe(connection)
    expect(
      manager.findReusable({
        previousResponseId: "resp_123",
        model: "gpt-5.4",
      }),
    ).toBeUndefined()
  })

  test("does not reuse busy connections", async () => {
    const manager = createUpstreamWsManager()
    const connection = await manager.create({
      headers: { authorization: "Bearer test" },
      model: "gpt-5.2",
    })
    ;(connection as { statefulMarker: string; isBusy: boolean }).statefulMarker = "resp_123"
    ;(connection as { isBusy: boolean }).isBusy = true

    expect(
      manager.findReusable({
        previousResponseId: "resp_123",
        model: "gpt-5.2",
      }),
    ).toBeUndefined()
  })

  test("temporarily disables websocket after three consecutive fallbacks and resets on success", () => {
    const manager = createUpstreamWsManager()

    manager.recordFallback()
    manager.recordFallback()
    expect(manager.temporarilyDisabled).toBe(false)

    manager.recordFallback()
    expect(manager.temporarilyDisabled).toBe(true)
    expect(manager.consecutiveFallbacks).toBe(3)

    manager.recordSuccessfulStart()
    expect(manager.temporarilyDisabled).toBe(false)
    expect(manager.consecutiveFallbacks).toBe(0)
  })

  test("stopNew blocks further reuse decisions", async () => {
    const manager = createUpstreamWsManager()
    const connection = await manager.create({
      headers: { authorization: "Bearer test" },
      model: "gpt-5.2",
    })
    ;(connection as { statefulMarker: string }).statefulMarker = "resp_123"

    manager.stopNew()

    expect(
      manager.findReusable({
        previousResponseId: "resp_123",
        model: "gpt-5.2",
      }),
    ).toBeUndefined()
  })
})
