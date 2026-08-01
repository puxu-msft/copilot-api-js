import { createHash } from "node:crypto"
import fs from "node:fs"

import { CERT, PORTS, ROOT, runCurl, summarize, text } from "./lib"

const h1 = `http://127.0.0.1:${PORTS.h1}`
const h2 = `http://127.0.0.1:${PORTS.h2c}`
const raw = `http://127.0.0.1:${PORTS.rawH1}`
const https = `https://localhost:${PORTS.https}`

async function headers() {
  const inlineH1 = await runCurl(["-sS", "-i", `${h1}/headers`])
  const inlineH2 = await runCurl(["-sS", "-i", "--http2-prior-knowledge", `${h2}/headers`])
  const fd3 = await runCurl(["-sS", "--http2-prior-knowledge", "-D", "/dev/fd/3", `${h2}/headers`], { stdio: ["ignore", "pipe", "pipe", "pipe"] })
  const fd3Stderr = await runCurl(["-sS", "--http2-prior-knowledge", "-D", "/dev/stderr", `${h2}/headers`])
  const temp = `${ROOT}/tmp-headers-${process.pid}.txt`
  const tempResult = await runCurl(["-sS", "--http2-prior-knowledge", "-D", temp, `${h2}/headers`])
  const tempHeaders = await Bun.file(temp).text()
  fs.unlinkSync(temp)
  const inheritedFdPath = `${ROOT}/tmp-inherited-fd-${process.pid}.txt`
  const inheritedFd = fs.openSync(inheritedFdPath, "w+")
  fs.unlinkSync(inheritedFdPath)
  const inherited = await runCurl(["-sS", "--http2-prior-knowledge", "-D", "/dev/fd/3", `${h2}/headers`], { stdio: ["ignore", "pipe", "pipe", inheritedFd] })
  const inheritedHeaders = fs.readFileSync(inheritedFd, "utf8")
  fs.closeSync(inheritedFd)
  console.log(JSON.stringify({
    section: "headers",
    inlineH1: { exit: inlineH1.exit, stdout: text(inlineH1.stdout), stderr: text(inlineH1.stderr) },
    inlineH2: { exit: inlineH2.exit, stdout: text(inlineH2.stdout), stderr: text(inlineH2.stderr) },
    fd3: { exit: fd3.exit, body: text(fd3.stdout), headers: text(fd3.fd3), stderr: text(fd3.stderr) },
    dumpStderr: { exit: fd3Stderr.exit, body: text(fd3Stderr.stdout), stderr: text(fd3Stderr.stderr) },
    temp: { exit: tempResult.exit, body: text(tempResult.stdout), headers: tempHeaders, stderr: text(tempResult.stderr) },
    inheritedFd: { exit: inherited.exit, body: text(inherited.stdout), headers: inheritedHeaders, stderr: text(inherited.stderr) },
  }))
}

async function trailers() {
  const rows = []
  for (const [name, args] of [
    ["h2-inline", ["-sS", "-i", "--http2-prior-knowledge", `${h2}/trailers`]],
    ["h2-fd3-pipe", ["-sS", "--http2-prior-knowledge", "-D", "/dev/fd/3", `${h2}/trailers`]],
    ["h1-inline", ["-sS", "-i", `${h1}/trailers`]],
    ["h1-fd3-pipe", ["-sS", "-D", "/dev/fd/3", `${h1}/trailers`]],
  ] as const) {
    const result = await runCurl(args, { stdio: name.includes("fd3") ? ["ignore", "pipe", "pipe", "pipe"] : undefined })
    rows.push({ name, exit: result.exit, stdout: text(result.stdout), headers: text(result.fd3), stderr: text(result.stderr) })
  }
  const temp = `${ROOT}/tmp-trailers-${process.pid}.txt`
  const result = await runCurl(["-sS", "--http2-prior-knowledge", "-D", temp, `${h2}/trailers`])
  const captured = fs.readFileSync(temp, "utf8")
  fs.unlinkSync(temp)
  rows.push({ name: "h2-temp-file", exit: result.exit, stdout: text(result.stdout), headers: captured, stderr: text(result.stderr) })
  console.log(JSON.stringify({ section: "trailers", rows }))
}

