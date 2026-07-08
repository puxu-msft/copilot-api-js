/** 反应式学习记录（feature-negotiation 缓存）的查看 / 编辑管理 API。 */
import {
  //
  createRoute,
  OpenAPIHono,
  z,
} from "@hono/zod-openapi"

import {
  //
  deleteEntry,
  expireEntry,
  exportAll,
  getGroupedSnapshot,
  renewEntry,
  setPinned,
} from "~/lib/anthropic/feature-negotiation"
import {
  //
  type NegotiationCategory,
  NEGOTIATION_CATEGORIES,
} from "~/lib/anthropic/negotiation-lifecycle"

export const negotiationRoutes = new OpenAPIHono()

const AnyJson = z.record(z.string(), z.unknown())
const ErrorSchema = z.object({ error: z.string() }).openapi("NegotiationError")
// H2: keep the NegotiationCategory union (don't degrade to string, else passing it to a mutator is TS2345).
const CategoryEnum = z.enum(NEGOTIATION_CATEGORIES as unknown as readonly [NegotiationCategory, ...Array<NegotiationCategory>])
const EntryRefSchema = z.object({ category: CategoryEnum, key: z.string(), value: z.string() }).strict()
const PinSchema = EntryRefSchema.extend({ pinned: z.boolean() })

const getRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["negotiation"],
  summary: "Grouped snapshot of reactive learning records",
  responses: { 200: { description: "snapshot", content: { "application/json": { schema: AnyJson } } } },
})
negotiationRoutes.openapi(getRoute, (c) => c.json(getGroupedSnapshot()))

function refRoute(path: string, summary: string) {
  return createRoute({
    method: "post",
    path,
    tags: ["negotiation"],
    summary,
    responses: {
      200: { description: "ok", content: { "application/json": { schema: AnyJson } } },
      400: { description: "bad request", content: { "application/json": { schema: ErrorSchema } } },
      404: { description: "not found", content: { "application/json": { schema: ErrorSchema } } },
    },
  })
}

// Each handler parses its body inline (mirrors debug/route.ts) to avoid a brittle
// Context generic annotation on an extracted helper (the `.openapi` overloads make
// `Parameters<>`-derived Context types unreliable — M3).
negotiationRoutes.openapi(refRoute("/renew", "Renew (extend expiry) an entry"), async (c) => {
  let raw: unknown
  try {
    raw = await c.req.json()
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400)
  }
  const p = EntryRefSchema.safeParse(raw)
  if (!p.success) return c.json({ error: "Invalid request" }, 400)
  const entry = renewEntry(p.data.category, p.data.key, p.data.value)
  if (!entry) return c.json({ error: "entry not found" }, 404)
  return c.json({ ok: true, entry }, 200)
})

negotiationRoutes.openapi(refRoute("/expire", "Expire now (keep row)"), async (c) => {
  let raw: unknown
  try {
    raw = await c.req.json()
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400)
  }
  const p = EntryRefSchema.safeParse(raw)
  if (!p.success) return c.json({ error: "Invalid request" }, 400)
  const entry = expireEntry(p.data.category, p.data.key, p.data.value)
  if (!entry) return c.json({ error: "entry not found" }, 404)
  return c.json({ ok: true, entry }, 200)
})

negotiationRoutes.openapi(refRoute("/pin", "Pin/unpin (never expire)"), async (c) => {
  let raw: unknown
  try {
    raw = await c.req.json()
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400)
  }
  const p = PinSchema.safeParse(raw)
  if (!p.success) return c.json({ error: "Invalid request" }, 400)
  const entry = setPinned(p.data.category, p.data.key, p.data.value, p.data.pinned)
  if (!entry) return c.json({ error: "entry not found" }, 404)
  return c.json({ ok: true, entry }, 200)
})

negotiationRoutes.openapi(refRoute("/entry/delete", "Delete an entry"), async (c) => {
  let raw: unknown
  try {
    raw = await c.req.json()
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400)
  }
  const p = EntryRefSchema.safeParse(raw)
  if (!p.success) return c.json({ error: "Invalid request" }, 400)
  const ok = deleteEntry(p.data.category, p.data.key, p.data.value)
  if (!ok) return c.json({ error: "entry not found" }, 404)
  return c.json({ ok: true }, 200)
})

const exportRoute = createRoute({
  method: "get",
  path: "/export",
  tags: ["negotiation"],
  summary: "Export full v2 negotiation dataset (JSON attachment)",
  responses: { 200: { description: "v2 dataset", content: { "application/json": { schema: AnyJson } } } },
})
negotiationRoutes.openapi(exportRoute, (c) => {
  c.header("Content-Disposition", 'attachment; filename="negotiation-states.json"')
  return c.json(exportAll())
})
