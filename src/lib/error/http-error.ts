export class HTTPError extends Error {
  status: number
  responseText: string
  /** Model ID that caused the error (if known) */
  modelId?: string
  /** Original response headers (for Retry-After, quota snapshots, etc.) */
  responseHeaders?: Headers

  constructor(message: string, status: number, responseText: string, modelId?: string, responseHeaders?: Headers) {
    super(message)
    this.status = status
    this.responseText = responseText
    this.modelId = modelId
    this.responseHeaders = responseHeaders
  }

  static async fromResponse(message: string, response: Response, modelId?: string): Promise<HTTPError> {
    const text = await response.text()
    return new HTTPError(message, response.status, text, modelId, response.headers)
  }
}

/** Parse token limit info from error message */
export function parseTokenLimitError(message: string): {
  current: number
  limit: number
} | null {
  // Match OpenAI format: "prompt token count of 135355 exceeds the limit of 128000"
  const openaiMatch = message.match(/prompt token count of (\d+) exceeds the limit of (\d+)/)
  if (openaiMatch) {
    return {
      current: Number.parseInt(openaiMatch[1], 10),
      limit: Number.parseInt(openaiMatch[2], 10),
    }
  }

  // Match Anthropic format: "prompt is too long: 208598 tokens > 200000 maximum"
  const anthropicMatch = message.match(/prompt is too long: (\d+) tokens > (\d+) maximum/)
  if (anthropicMatch) {
    return {
      current: Number.parseInt(anthropicMatch[1], 10),
      limit: Number.parseInt(anthropicMatch[2], 10),
    }
  }

  return null
}
