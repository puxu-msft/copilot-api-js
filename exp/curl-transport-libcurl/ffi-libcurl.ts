import { CString, JSCallback, dlopen, ptr, read, toArrayBuffer } from "bun:ffi"

const DEFAULT_LIBCURL = "/lib/x86_64-linux-gnu/libcurl.so.4"

export const CurlCode = {
  OK: 0,
  WRITE_ERROR: 23,
  PARTIAL_FILE: 18,
  RECV_ERROR: 56,
  HTTP2_STREAM: 92,
  ABORTED_BY_CALLBACK: 42,
} as const

export const CurlOpt = {
  URL: 10002,
  WRITEFUNCTION: 20011,
  HEADERFUNCTION: 20079,
  HTTP_VERSION: 84,
  SSL_VERIFYPEER: 64,
  SSL_VERIFYHOST: 81,
  TCP_KEEPALIVE: 213,
  TCP_KEEPIDLE: 214,
  TCP_KEEPINTVL: 215,
  UPKEEP_INTERVAL_MS: 281,
  TIMEOUT_MS: 155,
  CONNECTTIMEOUT_MS: 156,
  NOPROGRESS: 43,
  XFERINFOFUNCTION: 20219,
} as const

export const CurlInfo = {
  RESPONSE_CODE: 0x200000 + 2,
  HTTP_VERSION: 0x200000 + 46,
  NAMELOOKUP_TIME: 0x300000 + 4,
  CONNECT_TIME: 0x300000 + 5,
  APPCONNECT_TIME: 0x300000 + 33,
  STARTTRANSFER_TIME: 0x300000 + 17,
  TOTAL_TIME: 0x300000 + 3,
  NUM_CONNECTS: 0x200000 + 26,
  ACTIVESOCKET: 0x500000 + 44,
  CONN_ID: 0x600000 + 64,
} as const

const HTTP_VERSION_2TLS = 4
const CURL_GLOBAL_ALL = 3n

function cstring(value: string): Uint8Array {
  return new TextEncoder().encode(`${value}\0`)
}

function parseHeaderLine(lineBytes: Uint8Array): string {
  return new TextDecoder().decode(lineBytes).replace(/\r?\n$/, "")
}

function longView(): BigInt64Array {
  return new BigInt64Array(1)
}

function doubleView(): Float64Array {
  return new Float64Array(1)
}

export interface ChunkObservation {
  atMs: number
  bytes: number
  text: string
}

export interface TransferResult {
  code: number
  error: string
  elapsedMs: number
  body: Uint8Array
  bodyChunks: ChunkObservation[]
  headerLines: Array<{ atMs: number; line: string }>
  responseCode: number
  httpVersion: number
  timings: {
    nameLookupMs: number
    connectMs: number
    appConnectMs: number
    startTransferMs: number
    totalMs: number
  }
  numConnects: number
  connId: bigint
  activeSocket: bigint
  abortRequestedAtMs?: number
  abortObservedAtMs?: number
}

export interface TransferOptions {
  url: string
  easy?: number
  insecure?: boolean
  http2?: boolean
  tcpKeepalive?: { idleSeconds: number; intervalSeconds: number }
  upkeepIntervalMs?: number
  timeoutMs?: number
  abortAfterMs?: number
  abortAfterFirstBodyChunk?: boolean
  onBodyChunk?: (chunk: Uint8Array, atMs: number) => void
  onHeaderLine?: (line: string, atMs: number) => void
}

export class Libcurl {
  readonly libraryPath: string
  readonly version: string
  private readonly base
  private readonly setString
  private readonly setLong
  private readonly setCallback
  private readonly getLong
  private readonly getDouble
  private readonly getOffT
  private readonly getSocket

  constructor(libraryPath = process.env.LIBCURL_PATH ?? DEFAULT_LIBCURL) {
    this.libraryPath = libraryPath
    this.base = dlopen(libraryPath, {
      curl_global_init: { args: ["i64"], returns: "i32" },
      curl_global_cleanup: { returns: "void" },
      curl_easy_init: { returns: "ptr" },
      curl_easy_perform: { args: ["ptr"], returns: "i32" },
      curl_easy_cleanup: { args: ["ptr"], returns: "void" },
      curl_easy_reset: { args: ["ptr"], returns: "void" },
      curl_easy_upkeep: { args: ["ptr"], returns: "i32" },
      curl_easy_strerror: { args: ["i32"], returns: "cstring" },
      curl_version: { returns: "cstring" },
    })
    this.setString = dlopen(libraryPath, { curl_easy_setopt: { args: ["ptr", "i32", "ptr"], returns: "i32" } })
    this.setLong = dlopen(libraryPath, { curl_easy_setopt: { args: ["ptr", "i32", "i64"], returns: "i32" } })
    this.setCallback = dlopen(libraryPath, { curl_easy_setopt: { args: ["ptr", "i32", "function"], returns: "i32" } })
    this.getLong = dlopen(libraryPath, { curl_easy_getinfo: { args: ["ptr", "i32", "ptr"], returns: "i32" } })
    this.getDouble = dlopen(libraryPath, { curl_easy_getinfo: { args: ["ptr", "i32", "ptr"], returns: "i32" } })
    this.getOffT = dlopen(libraryPath, { curl_easy_getinfo: { args: ["ptr", "i32", "ptr"], returns: "i32" } })
    this.getSocket = dlopen(libraryPath, { curl_easy_getinfo: { args: ["ptr", "i32", "ptr"], returns: "i32" } })
    const initCode = this.base.symbols.curl_global_init(CURL_GLOBAL_ALL)
    if (initCode !== CurlCode.OK) throw new Error(`curl_global_init failed: ${initCode}`)
    this.version = String(this.base.symbols.curl_version())
  }

