import { createHash } from "node:crypto"

const token = process.env.GITHUB_TOKEN?.trim()
if (!token) {
  throw new Error("Set GITHUB_TOKEN explicitly before running this real cross-authority probe")
}

const API_BASE_URL = "https://api.msft.ghe.com"
const headers = {
  accept: "application/json",
  authorization: `token ${token}`,
  "content-type": "application/json",
  "editor-version": "vscode/1.104.3",
  "editor-plugin-version": "copilot-chat/0.26.7",
  "user-agent": "copilot-api-enterprise-endpoint-probe",
  "x-github-api-version": "2025-04-01",
  "x-vscode-user-agent-library-version": "electron-fetch",
}

console.log(
  JSON.stringify({
    probe: "public-token-cross-authority",
    tokenLength: token.length,
    tokenFingerprint: createHash("sha256").update(token).digest("hex").slice(0, 8),
  }),
)

for (const [label, path] of [
  ["github-user", "/user"],
  ["copilot-token-exchange", "/copilot_internal/v2/token"],
  ["copilot-usage", "/copilot_internal/user"],
]) {
  const response = await fetch(`${API_BASE_URL}${path}`, {
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
  console.log(
    JSON.stringify({
      label,
      url: `${API_BASE_URL}${path}`,
      status: response.status,
      ok: response.ok,
      contentType: response.headers.get("content-type") ?? "",
      error: body?.error ?? body?.message,
      requestIdPresent: Boolean(response.headers.get("x-github-request-id")),
    }),
  )
}
