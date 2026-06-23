import type { Context } from "hono"

import { Hono } from "hono"
import { existsSync } from "node:fs"
import {
  //
  access,
  constants,
  readFile,
} from "node:fs/promises"
import {
  //
  join,
  resolve,
} from "node:path"

import { getMimeType } from "../history/assets"

export interface UiRoutesOptions {
  externalUiUrl?: string
  /** Mount prefix, default "/ui". ui-v4 passes "/ui-v4". */
  mountPrefix?: string
  /** dist subdir under the workspace, default "ui". ui-v4 passes "ui-v4". */
  uiWorkspace?: string
}

const TEXT_RESPONSE_TYPES = ["text/html", "text/css", "text/javascript", "application/javascript", "application/x-javascript"]
const JAVASCRIPT_RESPONSE_TYPES = ["text/javascript", "application/javascript", "application/x-javascript"]
const VITE_DEV_PATH_PREFIXES = ["/@vite", "/@fs/", "/@id/", "/src/", "/node_modules/", "/__vite_ping", "/__open-in-editor", "/vite.svg"]

/**
 * Resolve a UI directory that exists at runtime.
 * In dev mode this file lives at src/routes/ui/ — 3 levels below project root.
 * In bundled mode (dist/main.mjs) — 1 level below project root.
 */
function resolveUiDir(workspace: string, subpath: string): string {
  const candidates = [join(import.meta.dirname, "../../..", workspace, subpath), join(import.meta.dirname, "..", workspace, subpath)]
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]
}

function stripTrailingSlash(pathname: string): string {
  return pathname !== "/" ? pathname.replace(/\/+$/, "") : pathname
}

/**
 * Translate a path observed at the external base (e.g. `/proxy/ui/foo`) back
 * to a local UI-relative path (`/foo`). Splits the previous nested ternary
 * into named branches for readability.
 */
function computeLocalPathname(externalBasePath: string, resolvedPathname: string): string {
  if (externalBasePath === "/") return resolvedPathname
  const isWithinBase = resolvedPathname.startsWith(`${externalBasePath}/`) || resolvedPathname === externalBasePath
  if (!isWithinBase) return resolvedPathname
  return resolvedPathname.slice(externalBasePath.length) || "/"
}

function escapeRegExp(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)
}

function joinUrlPath(basePathname: string, requestPathname: string): string {
  const normalizedBase = stripTrailingSlash(basePathname)
  const normalizedRequest = requestPathname.startsWith("/") ? requestPathname : `/${requestPathname}`

  if (normalizedBase === "/") {
    return normalizedRequest
  }
  return `${normalizedBase}${normalizedRequest}`
}

function stripUiMountPrefix(pathname: string, mountPrefix: string): string {
  if (pathname === mountPrefix) {
    return "/"
  }
  if (pathname.startsWith(`${mountPrefix}/`)) {
    return pathname.slice(mountPrefix.length)
  }
  return pathname
}

function isTextResponse(contentType: string | null): boolean {
  return TEXT_RESPONSE_TYPES.some((value) => contentType?.includes(value))
}

function isJavaScriptResponse(contentType: string | null): boolean {
  return JAVASCRIPT_RESPONSE_TYPES.some((value) => contentType?.includes(value))
}

function rewriteBaseUrlLiteral(content: string, mountPrefix: string): string {
  return content.replaceAll(/("BASE_URL"\s*:\s*")\/(")/g, `$1${mountPrefix}/$2`)
}

function rewriteQuotedPathPrefixes(content: string, fromPrefix: string, toPrefix: string): string {
  const quotePattern = new RegExp(`(["'\`])${escapeRegExp(fromPrefix)}`, "g")
  return content.replace(quotePattern, `$1${toPrefix}`)
}

function rewriteParenthesizedPathPrefixes(content: string, fromPrefix: string, toPrefix: string): string {
  const parenthesizedPattern = new RegExp(`(\\()${escapeRegExp(fromPrefix)}`, "g")
  return content.replace(parenthesizedPattern, `$1${toPrefix}`)
}

function rewriteProxyTextResponse(content: string, externalUiUrl: string, contentType: string | null, mountPrefix: string): string {
  const externalBase = new URL(externalUiUrl)
  const externalBasePath = stripTrailingSlash(externalBase.pathname)
  const rewrittenBase = rewriteBaseUrlLiteral(content, mountPrefix)
  const rewriteBareParenthesizedPaths = !isJavaScriptResponse(contentType)

  return VITE_DEV_PATH_PREFIXES.reduce((current, vitePathPrefix) => {
    const externalPathPrefix = externalBasePath === "/" ? vitePathPrefix : `${externalBasePath}${vitePathPrefix}`
    const localPathPrefix = `${mountPrefix}${vitePathPrefix}`
    const absoluteExternalPrefix = `${externalBase.origin}${externalPathPrefix}`
    const rewrittenQuotedAbsolute = rewriteQuotedPathPrefixes(current, absoluteExternalPrefix, localPathPrefix)
    const rewrittenQuotedRelative = rewriteQuotedPathPrefixes(rewrittenQuotedAbsolute, externalPathPrefix, localPathPrefix)

    if (!rewriteBareParenthesizedPaths) {
      return rewrittenQuotedRelative
    }

    const rewrittenParenthesizedAbsolute = rewriteParenthesizedPathPrefixes(rewrittenQuotedRelative, absoluteExternalPrefix, localPathPrefix)
    return rewriteParenthesizedPathPrefixes(rewrittenParenthesizedAbsolute, externalPathPrefix, localPathPrefix)
  }, rewrittenBase)
}

