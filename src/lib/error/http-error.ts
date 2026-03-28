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
