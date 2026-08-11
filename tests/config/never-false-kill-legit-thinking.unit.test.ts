import {
  //
  expect,
  test,
} from "bun:test"
import { readFileSync } from "node:fs"
import { parse } from "yaml"

interface BundledTimeouts {
  response_header: number
  stream_idle: number
  upstream_request_deadline: number
  client_request_deadline: number
}

interface BundledShutdown {
  graceful_wait: number
  abort_wait: number
}

function bundled(): { timeouts: BundledTimeouts; shutdown: BundledShutdown } {
  return parse(readFileSync(new URL("../../config.yaml", import.meta.url), "utf8")) as { timeouts: BundledTimeouts; shutdown: BundledShutdown }
}

/**
 * What this file guards, and what changed on 2026-08-11.
 *
 * The original invariant was "every bundled wall-clock terminator is 0", which came from a measured
 * fact: gpt-5.5 at effort=high has shown 266–462s zero-frame silent-reasoning gaps before a burst,
 * so any fixed positive bound can kill a request that is still legitimately working.
 *
 * The user then ruled (2026-08-11) that two of these bounds SHOULD ship positive. That is a
 * deliberate trade, not a regression, and the guard is split to say so per key rather than relaxed
 * to a shape that would also accept an accidental change:
 *
 *   - The two guards that can kill a request WITHOUT any second chance stay frozen at 0.
 *   - The two that ship positive are pinned to their exact ruled values, so drifting them is still
 *     a red test — the guard now protects the ruling instead of protecting zero.
 */
test("the two irrecoverable wall-clock terminators stay disabled in the bundled config", () => {
  // `response_header` and `stream_idle` end the whole client request with no retry left to spend,
  // and both fire on SILENCE — which is exactly what long legitimate reasoning looks like.
  expect(bundled().timeouts).toMatchObject({
    response_header: 0,
    stream_idle: 0,
  })
})

test("client_request_deadline stays disabled: it is the one bound nothing can recover from", () => {
  // It spans every retry and hedge, so when it fires there is no attempt left to make. Enabling it
  // by default would reintroduce exactly the false-kill this file was created to prevent.
  expect(bundled().timeouts.client_request_deadline).toBe(0)
})

test("upstream_request_deadline ships at the ruled 1200s (attempt-scoped, so a false kill is retried)", () => {
  // Positive by user ruling 2026-08-11. It is defensible where the others are not BECAUSE it is
  // attempt-scoped: firing it aborts one upstream attempt and leaves the retry/hedge budget intact,
  // so a request cut short here gets another go rather than being lost.
  //
  // The honest cost, recorded so nobody has to rediscover it: a single generation that legitimately
  // needs more than 20 minutes on ONE attempt is restarted from scratch instead of finishing. The
  // longest silent gap ever measured here is 462s, well inside 1200s, but a long *total* generation
  // is a different quantity from a long silent gap and has not been bounded by measurement.
  expect(bundled().timeouts.upstream_request_deadline).toBe(1200)
})

test("shutdown ships the ruled 600s/60s bounds, and a supervisor must outlast their SUM", () => {
  // Positive by user ruling 2026-08-11. Distinct in kind from the timeouts above: `graceful_wait`
  // expiry runs the LOSSLESS abandonment tier (reapInFlight + fail, then finalize still flushes),
  // so it bounds how long shutdown waits without reintroducing the 2026-08-07 record loss.
  const shutdown = bundled().shutdown
  expect(shutdown).toMatchObject({ graceful_wait: 600, abort_wait: 60 })

  // `abort_wait` only starts counting once `graceful_wait` expires. Anything a supervisor configures
  // (systemd TimeoutStopSec, pm2 kill_timeout) has to exceed this sum or it will kill the process
  // mid-flush and lose exactly what the lossless tier exists to save.
  expect(shutdown.graceful_wait + shutdown.abort_wait).toBe(660)
})
