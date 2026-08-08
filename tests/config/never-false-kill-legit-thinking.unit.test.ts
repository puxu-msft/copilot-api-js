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
  stale_request_max_age: number
  request_deadline: number
}

test("bundled defaults never wall-clock-kill a live request that may still be legitimately thinking", () => {
  const bundled = parse(readFileSync(new URL("../../config.yaml", import.meta.url), "utf8")) as { timeouts: BundledTimeouts }

  expect(bundled.timeouts).toMatchObject({
    response_header: 0,
    stream_idle: 0,
    stale_request_max_age: 0,
    request_deadline: 0,
  })
})
