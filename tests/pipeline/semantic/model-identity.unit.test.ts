import {
  //
  afterEach,
  describe,
  expect,
  test,
} from "bun:test"

import {
  //
  restoreStateForTests,
  setStateForTests,
  snapshotStateForTests,
} from "~/lib/state"

import {
  //
  currentUpstreamProvider,
  modelIdentityFor,
} from "../../../src/lib/pipeline/semantic/model-identity"

const saved = snapshotStateForTests()
afterEach(() => {
  restoreStateForTests(saved)
})

describe("upstream provider identity (RFC §3.3 / §6.1)", () => {
  test("derives the origin from accountType when no explicit base URL is set", () => {
    setStateForTests({ ghcApiBaseUrl: "", accountType: "individual" })
    expect(currentUpstreamProvider()).toBe("https://api.githubcopilot.com")

    setStateForTests({ ghcApiBaseUrl: "", accountType: "business" })
    expect(currentUpstreamProvider()).toBe("https://api.business.githubcopilot.com")
  })

  test("an explicit base URL wins over accountType", () => {
    setStateForTests({ ghcApiBaseUrl: "https://ghe.example.com/api", accountType: "individual" })
    expect(currentUpstreamProvider()).toBe("https://ghe.example.com")
  })

  /**
   * The reason this module normalizes at all. Each of these spellings names the SAME upstream, and a
   * raw-string provider would read them as different ones — which strips an opaque carrier that was
   * in fact replayable, degrading a continuation for no reason and being very hard to attribute.
   */
  test("cosmetic spellings of one upstream collapse to a single provider", () => {
    const spellings = [
      "https://api.githubcopilot.com",
      "https://api.githubcopilot.com/",
      "https://api.githubcopilot.com///",
      "https://API.GithubCopilot.com",
      "https://api.githubcopilot.com:443",
    ]

    const resolved = new Set(
      spellings.map((ghcApiBaseUrl) => {
        setStateForTests({ ghcApiBaseUrl, accountType: "individual" })
        return currentUpstreamProvider()
      }),
    )

    expect([...resolved]).toEqual(["https://api.githubcopilot.com"])
  })

  test("a genuinely different upstream stays different", () => {
    setStateForTests({ ghcApiBaseUrl: "https://api.githubcopilot.com", accountType: "individual" })
    const individual = currentUpstreamProvider()
    setStateForTests({ ghcApiBaseUrl: "https://api.enterprise.githubcopilot.com", accountType: "individual" })

    // Normalization must not be so aggressive that it merges distinct upstreams — that is the opposite failure, replaying opaque state to a leg that cannot decrypt it.
    expect(currentUpstreamProvider()).not.toBe(individual)
  })

  test("an identity carries the resolved model and the requested protocol", () => {
    setStateForTests({ ghcApiBaseUrl: "", accountType: "individual" })

    expect(modelIdentityFor("responses", "gpt-5.6-sol")).toEqual({
      protocol: "responses",
      provider: "https://api.githubcopilot.com",
      model: "gpt-5.6-sol",
    })
  })
})
