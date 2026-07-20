import {
  //
  expect,
  test,
} from "bun:test"

import {
  //
  createSketch,
  quantile,
} from "~/lib/telemetry/sketch"
import {
  //
  deserializePackedSketches,
  serializePackedSketches,
} from "~/lib/telemetry/sketch-blob"

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

function sketchOf(values: Array<number>): ReturnType<typeof createSketch> {
  const sk = createSketch(0.01)
  for (const v of values) sk.accept(v)
  return sk
}

test("单分布 round-trip：quantile 逐字节相等、min/max/count 保留", () => {
  const values = seeded(2000, 100000)
  const sk = sketchOf(values)
  const packed = serializePackedSketches(new Map([["duration_ms", sk]]))
  const back = deserializePackedSketches(packed)
  expect(back.size).toBe(1)
  const round = back.get("duration_ms")!
  for (const q of [0.5, 0.9, 0.99]) expect(quantile(round, q)).toBe(quantile(sk, q))
  expect(round.min).toBe(sk.min)
  expect(round.max).toBe(sk.max)
  expect(round.count).toBe(sk.count)
})

test("多分布 round-trip：每个分布各自还原、互不串扰", () => {
  const durationValues = seeded(1000, 300000, 1)
  const queueValues = seeded(800, 5000, 2)
  const inputTokValues = seeded(1200, 200000, 3)
  const duration = sketchOf(durationValues)
  const queue = sketchOf(queueValues)
  const inputTok = sketchOf(inputTokValues)

  const packed = serializePackedSketches(
    new Map([
      ["duration_ms", duration],
      ["queue_wait_ms", queue],
      ["input_tokens", inputTok],
    ]),
  )
  const back = deserializePackedSketches(packed)
  expect(back.size).toBe(3)
  expect([...back.keys()].sort()).toEqual(["duration_ms", "input_tokens", "queue_wait_ms"])

  for (const [name, original] of [
    ["duration_ms", duration],
    ["queue_wait_ms", queue],
    ["input_tokens", inputTok],
  ] as const) {
    const round = back.get(name)!
    expect(quantile(round, 0.99)).toBe(quantile(original, 0.99))
    expect(round.min).toBe(original.min)
    expect(round.max).toBe(original.max)
    expect(round.count).toBe(original.count)
  }
})

test("空 map round-trip 为空（count=0 合法帧）", () => {
  const packed = serializePackedSketches(new Map())
  const back = deserializePackedSketches(packed)
  expect(back.size).toBe(0)
})

test("坏 magic 抛错", () => {
  expect(() => deserializePackedSketches(new Uint8Array([0, 1, 2, 3, 4]))).toThrow()
})

test("坏 version 抛错", () => {
  const packed = serializePackedSketches(new Map([["duration_ms", sketchOf([1, 2, 3])]]))
  const corrupted = new Uint8Array(packed)
  corrupted[2] = 0xff // version 字节紧跟 2B magic
  expect(() => deserializePackedSketches(corrupted)).toThrow()
})
