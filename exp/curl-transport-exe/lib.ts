export const ROOT = "/home/xp/src/copilot-api-js/exp/curl-transport-exe"
export const CERT = `${ROOT}/test-cert.pem`
export const KEY = `${ROOT}/test-key.pem`
export const PORTS = {
  h1: 19080,
  h2c: 19081,
  httpProxy: 19082,
  socks: 19083,
  rawH1: 19084,
  https: 19443,
  httpsProxy: 19444,
} as const

export const decoder = new TextDecoder()

export async function readStream(stream: ReadableStream<Uint8Array> | number | null | undefined): Promise<Uint8Array> {
  if (typeof stream === "number") return new Uint8Array(await Bun.file(stream).arrayBuffer())
  if (!stream) return new Uint8Array()
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

export async function runCurl(
  args: string[],
  options: { stdin?: Uint8Array | string; stdio?: Array<"pipe" | "ignore" | "inherit" | number>; env?: Record<string, string | undefined> } = {},
): Promise<{ exit: number; signal: string | null; stdout: Uint8Array; stderr: Uint8Array; fd3?: Uint8Array; ms: number }> {
  const stdio = (options.stdio ?? [options.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"]) as ["pipe" | "ignore" | "inherit" | number, "pipe" | "ignore" | "inherit" | number, "pipe" | "ignore" | "inherit" | number, ...Array<"pipe" | "ignore" | "inherit" | number>]
  const started = performance.now()
  const proc = Bun.spawn({ cmd: ["curl", "-q", ...args], stdio, env: options.env ?? process.env })
  const stdoutP = readStream(proc.stdout)
  const stderrP = readStream(proc.stderr)
  const fd3P = stdio.length > 3 ? readStream(proc.stdio[3]) : undefined
  if (options.stdin !== undefined && proc.stdin && typeof proc.stdin !== "number") {
    proc.stdin.write(options.stdin)
    proc.stdin.end()
  }
  const exit = await proc.exited
  const [stdout, stderr, fd3] = await Promise.all([stdoutP, stderrP, fd3P])
  return { exit, signal: proc.signalCode, stdout, stderr, fd3, ms: performance.now() - started }
}

export function text(bytes: Uint8Array | undefined): string {
  return bytes ? decoder.decode(bytes) : ""
}

export function quantile(values: number[], q: number): number {
  const sorted = [...values].sort((a, b) => a - b)
  const index = q <= 0 ? 0 : Math.min(sorted.length - 1, Math.ceil(sorted.length * q) - 1)
  return sorted[index] ?? Number.NaN
}

export function summarize(values: number[]) {
  return {
    n: values.length,
    min: quantile(values, 0),
    median: quantile(values, 0.5),
    p95: quantile(values, 0.95),
    max: quantile(values, 1),
    all: values,
  }
}
