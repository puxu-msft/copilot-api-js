import {
  //
  createSketch,
  serializeSketch,
  deserializeSketch,
  mergeSketch,
  quantile,
} from "@hsupu/ghc-proxy-telemetry/telemetry/sketch"
import {
  //
  expect,
  test,
} from "bun:test"

/** 独立 oracle：排序数组精确百分位（非 sketch-vs-sketch 自证）。 */
function exactQuantile(values: Array<number>, q: number): number {
  const s = [...values].sort((a, b) => a - b)
  const rank = q * (s.length - 1)
  const lo = Math.floor(rank)
  const hi = Math.ceil(rank)
  return s[lo] + (s[hi] - s[lo]) * (rank - lo)
}

function seeded(n: number, span: number, seed = 12345): Array<number> {
  // 确定性伪随机（LCG），避免 flaky
  let x = seed
  const out: Array<number> = []
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff
    out.push((x % span) + 1)
  }
  return out
}

test("serialize→deserialize 往返：quantile 完全相等、保 min/max", () => {
  const values = seeded(5000, 300000)
  const orig = createSketch(0.01)
  for (const v of values) orig.accept(v)
  const round = deserializeSketch(serializeSketch(orig))

  for (const q of [0.5, 0.9, 0.99]) {
    expect(quantile(round, q)).toBe(quantile(orig, q)) // 逐字节往返、无损
  }
  expect(round.min).toBe(orig.min) // protobuf fromProto 会丢这俩
  expect(round.max).toBe(orig.max)
  expect(round.count).toBe(orig.count)
})

test("sketch quantile vs exact oracle 在 1% 相对误差界内", () => {
  const values = seeded(5000, 300000, 999)
  const sk = createSketch(0.01)
  for (const v of values) sk.accept(v)
  for (const q of [0.5, 0.9, 0.99]) {
    const relErr = Math.abs(quantile(sk, q) - exactQuantile(values, q)) / exactQuantile(values, q)
    expect(relErr).toBeLessThanOrEqual(0.011)
  }
})

test("跨层 merge：count 精确、p99 vs exact oracle ≤1%（零累积）", () => {
  const all: Array<number> = []
  const merged = createSketch(0.01)
  for (let bucket = 0; bucket < 12; bucket++) {
    const raw = createSketch(0.01)
    const chunk = seeded(400, 120000, bucket + 1)
    for (const v of chunk) {
      raw.accept(v)
      all.push(v)
    }
    mergeSketch(merged, raw)
  }
  expect(merged.count).toBe(all.length) // count 精确
  const relErr = Math.abs(quantile(merged, 0.99) - exactQuantile(all, 0.99)) / exactQuantile(all, 0.99)
  expect(relErr).toBeLessThanOrEqual(0.011)
})

test("异 γ merge 抛（fail-loud，非静默错）", () => {
  const a = createSketch(0.01)
  const b = createSketch(0.02)
  a.accept(10)
  b.accept(10)
  expect(() => mergeSketch(a, b)).toThrow()
})

test("γ 下限：0.01 不塌缩(<2048 bin)、0.001 塌缩(>2048)", () => {
  const wide = createSketch(0.001)
  const ok = createSketch(0.01)
  for (const v of [1, 60000, 300000, 1000000]) {
    wide.accept(v)
    ok.accept(v)
  }
  expect(wide.store.maxKey - wide.store.minKey + 1).toBeGreaterThan(2048)
  expect(ok.store.maxKey - ok.store.minKey + 1).toBeLessThan(2048)
})

test("空 sketch（count=0/bins=[]）序列化往返边界", () => {
  const empty = createSketch(0.01)
  const round = deserializeSketch(serializeSketch(empty))
  expect(round.count).toBe(0)
  expect(quantile(round, 0.5)).toBe(quantile(empty, 0.5))
})

test("损坏字节：bad magic 抛，非静默返回垃圾 sketch", () => {
  const sk = createSketch(0.01)
  sk.accept(42)
  const bytes = serializeSketch(sk)
  const corrupt = new Uint8Array(bytes)
  corrupt[0] = 0x00 // 破坏 magic 高字节
  corrupt[1] = 0x00
  expect(() => deserializeSketch(corrupt)).toThrow(/bad magic/)
})