function rewriteLocationHeader(location: string, externalUiUrl: string, mountPrefix: string): string {
  const externalBase = new URL(externalUiUrl)
  const resolvedLocation = new URL(location, externalBase)
  const isSameOrigin = resolvedLocation.origin === externalBase.origin

  if (!isSameOrigin) {
    return location
  }

  const externalBasePath = stripTrailingSlash(externalBase.pathname)
  const localPathname = computeLocalPathname(externalBasePath, resolvedLocation.pathname)

  return `${mountPrefix}${localPathname}${resolvedLocation.search}${resolvedLocation.hash}`
}

export function normalizeExternalUiUrl(externalUiUrl: string): string {
  const url = new URL(externalUiUrl)

  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error(`Unsupported external UI URL protocol: ${url.protocol}. Use http:// or https://`)
  }
  if (url.search || url.hash) {
    throw new Error("--external-ui-url must not include query parameters or hash fragments")
  }

  const normalizedPathname = stripTrailingSlash(url.pathname)
  return `${url.origin}${normalizedPathname === "/" ? "" : normalizedPathname}`
}

async function serveIndexHtml(c: Context, uiDir: string) {
  try {
    await access(join(uiDir, "index.html"), constants.R_OK)
    const content = await readFile(join(uiDir, "index.html"), "utf8")
    return c.html(content)
  } catch {
    return c.notFound()
  }
}

async function serveStaticAsset(c: Context, uiDir: string) {
  const assetsIdx = c.req.path.indexOf("/assets/")
  if (assetsIdx === -1) return c.notFound()

  const filePath = c.req.path.slice(assetsIdx)
  const fullPath = resolve(join(uiDir, filePath))
  if (!fullPath.startsWith(uiDir)) return c.notFound()

  try {
    await access(fullPath, constants.R_OK)
    const content = await readFile(fullPath)
    return new Response(content, {
      headers: {
        "Content-Type": getMimeType(filePath),
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    })
  } catch {
    return c.notFound()
  }
}

async function proxyExternalUiRequest(c: Context, externalUiUrl: string, mountPrefix: string) {
  const requestUrl = new URL(c.req.url)
  const externalBase = new URL(externalUiUrl)
  const upstreamUrl = new URL(externalBase)
  upstreamUrl.pathname = joinUrlPath(externalBase.pathname, stripUiMountPrefix(c.req.path, mountPrefix))
  upstreamUrl.search = requestUrl.search

  const requestHeaders = new Headers(c.req.raw.headers)
  requestHeaders.set("host", upstreamUrl.host)
  requestHeaders.set("x-forwarded-host", requestUrl.host)
  requestHeaders.set("x-forwarded-proto", requestUrl.protocol.replace(":", ""))

  const body = c.req.method === "GET" || c.req.method === "HEAD" ? undefined : await c.req.raw.arrayBuffer()
  const upstreamResponse = await fetch(upstreamUrl, {
    method: c.req.method,
    headers: requestHeaders,
    body,
    redirect: "manual",
  })

  const responseHeaders = new Headers(upstreamResponse.headers)
  const location = responseHeaders.get("location")
  if (location) {
    responseHeaders.set("location", rewriteLocationHeader(location, externalUiUrl, mountPrefix))
  }

  if (isTextResponse(responseHeaders.get("content-type"))) {
    const content = await upstreamResponse.text()
    const contentType = responseHeaders.get("content-type")
    const rewritten = rewriteProxyTextResponse(content, externalUiUrl, contentType, mountPrefix)
    responseHeaders.delete("content-length")
    return new Response(rewritten, {
      status: upstreamResponse.status,
      statusText: upstreamResponse.statusText,
      headers: responseHeaders,
    })
  }

  return new Response(upstreamResponse.body, {
    status: upstreamResponse.status,
    statusText: upstreamResponse.statusText,
    headers: responseHeaders,
  })
}

export function createUiRoutes(options: UiRoutesOptions = {}): Hono {
  const uiRoutes = new Hono()
  const mountPrefix = options.mountPrefix ?? "/ui"
  const uiDir = resolveUiDir(options.uiWorkspace ?? "ui", "dist")

  if (options.externalUiUrl) {
    const normalizedExternalUiUrl = normalizeExternalUiUrl(options.externalUiUrl)
    uiRoutes.all("/", (c) => proxyExternalUiRequest(c, normalizedExternalUiUrl, mountPrefix))
    uiRoutes.all("/*", (c) => proxyExternalUiRequest(c, normalizedExternalUiUrl, mountPrefix))
    return uiRoutes
  }

  uiRoutes.get("/", (c) => serveIndexHtml(c, uiDir))
  uiRoutes.get("/assets/*", (c) => serveStaticAsset(c, uiDir))
  return uiRoutes
}
