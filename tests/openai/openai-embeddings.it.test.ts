import {
  //
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test"

import { HTTPError } from "~/lib/error"
import { createEmbeddings } from "~/lib/openai/embeddings"
import { setStateForTests } from "~/lib/state"

import {
  //
  autoRestoreFetch,
  setFetchMock,
} from "../helpers/mock-fetch"
import { autoRestoreState } from "../helpers/state-fixture"

describe("OpenAI embeddings client", () => {
  autoRestoreFetch()
  autoRestoreState()

  beforeEach(() => {
    setStateForTests({
      accountType: "individual",
      copilotToken: "copilot-test-token",
      vsCodeVersion: "1.100.0",
      fetchTimeout: 0,
    })
  })

  test("normalizes string input to an array before calling the embeddings endpoint", async () => {
    const fetchMock = setFetchMock(
      async () =>
        new Response(
          JSON.stringify({
            object: "list",
            data: [{ object: "embedding", embedding: [0.1, 0.2], index: 0 }],
            model: "text-embedding-3-small",
            usage: {
              prompt_tokens: 2,
              total_tokens: 2,
            },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
    )

    const result = await createEmbeddings({
      model: "text-embedding-3-small",
      input: "hello",
    })

    expect(result.model).toBe("text-embedding-3-small")
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = (fetchMock.mock.calls as unknown as Array<[string, RequestInit | undefined]>)[0]
    expect(url).toBe("https://api.githubcopilot.com/embeddings")
    // Narrow body to string: client always sends JSON text, but BodyInit is wider.
    if (typeof init?.body !== "string") {
      throw new TypeError(`expected string body in mock, got ${typeof init?.body}`)
    }
    expect(JSON.parse(init.body)).toEqual({
      model: "text-embedding-3-small",
      input: ["hello"],
    })
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer copilot-test-token")
  })

  test("throws when the Copilot token is missing", async () => {
    setStateForTests({ copilotToken: undefined })

    await expect(
      createEmbeddings({
        model: "text-embedding-3-small",
        input: ["hello"],
      }),
    ).rejects.toThrow("Copilot token not found")
  })

  test("throws HTTPError when the embeddings endpoint fails", async () => {
    setFetchMock(async () => new Response("bad gateway", { status: 502 }))

    await expect(
      createEmbeddings({
        model: "text-embedding-3-small",
        input: ["hello"],
      }),
    ).rejects.toBeInstanceOf(HTTPError)
  })
})
