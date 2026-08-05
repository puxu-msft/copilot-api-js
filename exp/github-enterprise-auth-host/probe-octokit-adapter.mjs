import { createOAuthDeviceAuth } from "@octokit/auth-oauth-device"
import { request } from "@octokit/request"

const calls = []
let polls = 0

const tokenFetchAdapter = async (url, init) => {
  calls.push({
    url: String(url),
    method: init?.method,
    accept: new Headers(init?.headers).get("accept"),
  })

  if (String(url).endsWith("/login/device/code")) {
    return new Response(
      JSON.stringify({
        device_code: "device-secret",
        user_code: "ABCD-EFGH",
        verification_uri: "https://msft.ghe.com/login/device",
        expires_in: 899,
        interval: 0,
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )
  }

  if (String(url).endsWith("/login/oauth/access_token")) {
    polls += 1
    if (polls === 1) {
      return new Response(
        JSON.stringify({
          error: "slow_down",
          error_description: "Too fast",
          error_uri: "https://docs.github.com/",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )
    }
    return new Response(JSON.stringify({ access_token: "enterprise-token", token_type: "bearer", scope: "read:user" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  }

  throw new Error(`Unexpected URL: ${url}`)
}

const oauthRequest = request.defaults({
  baseUrl: "https://msft.ghe.com",
  request: { fetch: tokenFetchAdapter },
})

let verification
const auth = createOAuthDeviceAuth({
  clientType: "oauth-app",
  clientId: "Iv1.b507a08c87ecfe98",
  scopes: ["read:user"],
  request: oauthRequest,
  onVerification(value) {
    verification = {
      uri: value.verification_uri,
      codePresent: Boolean(value.user_code),
    }
  },
})

const result = await auth({ type: "oauth" })
console.log(
  JSON.stringify({
    verification,
    calls,
    polls,
    tokenReturned: result.token === "enterprise-token",
    scopes: result.scopes,
  }),
)
