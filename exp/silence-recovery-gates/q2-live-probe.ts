import { copyFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"

const root = "/home/xp/src/copilot-api-js"
const port = Number.parseInt(process.env.Q2_PORT ?? "41922", 10)
const runs = Number.parseInt(process.env.Q2_RUNS ?? "2", 10)
const promptBytes = Number.parseInt(process.env.Q2_PROMPT_BYTES ?? "270000", 10)
const maxTokens = Number.parseInt(process.env.Q2_MAX_TOKENS ?? "64", 10)
if (!Number.isFinite(port) || port === 4141 || !Number.isFinite(runs) || runs < 1 || !Number.isFinite(promptBytes) || !Number.isFinite(maxTokens)) throw new Error("invalid Q2 arguments")

const outputDir = join(root, "exp", "silence-recovery-gates", "results", "q2")
mkdirSync(outputDir, { recursive: true })
const xdg = mkdtempSync(join(tmpdir(), `silence-q2-${port}-`))
const appDir = join(xdg, "copilot-api")
mkdirSync(appDir, { recursive: true })
const tokenSource = join(homedir(), ".local", "share", "copilot-api", "github_token")
const configSource = join(homedir(), ".local", "share", "copilot-api", "config.yaml")
if (!existsSync(tokenSource) || !existsSync(configSource)) throw new Error("real GHC token/config source unavailable")
copyFileSync(tokenSource, join(appDir, "github_token"))
copyFileSync(configSource, join(appDir, "config.yaml"))
const config = await Bun.file(join(appDir, "config.yaml")).text()
if (/hooks:\s*[\s\S]*?enabled:\s*true/.test(config)) throw new Error("refusing Q2: copied config enables upstream hook mock")

const serverLog = join(outputDir, "server.log")
const server = Bun.spawn(["bun", "run", "./packages/cli/src/main.ts", "start", "--port", String(port)], { cwd: root, env: { ...process.env, XDG_DATA_HOME: xdg, NODE_ENV: "production" }, stdout: Bun.file(serverLog), stderr: Bun.file(serverLog) })
let listenerPid: number | undefined

const exactListenerPid = (): number | undefined => {
  const out = Bun.spawnSync(["ss", "-ltnp", `( sport = :${port} )`], { stdout: "pipe" }).stdout.toString()
  const match = out.match(/pid=(\d+)/)
  return match ? Number.parseInt(match[1], 10) : undefined
}
const stop = () => {
  listenerPid = exactListenerPid() ?? listenerPid
  if (listenerPid !== undefined) {
    try { process.kill(listenerPid, "SIGTERM") } catch {}
  }
  try { server.kill() } catch {}
}
try {
  const baseURL = `http://127.0.0.1:${port}`
  const deadline = Date.now() + 60_000
  let health: unknown
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseURL}/health`, { signal: AbortSignal.timeout(2_000) })
      if (response.ok) { health = await response.json(); break }
    } catch {}
    await Bun.sleep(250)
  }
  if (!health) throw new Error("Q2 isolated proxy did not become healthy within 60s")
  listenerPid = exactListenerPid()
  if (!listenerPid) throw new Error("Q2 could not identify exact isolated listener PID")

  const models = await (await fetch(`${baseURL}/v1/models`)).json() as { data?: Array<{ id?: string }> }
  const candidates = ["claude-haiku-4.5", "claude-sonnet-4.6", "gpt-5.4-mini"]
  const model = candidates.find((candidate) => models.data?.some((entry) => entry.id === candidate))
  if (!model) throw new Error("Q2 no approved cheap model appeared in isolated catalog")

  const context = "x ".repeat(Math.ceil(promptBytes / 2)).slice(0, promptBytes)
  const body = { model, stream: true, max_tokens: maxTokens, thinking: { type: "enabled", budget_tokens: 32 }, messages: [{ role: "user", content: `Context follows. Think carefully, then reply with exactly Q2_OK and nothing else.\n\n${context}` }] }
  const attempts: Array<Record<string, unknown>> = []
  for (let attempt = 1; attempt <= runs; attempt++) {
    const startedAt = Date.now()
    let status: number | undefined
    let firstByteMs: number | undefined
    let bytes = 0
    let sample = ""
    let error: string | undefined
    try {
      const response = await fetch(`${baseURL}/v1/messages`, { method: "POST", headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" }, body: JSON.stringify(body), signal: AbortSignal.timeout(360_000) })
      status = response.status
      const reader = response.body?.getReader()
      if (!reader) throw new Error("response body missing")
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) break
        firstByteMs ??= Date.now() - startedAt
        bytes += chunk.value.byteLength
        if (sample.length < 2_000) sample += new TextDecoder().decode(chunk.value)
      }
    } catch (cause) { error = cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause) }
    attempts.push({ attempt, startedAt: new Date(startedAt).toISOString(), elapsedMs: Date.now() - startedAt, status, firstByteMs, bytes, sample, error })
  }
  const summaries = await (await fetch(`${baseURL}/history/api/entries?limit=10`, { signal: AbortSignal.timeout(60_000) })).json() as { entries?: Array<{ id?: string }> }
  const historyEntries: Array<Record<string, unknown>> = []
  for (const summary of summaries.entries ?? []) {
    if (!summary.id) continue
    const entry = await (await fetch(`${baseURL}/history/api/entries/${summary.id}`, { signal: AbortSignal.timeout(60_000) })).json() as Record<string, unknown>
    historyEntries.push({ id: summary.id, state: entry.state, model: entry.model, attempts: entry.attempts, clientResponse: entry.clientResponse })
  }
  const record = { port, listenerPid, xdg, health, model, promptBytes, maxTokens, attempts, historyEntries, interpretation: "A fresh retry is executed only after observing a first attempt with zero bytes and error/closure. This run otherwise measures the immediate 0-frame-hang baseline, not retry recoverability." }
  writeFileSync(join(outputDir, "result.json"), JSON.stringify(record, null, 2) + "\n")
  console.log(JSON.stringify(record, null, 2))
} finally {
  stop()
  await Bun.sleep(500)
  const post = exactListenerPid()
  if (post !== undefined) {
    try { process.kill(post, "SIGKILL") } catch {}
  }
}
