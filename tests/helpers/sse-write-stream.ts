import type { ClientFrame } from "~/lib/pipeline/types"

/** Independent WHATWG-calibrated test decoder for one raw SSE event emitted by the production encoder. */
export function decodeSseWrite(input: Uint8Array | string): ClientFrame & { data: string } {
  const text = typeof input === "string" ? input : new TextDecoder().decode(input)
  let data = ""
  let event: string | undefined
  let id: string | undefined
  let retry: number | undefined
  for (const line of text.slice(0, -2).split("\n")) {
    const colon = line.indexOf(":")
    const field = colon === -1 ? line : line.slice(0, colon)
    const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "")
    switch (field) {
      case "data": {
        data += `${value}\n`
        break
      }
      case "event": {
        event = value
        break
      }
      case "id": {
        if (!value.includes("\0")) id = value
        break
      }
      case "retry": {
        if (/^\d+$/.test(value)) retry = Number(value)
        break
      }
      default: {
        break
      }
    }
  }
  return {
    data: data.endsWith("\n") ? data.slice(0, -1) : data,
    ...(event !== undefined && { event }),
    ...(id !== undefined && { id }),
    ...(retry !== undefined && { retry }),
  }
}

export function rawSseStream(written: Array<ClientFrame & { data: string }>): { write(input: Uint8Array | string): Promise<void> } {
  return {
    write(input) {
      written.push(decodeSseWrite(input))
      return Promise.resolve()
    },
  }
}
