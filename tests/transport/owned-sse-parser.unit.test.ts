import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type {
  //
  ParsedSseFrame,
  ParsedSseIdField,
} from "~/lib/transport/parsed-sse-frame"

import { ownedResponseEvents } from "~/lib/transport/send"

function responseFromChunks(chunks: ReadonlyArray<Uint8Array>): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk)
        controller.close()
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  )
}

function encodedChunks(...chunks: ReadonlyArray<string>): Array<Uint8Array> {
  const encoder = new TextEncoder()
  return chunks.map((chunk) => encoder.encode(chunk))
}

async function parseChunks(chunks: ReadonlyArray<Uint8Array>): Promise<Array<ParsedSseFrame>> {
  const events: Array<ParsedSseFrame> = []
  for await (const event of ownedResponseEvents(responseFromChunks(chunks))) events.push(event)
  return events
}

function parsed(message: ParsedSseFrame["message"], idField: ParsedSseIdField = { kind: "absent" }): ParsedSseFrame {
  return { kind: "parsed-sse", message, idField }
}

type OwnedSseCase = {
  readonly name: string
  readonly chunks: ReadonlyArray<Uint8Array>
  readonly expected: Array<ParsedSseFrame>
}

const cases: Array<OwnedSseCase> = [
  {
    name: "dispatches non-empty data with the initial empty ID and absent id field",
    chunks: encodedChunks("data: hello\n\n"),
    expected: [parsed({ data: "hello", id: "" })],
  },
  {
    name: "strips a leading BOM but preserves one in a subsequent event value",
    chunks: encodedChunks("﻿data: first\n\ndata: ﻿second\n\n"),
    expected: [parsed({ data: "first", id: "" }), parsed({ data: "﻿second", id: "" })],
  },
  {
    name: "treats lone CR as a line and event delimiter",
    chunks: encodedChunks("data: hello\r\r"),
    expected: [parsed({ data: "hello", id: "" })],
  },
  {
    name: "dispatches an empty data field with a colon",
    chunks: encodedChunks("data:\n\n"),
    expected: [parsed({ data: "", id: "" })],
  },
  {
    name: "dispatches a colon-less data field as empty data",
    chunks: encodedChunks("data\n\n"),
    expected: [parsed({ data: "", id: "" })],
  },
  {
    name: "does not dispatch fields without data",
    chunks: encodedChunks("event: update\nid: alpha\nretry: 50\n: comment\n\n"),
    expected: [],
  },
  {
    name: "inherits an ID updated by an id-only event without inventing field presence",
    chunks: encodedChunks("id: alpha\n\ndata: payload\n\n"),
    expected: [parsed({ data: "payload", id: "alpha" })],
  },
  {
    name: "distinguishes an explicit empty reset from the same current empty ID",
    chunks: encodedChunks("id: alpha\ndata: first\n\nid:\ndata: second\n\n"),
    expected: [parsed({ data: "first", id: "alpha" }, { kind: "present", value: "alpha" }), parsed({ data: "second", id: "" }, { kind: "present", value: "" })],
  },
  {
    name: "inherits a current ID while marking the next event id field absent",
    chunks: encodedChunks("id: alpha\ndata: first\n\ndata: second\n\n"),
    expected: [parsed({ data: "first", id: "alpha" }, { kind: "present", value: "alpha" }), parsed({ data: "second", id: "alpha" })],
  },
  {
    name: "ignores an ID containing U+0000 for both current state and presence",
    chunks: encodedChunks("id: alpha\n\nid: ignored\0id\ndata: payload\n\n"),
    expected: [parsed({ data: "payload", id: "alpha" })],
  },
  {
    name: "keeps numeric IDs as wire strings",
    chunks: encodedChunks("id: 007\ndata: payload\n\n"),
    expected: [parsed({ data: "payload", id: "007" }, { kind: "present", value: "007" })],
  },
  {
    name: "updates an ID split across chunks",
    chunks: encodedChunks("id: alp", "ha\n\ndata: payload\n\n"),
    expected: [parsed({ data: "payload", id: "alpha" })],
  },
  {
    name: "accepts only ASCII decimal retry values and resets them at blank lines",
    chunks: encodedChunks(
      "id: alpha\n\nretry: 0\ndata: zero\n\nretry: 12\ndata: twelve\n\nretry: 1e3\ndata: exponent\n\nretry: -1\ndata: negative\n\nretry: 1.5\ndata: fraction\n\nretry:  3\ndata: spaced\n\nretry: 3 \ndata: trailing\n\nretry: ٣\ndata: non-ascii\n\n",
    ),
    expected: [
      parsed({ data: "zero", id: "alpha", retry: 0 }),
      parsed({ data: "twelve", id: "alpha", retry: 12 }),
      parsed({ data: "exponent", id: "alpha" }),
      parsed({ data: "negative", id: "alpha" }),
      parsed({ data: "fraction", id: "alpha" }),
      parsed({ data: "spaced", id: "alpha" }),
      parsed({ data: "trailing", id: "alpha" }),
      parsed({ data: "non-ascii", id: "alpha" }),
    ],
  },
  {
    name: "handles CRLF split across chunks",
    chunks: encodedChunks("data: payload\r", "\n\r", "\n"),
    expected: [parsed({ data: "payload", id: "" })],
  },
  {
    name: "decodes UTF-8 code points split across chunks",
    chunks: (() => {
      const encoded = new TextEncoder().encode("data: 🙂\n\n")
      return [encoded.slice(0, 8), encoded.slice(8, 10), encoded.slice(10)]
    })(),
    expected: [parsed({ data: "🙂", id: "" })],
  },
  {
    name: "joins multiple data fields with newlines",
    chunks: encodedChunks("data: first\ndata: second\n\n"),
    expected: [parsed({ data: "first\nsecond", id: "" })],
  },
  {
    name: "drops a pending event at EOF",
    chunks: encodedChunks("data: pending\n"),
    expected: [],
  },
]

describe("ownedResponseEvents WHATWG SSE parsing", () => {
  test.each(cases)("$name", async ({ chunks, expected }) => {
    expect(await parseChunks(chunks)).toEqual(expected)
  })
})
