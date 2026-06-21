/**
 * Cross-runtime HTTP server creation.
 *
 * Replaces srvx with direct @hono/node-server (Node.js) and Bun.serve() (Bun)
 * to give full control over server behavior and logging output.
 */

import type { Server as NodeHttpServer } from "node:http"

import consola from "consola"

// ============================================================================
// Types
// ============================================================================

/** Minimal server interface shared with shutdown.ts */
export interface ServerInstance {
  /** Close the server(s). force=true terminates all active connections immediately. */
  close(force?: boolean): Promise<void>
  /** Node.js HTTP server instances (empty under Bun). Used for WebSocket injection. */
  nodeServers?: Array<NodeHttpServer>
}

export interface StartServerOptions {
  /** Hono app's fetch handler */
  fetch: (request: Request, env?: Record<string, unknown>) => Response | Promise<Response>
  port: number
  /**
   * Hostnames to bind. When more than one address is provided, each is bound
   * independently and failures on any single address are logged as warnings
   * (as long as at least one succeeds).
   */
  hostnames?: Array<string>
  /** hono/bun websocket handler object (Bun only) */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  bunWebSocket?: any
}

// ============================================================================
// Server creation
// ============================================================================

/** Start the HTTP server(s) and return a composite ServerInstance. */
export async function startServer(options: StartServerOptions): Promise<ServerInstance> {
  const isBun = typeof globalThis.Bun !== "undefined"
  const startOne = (hostname: string | undefined): Promise<ServerInstance> =>
    isBun ? startBunServer({ ...options, hostname }) : startNodeServer({ ...options, hostname, ipv6Only: needsIpv6Only(hostname, options.hostnames ?? []) })
  return startServerMulti(options.hostnames, startOne)
}

/**
 * Aggregate multiple bind attempts into a single composite ServerInstance.
 *
 * - Tries each hostname via `startOne` in sequence.
 * - At least one success is required; otherwise rethrows the first failure.
 * - Per-host failures are logged as warnings when at least one bind succeeds.
 *
 * Exported for testing.
 */
export async function startServerMulti(
  hostnames: Array<string> | undefined,
  startOne: (hostname: string | undefined) => Promise<ServerInstance>,
): Promise<ServerInstance> {
  const hosts = hostnames && hostnames.length > 0 ? hostnames : [undefined as unknown as string]
  const instances: Array<ServerInstance> = []
  const errors: Array<{ host: string | undefined; error: unknown }> = []

  for (const hostname of hosts) {
    try {
      instances.push(await startOne(hostname))
    } catch (error) {
      errors.push({ host: hostname, error })
    }
  }

  if (instances.length === 0) {
    const first = errors[0]?.error
    if (first instanceof Error) throw first
    if (first === undefined) throw new Error("No hostnames bound")
    throw new Error(typeof first === "string" ? first : JSON.stringify(first))
  }

  for (const { host, error } of errors) {
    consola.warn(`Failed to bind ${host ?? "(default)"}: ${error instanceof Error ? error.message : String(error)}`)
  }

  return {
    nodeServers: instances.flatMap((i) => i.nodeServers ?? []),
    async close(force?: boolean): Promise<void> {
      await Promise.all(instances.map((i) => i.close(force)))
    },
  }
}

/**
 * Returns true if this hostname needs ipv6Only to avoid conflicting with a sibling IPv4 bind.
 * Exported for testing.
 */
export function needsIpv6Only(hostname: string | undefined, all: Array<string>): boolean {
  if (hostname !== "::") return false
  return all.includes("0.0.0.0")
}

// ============================================================================
// Node.js
// ============================================================================

interface NodeStartOptions extends Omit<StartServerOptions, "hostnames"> {
  hostname?: string
  ipv6Only?: boolean
}

async function startNodeServer(options: NodeStartOptions): Promise<ServerInstance> {
  const { createAdaptorServer } = await import("@hono/node-server")

  const nodeServer = createAdaptorServer({ fetch: options.fetch })

  // Manual listen for full control over options (reusePort via exclusive: false)
  await new Promise<void>((resolve, reject) => {
    nodeServer.once("error", reject)
    nodeServer.listen(
      {
        port: options.port,
        host: options.hostname,
        exclusive: false,
        ipv6Only: options.ipv6Only,
      },
      () => {
        nodeServer.removeListener("error", reject)
        resolve()
      },
    )
  })

  return {
    nodeServers: [nodeServer as NodeHttpServer],
    close(force?: boolean): Promise<void> {
      return new Promise((resolve, reject) => {
        if (force && "closeAllConnections" in nodeServer) {
          ;(nodeServer as NodeHttpServer).closeAllConnections()
        }
        nodeServer.close((err) => (err ? reject(err) : resolve()))
      })
    },
  }
}

// ============================================================================
// Bun
// ============================================================================

interface BunStartOptions extends Omit<StartServerOptions, "hostnames"> {
  hostname?: string
}

async function startBunServer(options: BunStartOptions): Promise<ServerInstance> {
  // Bun.serve() passes the server instance as 2nd arg to fetch.
  // Forward it to Hono's env so hono/bun's upgradeWebSocket can call server.upgrade().
  const bunServer = Bun.serve({
    fetch(request: Request, server: unknown) {
      return options.fetch(request, { server })
    },
    port: options.port,
    hostname: options.hostname,
    idleTimeout: 255, // seconds (Bun max — default 10s is too short for LLM streaming)
    // The proxy must not self-limit client input size. Bun.serve defaults
    // maxRequestBodySize to 128 MiB; the Node path (@hono/node-server → node:http)
    // has no body-size limit, so we lift Bun's cap to keep both runtimes
    // unbounded and consistent. Bound payload size at the deployment edge instead.
    maxRequestBodySize: Number.MAX_SAFE_INTEGER,
    ...(options.bunWebSocket ? { websocket: options.bunWebSocket } : {}),
  })

  return {
    close(force?: boolean): Promise<void> {
      // bunServer.stop returns a Promise; we expose a sync-style close()
      // so we explicitly discard the inner promise. Any teardown errors
      // surface via Bun's process-level error handling rather than here.
      void bunServer.stop(force ?? false)
      return Promise.resolve()
    },
  }
}
