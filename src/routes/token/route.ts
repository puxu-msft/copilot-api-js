import {
  //
  createRoute,
  OpenAPIHono,
  z,
} from "@hono/zod-openapi"

import { state } from "~/lib/state"

export const tokenRoutes = new OpenAPIHono()

/** GitHub OAuth token info, or `null` when not authenticated. */
const GithubTokenSchema = z
  .object({
    token: z.string(),
    source: z.string().openapi({ description: "Token provider: cli | device-auth | env | file" }),
    expiresAt: z.number().nullable().openapi({ description: "Epoch ms, or null when non-expiring" }),
    refreshable: z.boolean(),
  })
  .nullable()

/** Copilot bearer token info, or `null` when not yet exchanged. */
const CopilotTokenSchema = z
  .object({
    token: z.string(),
    expiresAt: z.number().openapi({ description: "Epoch seconds" }),
    refreshIn: z.number().openapi({ description: "Seconds until proactive refresh" }),
  })
  .nullable()

const TokenInfoSchema = z
  .object({
    github: GithubTokenSchema,
    copilot: CopilotTokenSchema,
  })
  .openapi("TokenInfo")

const getTokensRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["tokens"],
  summary: "GitHub + Copilot token status",
  description: "Current GitHub OAuth and Copilot bearer token info (raw token values included).",
  responses: {
    200: {
      description: "Token info",
      content: { "application/json": { schema: TokenInfoSchema } },
    },
  },
})

tokenRoutes.openapi(getTokensRoute, (c) => {
  return c.json({
    github:
      state.tokenInfo ?
        {
          token: state.tokenInfo.token,
          source: state.tokenInfo.source,
          expiresAt: state.tokenInfo.expiresAt ?? null,
          refreshable: state.tokenInfo.refreshable,
        }
      : null,
    copilot:
      state.copilotTokenInfo ?
        {
          token: state.copilotTokenInfo.token,
          expiresAt: state.copilotTokenInfo.expiresAt,
          refreshIn: state.copilotTokenInfo.refreshIn,
        }
      : null,
  })
})
