import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import { ownedResponseEvents } from "~/lib/transport/send"

describe("ownedResponseEvents", () => {
  test("pre-consumer return waits for raw Response body cancellation", async () => {
    let cancelStarted = false
    let cancelFinished = false
    let releaseCancel!: () => void
    const cancelGate = new Promise<void>((resolve) => {
      releaseCancel = resolve
    })
    const response = new Response(
      new ReadableStream({
        async cancel() {
          cancelStarted = true
          await cancelGate
          cancelFinished = true
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    )
    const iterator = ownedResponseEvents(response)[Symbol.asyncIterator]()
    let returned = false
    const closing = iterator.return!().then(() => {
      returned = true
    })
    await Promise.resolve()

    expect(cancelStarted).toBe(true)
    expect(cancelFinished).toBe(false)
    expect(returned).toBe(false)
    releaseCancel()
    await closing
    expect(cancelFinished).toBe(true)
    expect(returned).toBe(true)
  })

  test("concurrent return calls share one raw-body cancellation", async () => {
    let cancelCalls = 0
    const response = new Response(
      new ReadableStream({
        cancel() {
          cancelCalls++
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    )
    const iterator = ownedResponseEvents(response)[Symbol.asyncIterator]()

    await Promise.all([iterator.return!(), iterator.return!()])

    expect(cancelCalls).toBe(1)
  })

  test("return after decoding the first frame still cancels the raw Response body", async () => {
    let cancelCalls = 0
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: {"ok":true}\n\n'))
        },
        cancel() {
          cancelCalls++
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    )
    const iterator = ownedResponseEvents(response)[Symbol.asyncIterator]()
    expect((await iterator.next()).done).toBe(false)

    await iterator.return!()

    expect(cancelCalls).toBe(1)
    expect(response.body!.locked).toBe(false)
  })
})
