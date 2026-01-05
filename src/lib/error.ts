import type { Context } from "hono"
import type { ContentfulStatusCode } from "hono/utils/http-status"

import consola from "consola"

export class HTTPError extends Error {
  status: number
  responseText: string

  constructor(message: string, status: number, responseText: string) {
    super(message)
    this.status = status
    this.responseText = responseText
  }

  static async fromResponse(
    message: string,
    response: Response,
  ): Promise<HTTPError> {
    const text = await response.text()
    return new HTTPError(message, response.status, text)
  }
}

export async function forwardError(c: Context, error: unknown) {
  consola.error("Error occurred:", error)

  if (error instanceof HTTPError) {
    let errorJson: unknown
    try {
      errorJson = JSON.parse(error.responseText)
    } catch {
      errorJson = error.responseText
    }
    consola.error("HTTP error:", errorJson)
    return c.json(
      {
        error: {
          message: error.responseText,
          type: "error",
        },
      },
      error.status as ContentfulStatusCode,
    )
  }

  return c.json(
    {
      error: {
        message: (error as Error).message,
        type: "error",
      },
    },
    500,
  )
}
