/**
 * DDSketch 封装 —— 分布度量的可合并、相对误差有界的分位数 sketch。
 *
 * 存储层用它替代手挑固定桶：相对误差保证（默认 1%）、跨层 merge 零累积、
 * 自动分箱。序列化走**手动 DenseStore 二进制编码**（非 `toProto`/`fromProto`——
 * 后者拉 protobufjs 破零依赖且 `fromProto` 丢 min/max）。PoC 已验证往返一致性、
 * 跨层 merge 正确性、γ 塌缩边界（见 `exp/telemetry-storage/CONCLUSIONS.md`）。
 *
 * 纯函数、无 IO。`/metrics` 用进程内固定桶（不经此模块）；此 sketch 只喂 `/api/stats` 分位。
 */
import pkg from "@datadog/sketches-js"

const { DDSketch } = pkg
export type Sketch = InstanceType<typeof DDSketch>

/** DDSketch mapping 的内部字段（`_multiplier` 不在包 .d.ts 里；序列化需 bit-exact 存取它）。 */
type MappingInternals = { gamma: number; relativeAccuracy: number; _multiplier: number }
const mappingInternals = (sketch: Sketch): MappingInternals => sketch.mapping as unknown as MappingInternals

/** γ→relativeAccuracy 反解（mapping.gamma = (1+ra)/(1-ra) ⇒ ra = (γ-1)/(γ+1)）。 */
function gammaToRelativeAccuracy(gamma: number): number {
  return (gamma - 1) / (gamma + 1)
}

/** 新建 sketch。`relativeAccuracy` 默认 0.01（1%）；config `sketch_gamma` 下限 ~0.005（PoC：0.001→塌缩）。 */
export function createSketch(relativeAccuracy = 0.01): Sketch {
  return new DDSketch({ relativeAccuracy })
}

/** 分位数（q ∈ [0,1]）。空 sketch 返 0（DDSketch 语义）。 */
export function quantile(sketch: Sketch, q: number): number {
  return sketch.getValueAtQuantile(q)
}

/**
 * merge `from` 进 `into`（原地）。同 γ 时 bin 对齐、逐 bin 相加、零累积；
 * 异 γ 时 DDSketch `merge` 抛（fail-loud），故跨层降采样绝不静默错配。
 */
export function mergeSketch(into: Sketch, from: Sketch): void {
  into.merge(from)
}

// ── 二进制序列化（DataView，紧凑；bins 用 float64 容大计数） ──
// 自描述格式（可跨 sketches-js 版本存数年 + zstd 落 SQLite）：
// layout: [magic u16][version u16]
//         [gamma f64][multiplier f64][relAcc f64][min f64][max f64][sum f64][count f64][zeroCount f64]
//         [storeOffset i32][minKey i32][maxKey i32][binsLen u32][bins f64...]
// 存 gamma+multiplier+relativeAccuracy 三者以 bit-exact 重建 mapping（否则 ra↔γ 反解引入
// ~1e-13 浮点噪声、quantile 不逐字节相等）。
const SKETCH_MAGIC = 0xdd51 // "DDSketch v1" 标记，防误读非 sketch blob / 版本漂移
const SKETCH_VERSION = 1
const PREFIX_BYTES = 4 // magic u16 + version u16
const HEADER_BYTES = PREFIX_BYTES + 8 * 8 + 4 * 4 // 4 + 8×f64 + 4×i32/u32 = 84

/** 手动序列化 DenseStore + sketch 标量为紧凑自描述二进制。含 min/max（protobuf 会丢）。 */
export function serializeSketch(sketch: Sketch): Uint8Array {
  const store = sketch.store
  const mapping = mappingInternals(sketch)
  const bins: Array<number> = store.bins
  const buf = new ArrayBuffer(HEADER_BYTES + bins.length * 8)
  const dv = new DataView(buf)
  dv.setUint16(0, SKETCH_MAGIC)
  dv.setUint16(2, SKETCH_VERSION)
  dv.setFloat64(4, mapping.gamma)
  dv.setFloat64(12, mapping._multiplier)
  dv.setFloat64(20, mapping.relativeAccuracy)
  dv.setFloat64(28, sketch.min)
  dv.setFloat64(36, sketch.max)
  dv.setFloat64(44, sketch.sum)
  dv.setFloat64(52, sketch.count)
  dv.setFloat64(60, sketch.zeroCount)
  dv.setInt32(68, store.offset)
  dv.setInt32(72, store.minKey)
  dv.setInt32(76, store.maxKey)
  dv.setUint32(80, bins.length)
  for (let i = 0; i < bins.length; i++) dv.setFloat64(HEADER_BYTES + i * 8, bins[i])
  return new Uint8Array(buf)
}

/** 从二进制重建 sketch（覆写 DenseStore 内部 + mapping + 标量）。与 serializeSketch 逐字节往返一致。校验 magic/version，损坏或未知版本抛。 */
export function deserializeSketch(bytes: Uint8Array): Sketch {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const magic = dv.getUint16(0)
  if (magic !== SKETCH_MAGIC) throw new Error(`sketch blob: bad magic 0x${magic.toString(16)} (expected 0x${SKETCH_MAGIC.toString(16)})`)
  const version = dv.getUint16(2)
  if (version !== SKETCH_VERSION) throw new Error(`sketch blob: unsupported version ${version} (expected ${SKETCH_VERSION})`)
  const gamma = dv.getFloat64(4)
  const sketch = createSketch(gammaToRelativeAccuracy(gamma))
  // bit-exact 覆写 mapping（避免 ra→γ 重算噪声），使 quantile 逐字节往返一致。
  const mapping = mappingInternals(sketch)
  mapping.gamma = gamma
  mapping._multiplier = dv.getFloat64(12)
  mapping.relativeAccuracy = dv.getFloat64(20)
  sketch.min = dv.getFloat64(28)
  sketch.max = dv.getFloat64(36)
  sketch.sum = dv.getFloat64(44)
  sketch.count = dv.getFloat64(52)
  sketch.zeroCount = dv.getFloat64(60)
  const store = sketch.store
  store.offset = dv.getInt32(68)
  store.minKey = dv.getInt32(72)
  store.maxKey = dv.getInt32(76)
  const binsLen = dv.getUint32(80)
  const bins = Array.from<number>({ length: binsLen })
  for (let i = 0; i < binsLen; i++) bins[i] = dv.getFloat64(HEADER_BYTES + i * 8)
  store.bins = bins
  store.count = bins.reduce((a, b) => a + b, 0)
  return sketch
}
