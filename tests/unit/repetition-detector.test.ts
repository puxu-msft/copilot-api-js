import { describe, expect, test } from "bun:test"

import { RepetitionDetector, createStreamRepetitionChecker } from "~/lib/repetition-detector"

describe("RepetitionDetector", () => {
  test("detects simple pattern repetition", () => {
    const detector = new RepetitionDetector({ minPatternLength: 5, minRepetitions: 3 })

    // Feed a pattern that repeats 5 times
    const pattern = "hello world "
    const repeated = pattern.repeat(5)
    expect(detector.feed(repeated)).toBe(true)
    expect(detector.isDetected).toBe(true)
  })

  test("does not false-positive on normal text", () => {
    const detector = new RepetitionDetector()

    detector.feed("This is a normal paragraph of text that discusses various topics. ")
    detector.feed("It contains different sentences with unique content throughout. ")
    detector.feed("Each sentence contributes new information to the discussion. ")
    detector.feed("There should be no repetition detected here at all.")

    expect(detector.isDetected).toBe(false)
  })

  test("detects line-level repetition", () => {
    const detector = new RepetitionDetector({ minPatternLength: 10, minRepetitions: 3 })

    const line = "The answer is 42.\n"
    const repeated = line.repeat(5)
    expect(detector.feed(repeated)).toBe(true)
  })

  test("does not trigger on short repeated patterns below minPatternLength", () => {
    const detector = new RepetitionDetector({ minPatternLength: 20, minRepetitions: 3 })

    // Pattern of length 3 repeated many times — below minPatternLength
    expect(detector.feed("abcabcabcabcabcabc")).toBe(false)
  })

  test("does not trigger when repetitions below minRepetitions", () => {
    const detector = new RepetitionDetector({ minPatternLength: 5, minRepetitions: 5 })

    // Only 2 repetitions of a long pattern
    const pattern = "this is a longer pattern "
    expect(detector.feed(pattern.repeat(2))).toBe(false)
  })

  test("detects repetition fed incrementally (streaming)", () => {
    const detector = new RepetitionDetector({ minPatternLength: 10, minRepetitions: 3 })

    const pattern = "repeating text here "
    let detected = false

    // Feed the pattern character-by-character (simulating streaming)
    const fullText = pattern.repeat(5)
    for (const char of fullText) {
      if (detector.feed(char)) {
        detected = true
        break
      }
    }

    expect(detected).toBe(true)
  })

  test("handles buffer overflow gracefully", () => {
    const detector = new RepetitionDetector({ maxBufferSize: 100, minPatternLength: 5, minRepetitions: 3 })

    // Feed more than maxBufferSize of non-repeating text
    const longText = "a".repeat(50) + "b".repeat(50) + "c".repeat(50) + "d".repeat(50)
    // Should not crash
    detector.feed(longText)
    // No assertion on detection — just testing it doesn't throw
  })

  test("reset clears state", () => {
    const detector = new RepetitionDetector({ minPatternLength: 5, minRepetitions: 3 })

    const pattern = "hello world "
    detector.feed(pattern.repeat(5))
    expect(detector.isDetected).toBe(true)

    detector.reset()
    expect(detector.isDetected).toBe(false)

    // After reset, normal text should not be detected
    detector.feed("this is normal non-repeating text")
    expect(detector.isDetected).toBe(false)
  })

  test("once detected, subsequent feeds return true", () => {
    const detector = new RepetitionDetector({ minPatternLength: 5, minRepetitions: 3 })

    const pattern = "hello world "
    detector.feed(pattern.repeat(5))
    expect(detector.isDetected).toBe(true)

    // Feeding more text still returns true
    expect(detector.feed("completely different text")).toBe(true)
  })

  test("empty text feed returns false", () => {
    const detector = new RepetitionDetector()
    expect(detector.feed("")).toBe(false)
  })

  test("default config values work", () => {
    const detector = new RepetitionDetector()

    // Default: minPatternLength=10, minRepetitions=3
    // Feed a 15-char pattern repeated 4 times (should trigger)
    const pattern = "default pattern "
    expect(detector.feed(pattern.repeat(4))).toBe(true)
  })
})

describe("createStreamRepetitionChecker", () => {
  test("returns a function that checks for repetition", () => {
    const checker = createStreamRepetitionChecker("test")
    expect(typeof checker).toBe("function")
  })

  test("returns false for non-repetitive text", () => {
    const checker = createStreamRepetitionChecker("test")
    expect(checker("Hello, this is a normal response.")).toBe(false)
  })

  test("returns true when repetition detected", () => {
    const checker = createStreamRepetitionChecker("test", { minPatternLength: 5, minRepetitions: 3 })
    const pattern = "hello world "
    expect(checker(pattern.repeat(5))).toBe(true)
  })

  test("returns true on subsequent calls after detection", () => {
    const checker = createStreamRepetitionChecker("test", { minPatternLength: 5, minRepetitions: 3 })
    const pattern = "hello world "
    checker(pattern.repeat(5)) // triggers detection
    expect(checker("more text")).toBe(true) // still true
  })
})
