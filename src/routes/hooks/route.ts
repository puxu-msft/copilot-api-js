/**
 * Upstream-hook management API.
 *
 * `GET /` reports the DECLARED config (`hooks.enabled` / `hooks.upstream_module`
 * from config.yaml, via `state`) separately from the EFFECTIVE loaded state
 * (`getUpstreamHookState()`) — a config change alone never touches the loaded
 * hook; only a successful `POST /reload` does (spec §6.5, review MEDIUM-1).
 *
 * `POST /reload` re-loads the declared module via the unique-compiled-file
 * mechanism (`loadUpstreamHookSafe`, review B1 as amended: transpile → write a
 * unique file under `.hooks-cache/` → import — bypasses Bun's path-keyed ESM
 * cache while still resolving `~/` aliases, unlike the superseded data-URL
 * approach) and never throws: on failure the
 * previously-loaded hook stays effective and the error is reported at 200 with
 * `ok:false` — the project's "warn-continue" config philosophy (runtime
 * hot-reload never kills the process over a bad module).
 */

import {
  //
  createRoute,
  OpenAPIHono,
  z,
} from "@hono/zod-openapi"

import {
  //
  getUpstreamHookState,
  loadUpstreamHookSafe,
} from "~/lib/pipeline/hooks/loader"
import { state } from "~/lib/state"

export const hooksRoutes = new OpenAPIHono()

const HooksStateSchema = z
  .object({
    enabled: z.boolean().openapi({ description: "Declared config: hooks.enabled" }),
    declaredModule: z.string().nullable().openapi({ description: "Declared config: hooks.upstream_module (null if unset)" }),
    loadedModule: z.string().nullable().openapi({ description: "Module path of the currently EFFECTIVE (loaded) hook, if any" }),
    loadedAt: z.number().nullable().openapi({ description: "Epoch ms when the effective hook was loaded" }),
    version: z
      .string()
      .nullable()
      .openapi({ description: "`${loadedAt}-${seq}` — monotonically unique, changes on every successful reload (even within the same millisecond)" }),
    exports: z.array(z.string()).openapi({ description: 'Hook mount points exported by the effective module, e.g. ["exchange"]' }),
    lastReloadError: z.string().optional().openapi({ description: "Present only if the most recent reload attempt failed" }),
  })
  .openapi("HooksState")

const ReloadOkSchema = z
  .object({
    ok: z.literal(true),
    module: z.string(),
    exports: z.array(z.string()),
    version: z.string(),
  })
  .openapi("HooksReloadOk")

const ReloadFailSchema = z
  .object({
    ok: z.literal(false),
    module: z.string().optional(),
    error: z.string(),
  })
  .openapi("HooksReloadFail")

const getHooksStateRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["hooks"],
  summary: "Upstream-hook effective state (declared config + currently loaded module)",
  responses: {
    200: { description: "Declared + effective hook state", content: { "application/json": { schema: HooksStateSchema } } },
  },
})

const postReloadRoute = createRoute({
  method: "post",
  path: "/reload",
  tags: ["hooks"],
  summary: "Reload the declared upstream-hook module (unique compiled file, warn-continue)",
  description:
    "Re-loads `hooks.upstream_module` by transpiling it to a unique file under `.hooks-cache/` and importing that (bypasses Bun's path-keyed ESM cache while resolving `~/` aliases). On failure the previously-loaded hook is kept effective and the error is reported here at 200, not thrown.",
  responses: {
    200: {
      description: "Reload outcome — ok:true on success, ok:false (previous hook retained) on failure",
      content: { "application/json": { schema: z.union([ReloadOkSchema, ReloadFailSchema]) } },
    },
    400: { description: "hooks.upstream_module is not configured", content: { "application/json": { schema: ReloadFailSchema } } },
  },
})

hooksRoutes.openapi(getHooksStateRoute, (c) => {
  const st = getUpstreamHookState()
  return c.json(
    {
      enabled: state.hooksEnabled,
      declaredModule: state.hooksUpstreamModule || null,
      loadedModule: st?.module ?? null,
      loadedAt: st?.loadedAt ?? null,
      version: st?.version ?? null,
      exports: st?.exports ?? [],
      ...(st?.lastReloadError ? { lastReloadError: st.lastReloadError } : {}),
    },
    200,
  )
})

hooksRoutes.openapi(postReloadRoute, async (c) => {
  const modulePath = state.hooksUpstreamModule
  if (!modulePath) return c.json({ ok: false as const, error: "hooks.upstream_module not configured" }, 400)

  const res = await loadUpstreamHookSafe(modulePath)
  if (!res.ok) return c.json({ ok: false as const, module: modulePath, error: res.error }, 200)

  return c.json({ ok: true as const, module: res.state.module, exports: res.state.exports, version: res.state.version }, 200)
})
