/**
 * Stream repetition detector.
 *
 * Uses the KMP failure function (prefix function) to detect repeated patterns
 * in streaming text output. When a model gets stuck in a repetitive loop,
 * it wastes tokens producing the same content over and over. This detector
 * identifies such loops early so the caller can take action (log warning,
 * abort stream, etc.).
 *
 * The algorithm works by maintaining a sliding buffer of recent text and
 * computing the longest proper prefix that is also a suffix — if this
 * length exceeds `(text.length - period) >= minRepetitions * period`,
 * it means a pattern of length `period` has repeated enough times.
 */

import consola from "consola"

// ============================================================================
// Configuration
// ============================================================================

export interface RepetitionDetectorConfig {
  /** Minimum pattern length in characters to consider as repetition (default: 10) */
  minPatternLength: number
  /** Minimum number of full repetitions to trigger detection (default: 3) */
  minRepetitions: number
  /** Maximum buffer size in characters; older text is discarded (default: 5000) */
  maxBufferSize: number
}

const DEFAULT_CONFIG: RepetitionDetectorConfig = {
  minPatternLength: 10,
  minRepetitions: 3,
  maxBufferSize: 5000,
}

// ============================================================================
// Repetition Detector
// ============================================================================

export class RepetitionDetector {
  private buffer = ""
  private readonly config: RepetitionDetectorConfig
  private detected = false

  constructor(config?: Partial<RepetitionDetectorConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  /**
   * Feed a text chunk into the detector.
   * Returns `true` if repetition has been detected (now or previously).
   * Once detected, subsequent calls return `true` without further analysis.
   */
  feed(text: string): boolean {
    if (this.detected) return true
    if (!text) return false

    this.buffer += text

    // Trim buffer to maxBufferSize (keep the tail)
    if (this.buffer.length > this.config.maxBufferSize) {
      this.buffer = this.buffer.slice(-this.config.maxBufferSize)
    }

    // Only check when we have enough data for at least minRepetitions of the minimum pattern
    const minRequired = this.config.minPatternLength * this.config.minRepetitions
    if (this.buffer.length < minRequired) return false

    // Check for repetition in the buffer
    this.detected = detectRepetition(this.buffer, this.config.minPatternLength, this.config.minRepetitions)
    return this.detected
  }

  /** Reset detector state for a new stream */
  reset(): void {
    this.buffer = ""
    this.detected = false
  }

  /** Whether repetition has been detected */
  get isDetected(): boolean {
    return this.detected
  }
}

// ============================================================================
// Core detection algorithm
// ============================================================================

/**
 * Detect if the tail of `text` contains a repeating pattern.
 *
 * Uses the KMP prefix function: for a string S, the prefix function π[i]
 * gives the length of the longest proper prefix of S[0..i] that is also
 * a suffix. If π[n-1] ≥ (n - period) where period = n - π[n-1], then
 * the string is composed of a repeating unit of length `period`.
 *
 * We check the suffix of the buffer (last `checkLength` chars) to detect
 * if a pattern of at least `minPatternLength` chars repeats at least
 * `minRepetitions` times.
 */
function detectRepetition(text: string, minPatternLength: number, minRepetitions: number): boolean {
  // We check progressively larger windows to find repetitions
  // Start from the minimum detectable size
  const minWindow = minPatternLength * minRepetitions
  const maxWindow = Math.min(text.length, 2000) // Cap analysis window for performance

  // Check the tail of the text with increasing window sizes
  // Use a few strategic window sizes rather than checking every size
  const windowSizes = [minWindow, Math.floor(maxWindow * 0.5), maxWindow].filter(
    (w) => w >= minWindow && w <= text.length,
  )

  for (const windowSize of windowSizes) {
    const window = text.slice(-windowSize)
    const period = findRepeatingPeriod(window)

    if (period >= minPatternLength) {
      const repetitions = Math.floor(window.length / period)
      if (repetitions >= minRepetitions) {
        return true
      }
    }
  }

  return false
}

/**
 * Find the shortest repeating period in a string using KMP prefix function.
 * Returns the period length, or the string length if no repetition found.
 */
function findRepeatingPeriod(s: string): number {
  const n = s.length
  if (n === 0) return 0

  // Compute KMP prefix function (failure function)
  const pi = new Int32Array(n)
  // pi[0] = 0 implicitly

  for (let i = 1; i < n; i++) {
    let j = pi[i - 1] ?? 0
    while (j > 0 && s[i] !== s[j]) {
      j = pi[j - 1] ?? 0
    }
    if (s[i] === s[j]) {
      j++
    }
    pi[i] = j
  }

  // The period of the string is n - pi[n-1]
  // If n is divisible by the period, the string is fully periodic
  const period = n - pi[n - 1]
  if (period < n && n % period === 0) {
    return period
  }

  // Check if the string is approximately periodic
  // (allows for a partial final repetition)
  if (period < n && pi[n - 1] >= period) {
    return period
  }

  return n // No repetition found
}

// ============================================================================
// Convenience: Stream integration helper
// ============================================================================

/**
 * Create a repetition detector callback for use in stream processing.
 * Returns a function that accepts text deltas and logs a warning on first detection.
 */
export function createStreamRepetitionChecker(
  label: string,
  config?: Partial<RepetitionDetectorConfig>,
): (textDelta: string) => boolean {
  const detector = new RepetitionDetector(config)
  let warned = false

  return (textDelta: string): boolean => {
    const isRepetitive = detector.feed(textDelta)
    if (isRepetitive && !warned) {
      warned = true
      consola.warn(`[RepetitionDetector] ${label}: Repetitive output detected in stream`)
    }
    return isRepetitive
  }
}
