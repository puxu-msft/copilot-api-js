const CLIENT_ID = "Iv1.b507a08c87ecfe98"
const WEB_BASE_URL = "https://msft.ghe.com"
const API_BASE_URL = "https://api.msft.ghe.com"
const COPILOT_BASE_URL = "https://copilot-api.msft.ghe.com"

const headers = {
  accept: "application/json",
  "content-type": "application/json",
  "user-agent": "copilot-api-enterprise-endpoint-probe",
}

async function summarize(label, url, init = {}) {
  const startedAt = Date.now()
  try {
    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(15_000) })
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
        url,
        status: response.status,
        ok: response.ok,
        contentType: response.headers.get("content-type") ?? "",
        elapsedMs: Date.now() - startedAt,
        requestIdPresent: Boolean(response.headers.get("x-github-request-id")),
        error: body?.error ?? body?.message,
        errorDescriptionPresent: Boolean(body?.error_description),
        verificationHost: body?.verification_uri ? new URL(body.verification_uri).hostname : undefined,
        deviceFieldsPresent: Boolean(body?.device_code && body?.user_code && body?.expires_in && body?.interval),
      }),
    )
  } catch (error) {
    console.log(
      JSON.stringify({
        label,
        url,
        networkError: error instanceof Error ? error.name : "Error",
        message: error instanceof Error ? error.message : String(error),
        elapsedMs: Date.now() - startedAt,
      }),
    )
  }
}

await summarize("oauth-device-code", `${WEB_BASE_URL}/login/device/code`, {
  method: "POST",
  headers,
  body: JSON.stringify({ client_id: CLIENT_ID, scope: "read:user" }),
})
await summarize("oauth-token-poll-invalid-control", `${WEB_BASE_URL}/login/oauth/access_token`, {
  method: "POST",
  headers,
  body: JSON.stringify({
    client_id: CLIENT_ID,
    device_code: "invalid-probe-code",
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
  }),
})
await summarize("github-user-anonymous", `${API_BASE_URL}/user`, { headers })
await summarize("github-copilot-token-anonymous", `${API_BASE_URL}/copilot_internal/v2/token`, { headers })
await summarize("copilot-models-anonymous", `${COPILOT_BASE_URL}/models`, { headers })
