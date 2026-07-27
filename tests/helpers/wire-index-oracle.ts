import type { ClientFrame } from "~/lib/pipeline/types"

interface IndexedPayload {
  readonly type?: string
  readonly index?: number
}

export function assertMonotonicWireIndices(frames: ReadonlyArray<ClientFrame>): void {
  const starts = indexedFrames(frames).filter(({ payload }) => payload.type === "content_block_start")
  for (const [expectedIndex, { payload }] of starts.entries()) {
    if (payload.index !== expectedIndex) {
      throw new Error(`content block start index ${String(payload.index)} at ordinal ${expectedIndex}; expected ${expectedIndex}`)
    }
  }
}

export function assertBlockProtocolState(frames: ReadonlyArray<ClientFrame>): void {
  let openIndex: number | undefined

  for (const { payload } of indexedFrames(frames)) {
    const { type, index } = payload
    if (type === "content_block_start") {
      if (openIndex !== undefined) throw new Error(`content block ${index} opened while block ${openIndex} was still open`)
      openIndex = index
      continue
    }
    if (type !== "content_block_delta" && type !== "content_block_stop") continue
    if (openIndex === undefined) throw new Error(`${type} references block ${index} while no content block is open`)
    if (index !== openIndex) throw new Error(`${type} references block ${index}; open block is ${openIndex}`)
    if (type === "content_block_stop") openIndex = undefined
  }

  if (openIndex !== undefined) throw new Error(`content block ${openIndex} remained open at end of stream`)
}

export function wireShape(frames: ReadonlyArray<ClientFrame>): Array<string> {
  return indexedFrames(frames).map(({ frame, payload }) => {
    const { type, index } = payload
    if (index === undefined) return type ?? frame.event ?? "unknown"
    if (type === "content_block_start") return `${isAnchorFrame(frame) ? "anchor" : "real"}_start@${index}`
    if (type === "content_block_stop") return `${isAnchorFrame(frame) ? "anchor" : "real"}_stop@${index}`
    if (type === "content_block_delta") return `delta@${index}`
    return `${type ?? frame.event ?? "unknown"}@${index}`
  })
}

function isAnchorFrame(frame: ClientFrame): boolean {
  return (frame as ClientFrame & { synthetic?: string }).synthetic === "anchor"
}

function indexedFrames(frames: ReadonlyArray<ClientFrame>): Array<{ frame: ClientFrame; payload: IndexedPayload }> {
  return frames.flatMap((frame) => {
    if (!frame.data) return []
    try {
      const payload = JSON.parse(frame.data) as IndexedPayload
      return typeof payload.type === "string" ? [{ frame, payload }] : []
    } catch {
      return []
    }
  })
}
