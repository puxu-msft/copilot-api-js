import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type { UpstreamStream } from "~/lib/pipeline/types"

import {
  //
  readOrigin,
  tagStream,
} from "~/lib/pipeline/hooks/origin"

function makeStream(): UpstreamStream {
  return {
    frames: (async function* () {})(),
    headers: new Headers(),
  }
}

describe("tagStream / readOrigin", () => {
  test("tags a stream as hook-mock and reads it back", () => {
    const s = makeStream()
    tagStream(s, "hook-mock")

    expect(readOrigin(s)).toBe("hook-mock")
  })

  test("tags a stream as hook-replay and reads it back", () => {
    const s = makeStream()
    tagStream(s, "hook-replay")

    expect(readOrigin(s)).toBe("hook-replay")
  })

  test("returns undefined for an untagged stream", () => {
    const s = makeStream()

    expect(readOrigin(s)).toBeUndefined()
  })

  test("tagStream returns the same object it was given (in-place tagging)", () => {
    const s = makeStream()
    const result = tagStream(s, "hook-mock")

    expect(result).toBe(s)
  })
})
