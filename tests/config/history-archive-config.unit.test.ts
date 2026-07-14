/**
 * L1 config for `history.archive.*` (tiered cold-archive lifecycle).
 *
 * Schema layer only: the six keys round-trip, `.strict()` rejects an unknown
 * key, size fields stay strings at the schema layer (parsed to bytes in the
 * apply layer — covered by the table-driven config-hot-reload.it.test.ts), and
 * an absent `archive` section parses to `undefined` (state defaults from
 * CONFIG_MANAGED_DEFAULTS supply the runtime values).
 */

import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import { HistoryConfigSchema } from "~/lib/config/schema"

describe("history.archive config", () => {
  test("round-trips all six keys", () => {
    const parsed = HistoryConfigSchema.parse({
      archive: {
        enabled: false,
        hot_days: 7,
        tier1_size_cap: "1GB",
        tier2_warn_count: 50,
        tier2_warn_bytes: "250MB",
        dir: "/tmp/archive",
      },
    })
    expect(parsed.archive).toEqual({
      enabled: false,
      hot_days: 7,
      tier1_size_cap: "1GB",
      tier2_warn_count: 50,
      tier2_warn_bytes: "250MB",
      dir: "/tmp/archive",
    })
  })

  test("size fields remain strings at the schema layer (apply layer parses to bytes)", () => {
    const parsed = HistoryConfigSchema.parse({ archive: { tier1_size_cap: "2GB" } })
    expect(typeof parsed.archive?.tier1_size_cap).toBe("string")
  })

  test(".strict() rejects an unknown archive key", () => {
    expect(() => HistoryConfigSchema.parse({ archive: { bogus: 1 } })).toThrow()
  })

  test("absent archive section parses to undefined (defaults supplied downstream)", () => {
    expect(HistoryConfigSchema.parse({}).archive).toBeUndefined()
  })

  test("null archive section clears to undefined (HTTP PUT delete round-trip)", () => {
    expect(HistoryConfigSchema.parse({ archive: null }).archive).toBeUndefined()
  })
})
