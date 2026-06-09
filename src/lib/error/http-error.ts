import type { ToolDiagnostics } from "~/lib/upstream-diagnostics"

export class HTTPError extends Error {
  status: number
  responseText: string
  /** Model ID that caused the error (if known) */
  modelId?: string
  /** Original response headers (for Retry-After, quota snapshots, etc.) */
  responseHeaders?: Headers
  /** Tool-schema diagnostics attached on suspicious 400 responses (hint-only) */
  diagnostics?: ToolDiagnostics

  constructor(message: string, status: number, responseText: string, modelId?: string, responseHeaders?: Headers, diagnostics?: ToolDiagnostics) {
    super(message)
    this.status = status
    this.responseText = responseText
    this.modelId = modelId
    this.responseHeaders = responseHeaders
    this.diagnostics = diagnostics
  }

  static async fromResponse(message: string, response: Response, modelId?: string, diagnostics?: ToolDiagnostics): Promise<HTTPError> {
    const text = await response.text()
    return new HTTPError(message, response.status, text, modelId, response.headers, diagnostics)
  }
}
