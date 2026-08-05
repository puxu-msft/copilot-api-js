import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

const explicitDefaultFile = process.env.USE_COPILOT_API_TOKEN_FILE === "1"
const defaultDataHome = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share")
const tokenFile = process.env.GITHUB_TOKEN_FILE ?? (explicitDefaultFile ? join(defaultDataHome, "copilot-api", "github_token") : undefined)
const token = (process.env.GITHUB_TOKEN ?? (tokenFile ? await readFile(tokenFile, "utf8") : "")).trim()
if (!token) {
  throw new Error("Set GITHUB_TOKEN, GITHUB_TOKEN_FILE, or USE_COPILOT_API_TOKEN_FILE=1 explicitly before running this real probe")
}

const API_BASE_URL = "https://api.msft.ghe.com"
const commonHeaders = {
  accept: "application/json",
  authorization: `token ${token}`,
  "content-type": "application/json",
  "editor-version": "vscode/1.104.3",
  "editor-plugin-version": "copilot-chat/0.26.7",
  "user-agent": "copilot-api-enterprise-endpoint-probe",
  "x-vscode-user-agent-library-version": "electron-fetch",
}
const githubHeaders = { ...commonHeaders, "x-github-api-version": "2022-11-28" }
const copilotInternalHeaders = { ...commonHeaders, "x-github-api-version": "2025-04-01" }

console.log(
  JSON.stringify({
    probe: "public-token-cross-authority",
    tokenLength: token.length,
    tokenFingerprint: createHash("sha256").update(token).digest("hex").slice(0, 8),
  }),
)

async function requestSummary(label, url, headers) {
  const response = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(15_000),
  })
  const text = await response.text()
  let body
  try {
    body = JSON.parse(text)
  } catch {
    body = undefined
  }
  const summary = {
    label,
    url,
    status: response.status,
    ok: response.ok,
    contentType: response.headers.get("content-type") ?? "",
    loginPresent: typeof body?.login === "string",
    error: body?.error ?? body?.message,
    requestIdPresent: Boolean(response.headers.get("x-github-request-id")),
  }
  console.log(JSON.stringify(summary))
  return summary
}

const publicControl = await requestSummary("public-github-user-positive-control", "https://api.github.com/user", githubHeaders)
if (!publicControl.ok || !publicControl.loginPresent) {
  throw new Error("Positive control failed: the supplied token is not currently valid for https://api.github.com/user")
}

await requestSummary("enterprise-github-user", `${API_BASE_URL}/user`, githubHeaders)
await requestSummary("enterprise-copilot-token-exchange", `${API_BASE_URL}/copilot_internal/v2/token`, copilotInternalHeaders)
await requestSummary("enterprise-copilot-usage", `${API_BASE_URL}/copilot_internal/user`, copilotInternalHeaders)
