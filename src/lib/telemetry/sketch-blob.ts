/**
 * packed 多度量 sketch blob codec —— 一个 `hist_blob` 里打包多个命名分布
 * （duration_ms / queue_wait_ms / input_tokens 等，具体 measure 名由调用方决定，
 * 本模块 measure-agnostic）。
 *
 * 自描述、可扩展格式（对齐 sketch.ts 的 magic+version 风格，便于跨版本演进）：
 *
 *   [magic u16][version u8][count u8]
 *   entry×count: [nameLen u8][name utf8][blobLen u32-LE][serializeSketch 字节...]
 *
 * 每个 entry 内层直接复用 sketch.ts 的 serializeSketch/deserializeSketch（自身已
 * 自描述、含 magic/version），本层只负责多分布的打包/寻址。空 map 合法（count=0）。
 */
import {
  //
  deserializeSketch,
  type Sketch,
  serializeSketch,
} from "./sketch"

const PACKED_MAGIC = 0xd5b1 // "packed DDSketches" 标记，防误读非 packed blob
const PACKED_VERSION = 1
const PACKED_HEADER_BYTES = 4 // magic u16 + version u8 + count u8

/** 打包多个命名 sketch 为单个自描述二进制 blob。空 map → count=0 的合法帧。 */
export function serializePackedSketches(sketches: ReadonlyMap<string, Sketch>): Uint8Array {
  const encoder = new TextEncoder()
  const entries = [...sketches.entries()].map(([name, sketch]) => {
    const nameBytes = encoder.encode(name)
    if (nameBytes.length > 0xff) throw new Error(`serializePackedSketches: measure name "${name}" too long (${nameBytes.length} bytes, max 255)`)
    return { nameBytes, sketchBytes: serializeSketch(sketch) }
  })
  if (entries.length > 0xff) throw new Error(`serializePackedSketches: too many sketches (${entries.length}, max 255)`)

  const totalBytes =
    PACKED_HEADER_BYTES +
    entries.reduce((sum, e) => sum + 1 + e.nameBytes.length + 4 + e.sketchBytes.length, 0)
  const buf = new ArrayBuffer(totalBytes)
  const dv = new DataView(buf)
  const out = new Uint8Array(buf)
  dv.setUint16(0, PACKED_MAGIC)
  dv.setUint8(2, PACKED_VERSION)
  dv.setUint8(3, entries.length)

  let offset = PACKED_HEADER_BYTES
  for (const { nameBytes, sketchBytes } of entries) {
    dv.setUint8(offset, nameBytes.length)
    offset += 1
    out.set(nameBytes, offset)
    offset += nameBytes.length
    dv.setUint32(offset, sketchBytes.length, true) // little-endian per brief
    offset += 4
    out.set(sketchBytes, offset)
    offset += sketchBytes.length
  }
  return out
}

/** 逆操作：还原每个命名分布。magic/version 不符抛错（fail-loud，非静默截断）。 */
export function deserializePackedSketches(bytes: Uint8Array): Map<string, Sketch> {
  if (bytes.length < PACKED_HEADER_BYTES) {
    throw new Error(`packed sketch blob: too short (${bytes.length} bytes) to hold header`)
  }
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const decoder = new TextDecoder()
  const magic = dv.getUint16(0)
  if (magic !== PACKED_MAGIC) throw new Error(`packed sketch blob: bad magic 0x${magic.toString(16)} (expected 0x${PACKED_MAGIC.toString(16)})`)
  const version = dv.getUint8(2)
  if (version !== PACKED_VERSION) throw new Error(`packed sketch blob: unsupported version ${version} (expected ${PACKED_VERSION})`)
  const count = dv.getUint8(3)

  const result = new Map<string, Sketch>()
  let offset = PACKED_HEADER_BYTES
  for (let i = 0; i < count; i++) {
    const nameLen = dv.getUint8(offset)
    offset += 1
    const name = decoder.decode(bytes.subarray(offset, offset + nameLen))
    offset += nameLen
    const blobLen = dv.getUint32(offset, true)
    offset += 4
    const sketchBytes = bytes.subarray(offset, offset + blobLen)
    offset += blobLen
    result.set(name, deserializeSketch(sketchBytes))
  }
  return result
}
