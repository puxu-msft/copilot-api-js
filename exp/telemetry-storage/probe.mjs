// PoC 探针：遥测存储 4 项实测 + γ bin + 手动序列化保 min/max + 跨层 merge 独立 oracle
// 双跑：bun probe.mjs / node probe.mjs
import pkg from "@datadog/sketches-js"
const { DDSketch } = pkg

const RT = typeof Bun !== "undefined" ? `Bun ${Bun.version}` : `Node ${process.version}`
console.log(`\n########## runtime: ${RT} ##########`)

// ---------- exact-quantile oracle（独立，非 sketch-vs-sketch）----------
function exactQuantile(values, q) {
  const s = [...values].sort((a, b) => a - b)
  const rank = q * (s.length - 1)
  const lo = Math.floor(rank), hi = Math.ceil(rank)
  return s[lo] + (s[hi] - s[lo]) * (rank - lo)
}

// ---------- 手动 DenseStore 序列化（弃 protobuf，保 min/max）----------
function serializeSketch(sk) {
  const st = sk.store
  return JSON.stringify({
    g: sk.mapping.gamma,
    off: st.offset, min: st.minKey, max: st.maxKey,
    bins: st.bins, zc: sk.zeroCount,
    c: sk.count, mn: sk.min, mx: sk.max, sm: sk.sum,
  })
}
function deserializeSketch(json, relativeAccuracy = 0.01) {
  const o = JSON.parse(json)
  const sk = new DDSketch({ relativeAccuracy })
  sk.store.offset = o.off; sk.store.minKey = o.min; sk.store.maxKey = o.max
  sk.store.bins = o.bins; sk.store.count = o.bins.reduce((a, b) => a + b, 0)
  sk.zeroCount = o.zc; sk.count = o.c; sk.min = o.mn; sk.max = o.mx; sk.sum = o.sm
  return sk
}

// ---------- PROBE 1: 手动序列化往返一致性 + 保 min/max ----------
{
  const values = Array.from({ length: 5000 }, () => Math.floor(Math.random() * 300000))
  const orig = new DDSketch({ relativeAccuracy: 0.01 })
  for (const v of values) orig.accept(v)
  const round = deserializeSketch(serializeSketch(orig))
  const qs = [0.5, 0.9, 0.99]
  let maxErr = 0
  for (const q of qs) {
    const a = orig.getValueAtQuantile(q), b = round.getValueAtQuantile(q)
    const exact = exactQuantile(values, q)
    const relErr = Math.abs(b - exact) / exact
    maxErr = Math.max(maxErr, relErr)
    console.log(`  P1 q${q}: orig=${a.toFixed(1)} round=${b.toFixed(1)} exact=${exact.toFixed(1)} relErr=${(relErr*100).toFixed(2)}%`)
  }
  console.log(`  P1 round-trip identical: ${orig.getValueAtQuantile(0.99) === round.getValueAtQuantile(0.99)}`)
  console.log(`  P1 min/max preserved: min ${round.min===orig.min} max ${round.max===orig.max} (protobuf fromProto 会丢这俩)`)
  console.log(`  P1 max relErr vs exact ≤ 1%? ${maxErr <= 0.011}`)
}

// ---------- PROBE 1b: 跨层 merge 零累积（独立 oracle）----------
{
  const all = []
  const merged = new DDSketch({ relativeAccuracy: 0.01 })
  // 模拟 12 个 raw 桶（hourly = 12×5min），逐个 merge
  for (let bucket = 0; bucket < 12; bucket++) {
    const raw = new DDSketch({ relativeAccuracy: 0.01 })
    for (let i = 0; i < 400; i++) { const v = Math.floor(Math.random() * 120000) + 1; raw.accept(v); all.push(v) }
    merged.merge(raw)  // 跨层上卷
  }
  const q = 0.99
  const mq = merged.getValueAtQuantile(q), exact = exactQuantile(all, q)
  const relErr = Math.abs(mq - exact) / exact
  console.log(`  P1b 12桶merge后 p99=${mq.toFixed(1)} exact=${exact.toFixed(1)} relErr=${(relErr*100).toFixed(2)}% count=${merged.count}(应=${all.length})`)
  console.log(`  P1b merge count 精确: ${merged.count === all.length}, relErr ≤ 1%: ${relErr <= 0.011}`)
}

// ---------- PROBE 4: γ bin 数 vs 2048 塌缩阈值 ----------
{
  for (const g of [0.01, 0.005, 0.001]) {
    const sk = new DDSketch({ relativeAccuracy: g })
    for (const v of [1, 60000, 300000, 1000000]) sk.accept(v)  // 值域 1..1e6
    // bin 数 = 覆盖 min..max 的 key 跨度
    const span = sk.store.maxKey - sk.store.minKey + 1
    console.log(`  P4 γ=${g}: 值域1..1e6 bin跨度≈${span} (limit 2048, 塌缩? ${span >= 2048})`)
  }
}

// ---------- PROBE serialize size + zstd ----------
{
  const sk = new DDSketch({ relativeAccuracy: 0.01 })
  for (let i = 0; i < 2000; i++) sk.accept(Math.floor(Math.random() * 120000) + 1)
  const json = serializeSketch(sk)
  const bytes = Buffer.from(json, "utf8")
  console.log(`  Pz sketch DenseStore JSON: ${bytes.length} bytes (单分布)`)
  // zstd via node:zlib (project 用同款)
  const zlib = await import("node:zlib")
  if (zlib.zstdCompressSync) {
    const z = zlib.zstdCompressSync(bytes, { params: { [zlib.constants.ZSTD_c_compressionLevel]: 3 } })
    console.log(`  Pz zstd(lvl3): ${z.length} bytes, ratio=${(bytes.length/z.length).toFixed(2)}x`)
  } else console.log(`  Pz zstd: node:zlib 无 zstdCompressSync (需 Node≥22.15;此 runtime 不支持)`)
}
