import { createDeviceCode, exchangeDeviceCode } from "@octokit/oauth-methods"
import { request } from "@octokit/request"

const calls = []
const delays = []
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
        interval: 5,
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
      headers: { "content-type": "application/json", date: new Date(0).toUTCString() },
    })
  }

  throw new Error(`Unexpected URL: ${url}`)
}

const oauthRequest = request.defaults({
  baseUrl: "https://msft.ghe.com",
  request: { fetch: tokenFetchAdapter },
})

const { data: verification } = await createDeviceCode({
  clientType: "oauth-app",
  clientId: "Iv1.b507a08c87ecfe98",
  scopes: ["read:user"],
  request: oauthRequest,
})

let pollingInterval = verification.interval
let token
while (!token) {
  try {
    const result = await exchangeDeviceCode({
      clientType: "oauth-app",
      clientId: "Iv1.b507a08c87ecfe98",
      code: verification.device_code,
      request: oauthRequest,
    })
    token = result.authentication.token
  } catch (error) {
    const errorType = error?.response?.data?.error
    if (errorType === "slow_down") {
      pollingInterval += 7
    } else if (errorType !== "authorization_pending") {
      throw error
    }
    delays.push(pollingInterval)
    // Production injects an abortable scheduler. The PoC records the delay and
    // yields once so it remains deterministic and fast.
    await Promise.resolve()
  }
}

console.log(
  JSON.stringify({
    verification: {
      uri: verification.verification_uri,
      codePresent: Boolean(verification.user_code),
    },
    calls,
    delays,
    polls,
    tokenReturned: token === "enterprise-token",
  }),
)
