import OpenAI from "openai"

import { setUpstreamFetchForTests } from "~/lib/transport/upstream-fetch"

import { serveInProcess } from "../../e2e-client/harness/serve-in-process"
import {
  //
  createSseResponse,
  scriptedUpstream,
} from "../../e2e-client/harness/upstream-script"

export interface FinalOutput {
  output: Array<{ type: string; arguments?: string; name?: string; content?: Array<{ type: string; text?: string }> }>
  output_text?: string
}

export interface ResponsesSdkOracle {
  baseURL: string
  finalResponseOf: (sseFrames: Array<string>) => Promise<FinalOutput>
  close: () => void
}

/** Drive the real OpenAI SDK through the in-process proxy against scripted upstream SSE frames. */
export function createResponsesSdkOracle(model: string): ResponsesSdkOracle {
  const proxy = serveInProcess()
  const client = new OpenAI({ baseURL: proxy.baseURL, apiKey: "test-key", maxRetries: 0 })

  return {
    baseURL: proxy.baseURL,
    finalResponseOf: async (sseFrames) => {
      const upstream = scriptedUpstream(() => createSseResponse(sseFrames))
      setUpstreamFetchForTests(upstream.handler)
      return (await client.responses.stream({ model, input: "hi" }).finalResponse()) as unknown as FinalOutput
    },
    close: proxy.close,
  }
}
