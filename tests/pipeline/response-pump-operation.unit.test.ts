import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type { UpstreamStream } from "~/lib/pipeline/types"

import { createRequestContext } from "~/lib/context/request"
import { makeArraySink } from "~/lib/pipeline/client-sink"
import { createPipelineDriver } from "~/lib/pipeline/driver"

import {
  //
  BASE,
  makeCodec,
  makeEnv,
  makeTransport,
  okStream,
} from "./hooks/driver-test-helpers"

describe("response pump operation tracking", () => {
  for (const mode of ["live", "buffered"] as const) {
    test(`${mode} pump is an operation child without making the finalizer self-join`, async () => {
      const ctx = createRequestContext({ endpoint: "openai-chat-completions" })
      const env = makeEnv(ctx)
      const { codec } = makeCodec({ env })
      const driver = createPipelineDriver({
        ...BASE,
        codec,
        transport: makeTransport(async () => okStream()),
      })
      let release!: () => void
      const gate = new Promise<void>((resolve) => (release = resolve))
      async function* frames() {
        await gate
        yield { data: JSON.stringify({ choices: [{ delta: { content: "ok" } }] }) }
      }
      const upstream: UpstreamStream = { frames: frames(), headers: new Headers() }
      const { sink } = makeArraySink()

      const pump =
        mode === "live" ?
          driver.runResponseSink(upstream, env, sink)
        : driver.runResponseBufferedSink(upstream, env, sink, { retryCap: 0, sawMessageStop: () => true })
      ctx.complete({ success: true, model: "m", usage: { input_tokens: 1, output_tokens: 1 }, content: "ok" })
      ctx.finalizeModelOperationDelivery()

      await Promise.resolve()
      expect(ctx.modelOperationTerminalRecord).toBeNull()

      release()
      await expect(pump).resolves.toMatchObject({ kind: "complete" })
      const record = await ctx.whenModelOperationFinalized()
      expect(ctx.modelOperationTerminalRecord).toBe(record)
    })
  }
})
