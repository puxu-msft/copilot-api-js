import {
  //
  describe,
  expect,
  it,
} from "vitest"

import {
  //
  badgeKind,
  CATEGORY_LABELS,
  displayValue,
  relativeTime,
} from "@/lib/learned"

describe("learned lib", () => {
  it("has a label for every category", () => {
    expect(CATEGORY_LABELS.features).toBeTruthy()
    expect(CATEGORY_LABELS.toolFields).toBeTruthy()
    expect(Object.keys(CATEGORY_LABELS).length).toBe(10)
  })
  it("merges manually_expired into expired badge", () => {
    expect(badgeKind("expired")).toBe("expired")
    expect(badgeKind("manually_expired")).toBe("expired")
    expect(badgeKind("pinned")).toBe("pinned")
    expect(badgeKind("active")).toBe("active")
  })
  it("relativeTime formats past", () => {
    const now = 10 * 86_400_000
    expect(relativeTime(9 * 86_400_000, now)).toContain("天前")
    expect(relativeTime(now, now)).toBe("刚刚")
  })
  it("displayValue strips endpoint-scoped modelKey to bare model", () => {
    // systemRejectModels / serverToolDowngrade store an endpoint-scoped modelKey.
    expect(displayValue("systemRejectModels", "https://api.githubcopilot.com|anthropic-messages|claude-opus-4.8")).toBe("claude-opus-4.8")
    expect(displayValue("serverToolDowngrade", "https://api.githubcopilot.com|anthropic-messages|claude-sonnet-4.5")).toBe("claude-sonnet-4.5")
    // Any value containing the endpoint marker is stripped, regardless of category.
    expect(displayValue("features", "https://x|anthropic-messages|m")).toBe("m")
  })
  it("displayValue leaves bare values unchanged", () => {
    expect(displayValue("efforts", "claude-opus-4.8")).toBe("claude-opus-4.8")
    expect(displayValue("features", "context_management")).toBe("context_management")
    expect(displayValue("effortUnsupported", "some-model")).toBe("some-model")
  })
})
