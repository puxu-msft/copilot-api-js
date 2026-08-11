import {
  //
  afterEach,
  describe,
  expect,
  test,
} from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"

import type { ModelTranslation } from "~/lib/state-vocabulary"

import {
  //
  restoreStateForTests,
  setStateForTests,
  snapshotStateForTests,
} from "~/lib/state"

import {
  //
  captureTranslationConfigSnapshot,
  type TranslationConfigSnapshot,
} from "../../../src/lib/pipeline/semantic/config-snapshot"

const REPO_ROOT = path.resolve(import.meta.dir, "../../..")

const RULES_A: ModelTranslation = { "anthropic-messages": [{ match: "gpt-5.5@openai-responses", features: ["strip-thinking-signature"] }] }
const RULES_B: ModelTranslation = { "anthropic-messages": [{ match: "gpt-5.6@openai-responses" }] }

const baseline = snapshotStateForTests()

afterEach(() => {
  restoreStateForTests(baseline)
})

function capture(): TranslationConfigSnapshot {
  return captureTranslationConfigSnapshot()
}

describe("translation config snapshot — identity", () => {
  test("the same config generation produces the same id, a different one does not", () => {
    setStateForTests({ modelTranslation: structuredClone(RULES_A) })
    const first = capture()
    setStateForTests({ modelTranslation: structuredClone(RULES_A) })
    const sameContent = capture()
    setStateForTests({ modelTranslation: structuredClone(RULES_B) })
    const changed = capture()

    expect(first.snapshotId).toBe(sameContent.snapshotId)
    expect(changed.snapshotId).not.toBe(first.snapshotId)
  })

  test("carries the rules it was captured from", () => {
    setStateForTests({ modelTranslation: structuredClone(RULES_A) })

    expect(capture().modelTranslation["anthropic-messages"]?.[0]?.match).toBe("gpt-5.5@openai-responses")
  })
})

describe("translation config snapshot — a hot reload only reaches later requests", () => {
  test("a snapshot captured before the reload still reads the old rules", () => {
    setStateForTests({ modelTranslation: structuredClone(RULES_A) })
    const inFlight = capture()

    setStateForTests({ modelTranslation: structuredClone(RULES_B) })

    expect(inFlight.modelTranslation["anthropic-messages"]?.[0]?.match).toBe("gpt-5.5@openai-responses")
    expect(capture().modelTranslation["anthropic-messages"]?.[0]?.match).toBe("gpt-5.6@openai-responses")
  })

  test("the captured view is frozen, so nothing downstream can edit it into agreement", () => {
    setStateForTests({ modelTranslation: structuredClone(RULES_A) })
    const snapshot = capture()
    const rules = snapshot.modelTranslation["anthropic-messages"]

    expect(Object.isFrozen(rules)).toBe(true)
    expect(Object.isFrozen(rules?.[0])).toBe(true)
    expect(Object.isFrozen(rules?.[0]?.features)).toBe(true)
  })
})

/**
 * `translationConfigSnapshot` is deliberately absent from `with()`'s patch type, so the only way a
 * retry or fallback leg keeps it is each codec's `with()` re-passing it by hand. A codec that forgets
 * would silently unpin that leg's config, and no behavioural test can see it until a hot reload lands
 * mid-request — which is exactly the case nobody reproduces on demand.
 *
 * The four paths are listed rather than globbed: a fifth codec must fail here and be added
 * deliberately, not be quietly excluded by a glob that never matched it.
 */
describe("translation config snapshot — every codec carries it across with()", () => {
  const CODECS = ["anthropic", "openai-cc", "openai-responses", "gemini"]

  for (const codec of CODECS) {
    test(`${codec} re-passes the snapshot when rebuilding the envelope`, () => {
      const source = readFileSync(path.join(REPO_ROOT, "src/lib/codec", codec, "codec.ts"), "utf8")
      const withBody = source.slice(source.indexOf("    with(patch) {"), source.indexOf("        ...patch,"))

      expect(withBody).toContain("translationConfigSnapshot: env.translationConfigSnapshot,")
    })
  }

  test("the codec list matches what is on disk", () => {
    const source = readFileSync(path.join(REPO_ROOT, "src/lib/pipeline/envelope.ts"), "utf8")

    // If the field ever enters the patch set, the hand re-passing above stops being the only path and this guard is measuring the wrong thing.
    expect(source).toContain(`with(patch: Partial<Pick<RequestEnvelope, "body" | "targetEndpoint" | "prepareHints" | "requestState">>)`)
  })
})