async function truncation() {
  const cases = [
    ["h2-clean", ["-sS", "--http2-prior-knowledge", `${h2}/ok`]],
    ["h2-rst", ["-sS", "--http2-prior-knowledge", `${h2}/rst`]],
    ["h2-destroy", ["-sS", "--http2-prior-knowledge", `${h2}/destroy`]],
    ["h1-clean", ["-sS", `${raw}/clean`]],
    ["h1-content-length-short", ["-sS", `${raw}/content-length`]],
    ["h1-chunk-incomplete", ["-sS", `${raw}/chunk-incomplete`]],
  ] as const
  const rows = []
  for (const [name, args] of cases) {
    const result = await runCurl(args)
    rows.push({ name, exit: result.exit, signal: result.signal, stdout: text(result.stdout), stderr: text(result.stderr) })
  }
  console.log(JSON.stringify({ section: "truncation", rows }))
}

async function body() {
  const size = 32 * 1024 * 1024
  const body = Buffer.alloc(size, 0x78)
  const sha256 = createHash("sha256").update(body).digest("hex")
  const viaStdin = await runCurl(["-sS", "-N", "--data-binary", "@-", `${h1}/duplex`], { stdin: body })
  const echoStdin = await runCurl(["-sS", "--data-binary", "@-", "-H", "X-Special: spaces; $dollar, colon: value", "-H", "X-Empty;", `${h1}/echo`], { stdin: body })
  const temp = `${ROOT}/tmp-body-${process.pid}.bin`
  await Bun.write(temp, body)
  const echoFile = await runCurl(["-sS", "--data-binary", `@${temp}`, `${h1}/echo`])
  fs.unlinkSync(temp)
  console.log(JSON.stringify({
    section: "body",
    expected: { bytes: size, sha256 },
    fullDuplex: { exit: viaStdin.exit, ms: viaStdin.ms, outBytes: viaStdin.stdout.length, tail: text(viaStdin.stdout.slice(-64)), stderr: text(viaStdin.stderr) },
    stdinEcho: { exit: echoStdin.exit, json: JSON.parse(text(echoStdin.stdout)), stderr: text(echoStdin.stderr) },
    fileEcho: { exit: echoFile.exit, json: JSON.parse(text(echoFile.stdout)), stderr: text(echoFile.stderr) },
  }))
}

async function processOverhead() {
  const values = []
  for (let i = 0; i < 50; i++) {
    const result = await runCurl(["-sS", "-o", "/dev/null", "-w", "%{time_starttransfer}", `${h1}/ok`])
    const curlTtfbMs = Number(text(result.stdout)) * 1000
    values.push({ wallMs: result.ms, curlTtfbMs, processRemainderMs: result.ms - curlTtfbMs, exit: result.exit })
  }
  console.log(JSON.stringify({ section: "process-overhead", wall: summarize(values.map((x) => x.wallMs)), curlTtfb: summarize(values.map((x) => x.curlTtfbMs)), processRemainder: summarize(values.map((x) => x.processRemainderMs)), rows: values }))
}

async function proxy() {
  const target = `${https}/ok`
  const cases = [
    ["http-connect", ["-skS", "--noproxy", "", "--http2", "--proxy", `http://127.0.0.1:${PORTS.httpProxy}`, "-o", "/dev/null", "-w", "%{http_version}", target]],
    ["https-proxy-h1", ["-skS", "--noproxy", "", "--http2", "--proxy-insecure", "--proxy", `https://localhost:${PORTS.httpsProxy}`, "-o", "/dev/null", "-w", "%{http_version}", target]],
    ["https-proxy-h2", ["-skS", "--noproxy", "", "--http2", "--proxy-insecure", "--proxy-http2", "--proxy", `https://localhost:${PORTS.httpsProxy}`, "-o", "/dev/null", "-w", "%{http_version}", target]],
    ["socks5", ["-skS", "--noproxy", "", "--http2", "--socks5", `127.0.0.1:${PORTS.socks}`, "-o", "/dev/null", "-w", "%{http_version}", target]],
  ] as const
  const rows = []
  for (const [name, args] of cases) {
    const result = await runCurl(args)
    rows.push({ name, exit: result.exit, httpVersion: text(result.stdout), stderr: text(result.stderr) })
  }
  console.log(JSON.stringify({ section: "proxy", rows }))
}

const section = process.argv[2] ?? "all"
const runs: Record<string, () => Promise<void>> = { headers, trailers, truncation, body, overhead: processOverhead, proxy }
if (section === "all") for (const run of Object.values(runs)) await run()
else if (runs[section]) await runs[section]()
else throw new Error(`unknown section ${section}`)