  createEasy(): number {
    const easy = this.base.symbols.curl_easy_init()
    if (!easy) throw new Error("curl_easy_init returned null")
    return easy as number
  }

  cleanupEasy(easy: number): void {
    this.base.symbols.curl_easy_cleanup(easy)
  }

  upkeep(easy: number): { code: number; error: string } {
    const code = this.base.symbols.curl_easy_upkeep(easy)
    return { code, error: this.strError(code) }
  }

  strError(code: number): string {
    return String(this.base.symbols.curl_easy_strerror(code))
  }

  close(): void {
    this.base.symbols.curl_global_cleanup()
    this.getSocket.close()
    this.getOffT.close()
    this.getDouble.close()
    this.getLong.close()
    this.setCallback.close()
    this.setLong.close()
    this.setString.close()
    this.base.close()
  }

  perform(options: TransferOptions): TransferResult {
    const ownEasy = options.easy === undefined
    const easy = options.easy ?? this.createEasy()
    if (!ownEasy) this.base.symbols.curl_easy_reset(easy)

    const started = performance.now()
    const urlBytes = cstring(options.url)
    const bodyChunks: ChunkObservation[] = []
    const bodyBuffers: Uint8Array[] = []
    const headerLines: Array<{ atMs: number; line: string }> = []
    let abortRequestedAtMs: number | undefined
    let abortObservedAtMs: number | undefined
    let firstBodySeen = false

    const writeCallback = new JSCallback(
      (dataPointer: number, size: bigint, count: bigint) => {
        const length = Number(size * count)
        const chunk = new Uint8Array(toArrayBuffer(dataPointer as never, 0, length)).slice()
        const atMs = +(performance.now() - started).toFixed(1)
        bodyBuffers.push(chunk)
        bodyChunks.push({ atMs, bytes: length, text: new TextDecoder().decode(chunk) })
        options.onBodyChunk?.(chunk, atMs)
        firstBodySeen = true
        if (options.abortAfterFirstBodyChunk) {
          abortRequestedAtMs ??= atMs
          abortObservedAtMs = +(performance.now() - started).toFixed(1)
          return 0n
        }
        return BigInt(length)
      },
      { args: ["ptr", "u64", "u64", "ptr"], returns: "u64" },
    )
    const headerCallback = new JSCallback(
      (dataPointer: number, size: bigint, count: bigint) => {
        const length = Number(size * count)
        const chunk = new Uint8Array(toArrayBuffer(dataPointer as never, 0, length)).slice()
        const atMs = +(performance.now() - started).toFixed(1)
        const line = parseHeaderLine(chunk)
        headerLines.push({ atMs, line })
        options.onHeaderLine?.(line, atMs)
        return BigInt(length)
      },
      { args: ["ptr", "u64", "u64", "ptr"], returns: "u64" },
    )
    const progressCallback = new JSCallback(
      () => {
        if (options.abortAfterMs !== undefined && performance.now() - started >= options.abortAfterMs) {
          abortRequestedAtMs ??= +(performance.now() - started).toFixed(1)
          abortObservedAtMs = +(performance.now() - started).toFixed(1)
          return 1
        }
        return 0
      },
      { args: ["ptr", "i64", "i64", "i64", "i64"], returns: "i32" },
    )

    const check = (code: number, label: string): void => {
      if (code !== CurlCode.OK) throw new Error(`${label}: ${code} ${this.strError(code)}`)
    }

    check(this.setString.symbols.curl_easy_setopt(easy, CurlOpt.URL, urlBytes), "CURLOPT_URL")
    check(this.setCallback.symbols.curl_easy_setopt(easy, CurlOpt.WRITEFUNCTION, writeCallback), "CURLOPT_WRITEFUNCTION")
    check(this.setCallback.symbols.curl_easy_setopt(easy, CurlOpt.HEADERFUNCTION, headerCallback), "CURLOPT_HEADERFUNCTION")
    check(this.setLong.symbols.curl_easy_setopt(easy, CurlOpt.SSL_VERIFYPEER, options.insecure ? 0n : 1n), "CURLOPT_SSL_VERIFYPEER")
    check(this.setLong.symbols.curl_easy_setopt(easy, CurlOpt.SSL_VERIFYHOST, options.insecure ? 0n : 2n), "CURLOPT_SSL_VERIFYHOST")
    if (options.http2 !== false) check(this.setLong.symbols.curl_easy_setopt(easy, CurlOpt.HTTP_VERSION, BigInt(HTTP_VERSION_2TLS)), "CURLOPT_HTTP_VERSION")
    if (options.timeoutMs !== undefined) check(this.setLong.symbols.curl_easy_setopt(easy, CurlOpt.TIMEOUT_MS, BigInt(options.timeoutMs)), "CURLOPT_TIMEOUT_MS")
    if (options.tcpKeepalive) {
      check(this.setLong.symbols.curl_easy_setopt(easy, CurlOpt.TCP_KEEPALIVE, 1n), "CURLOPT_TCP_KEEPALIVE")
      check(this.setLong.symbols.curl_easy_setopt(easy, CurlOpt.TCP_KEEPIDLE, BigInt(options.tcpKeepalive.idleSeconds)), "CURLOPT_TCP_KEEPIDLE")
      check(this.setLong.symbols.curl_easy_setopt(easy, CurlOpt.TCP_KEEPINTVL, BigInt(options.tcpKeepalive.intervalSeconds)), "CURLOPT_TCP_KEEPINTVL")
    }
    if (options.upkeepIntervalMs !== undefined) check(this.setLong.symbols.curl_easy_setopt(easy, CurlOpt.UPKEEP_INTERVAL_MS, BigInt(options.upkeepIntervalMs)), "CURLOPT_UPKEEP_INTERVAL_MS")
    if (options.abortAfterMs !== undefined) {
      check(this.setLong.symbols.curl_easy_setopt(easy, CurlOpt.NOPROGRESS, 0n), "CURLOPT_NOPROGRESS")
      check(this.setCallback.symbols.curl_easy_setopt(easy, CurlOpt.XFERINFOFUNCTION, progressCallback), "CURLOPT_XFERINFOFUNCTION")
    }

    const code = this.base.symbols.curl_easy_perform(easy)
    const elapsedMs = +(performance.now() - started).toFixed(1)
    if (abortRequestedAtMs !== undefined && abortObservedAtMs === undefined) abortObservedAtMs = elapsedMs

    const getLong = (info: number): number => {
      const view = longView()
      const result = this.getLong.symbols.curl_easy_getinfo(easy, info, view)
      return result === 0 ? Number(view[0]) : -1
    }
    const getDouble = (info: number): number => {
      const view = doubleView()
      const result = this.getDouble.symbols.curl_easy_getinfo(easy, info, view)
      return result === 0 ? view[0] : -1
    }
    const getOffT = (info: number): bigint => {
      const view = longView()
      const result = this.getOffT.symbols.curl_easy_getinfo(easy, info, view)
      return result === 0 ? view[0] : -1n
    }
    const getSocket = (): bigint => {
      const view = longView()
      const result = this.getSocket.symbols.curl_easy_getinfo(easy, CurlInfo.ACTIVESOCKET, view)
      return result === 0 ? view[0] : -1n
    }

    const bodyLength = bodyBuffers.reduce((sum, chunk) => sum + chunk.length, 0)
    const body = new Uint8Array(bodyLength)
    let offset = 0
    for (const chunk of bodyBuffers) {
      body.set(chunk, offset)
      offset += chunk.length
    }

    const result: TransferResult = {
      code,
      error: this.strError(code),
      elapsedMs,
      body,
      bodyChunks,
      headerLines,
      responseCode: getLong(CurlInfo.RESPONSE_CODE),
      httpVersion: getLong(CurlInfo.HTTP_VERSION),
      timings: {
        nameLookupMs: +(getDouble(CurlInfo.NAMELOOKUP_TIME) * 1000).toFixed(3),
        connectMs: +(getDouble(CurlInfo.CONNECT_TIME) * 1000).toFixed(3),
        appConnectMs: +(getDouble(CurlInfo.APPCONNECT_TIME) * 1000).toFixed(3),
        startTransferMs: +(getDouble(CurlInfo.STARTTRANSFER_TIME) * 1000).toFixed(3),
        totalMs: +(getDouble(CurlInfo.TOTAL_TIME) * 1000).toFixed(3),
      },
      numConnects: getLong(CurlInfo.NUM_CONNECTS),
      connId: getOffT(CurlInfo.CONN_ID),
      activeSocket: getSocket(),
      ...(abortRequestedAtMs === undefined ? {} : { abortRequestedAtMs }),
      ...(abortObservedAtMs === undefined ? {} : { abortObservedAtMs }),
    }

    writeCallback.close()
    headerCallback.close()
    progressCallback.close()
    if (ownEasy) this.cleanupEasy(easy)
    return result
  }
}

export function resultForJson(result: TransferResult): object {
  return {
    ...result,
    body: new TextDecoder().decode(result.body),
    connId: result.connId.toString(),
    activeSocket: result.activeSocket.toString(),
  }
}
