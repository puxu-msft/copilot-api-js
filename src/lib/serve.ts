/**
 * Cross-runtime HTTP server creation.
 *
 * Replaces srvx with direct @hono/node-server (Node.js) and Bun.serve() (Bun)
 * to give full control over server behavior and logging output.
 */

import type { Server as NodeHttpServer } from "node:http"

// ============================================================================
// Types
// ============================================================================

/** Minimal server interface shared with shutdown.ts */
export interface ServerInstance {
  /** Close the server. force=true terminates all active connections immediately. */
  close(force?: boolean): Promise<void>
  /** Node.js HTTP server instance (undefined under Bun). Used for WebSocket injection. */
  nodeServer?: NodeHttpServer
}

export interface StartServerOptions {
  /** Hono app's fetch handler */
  fetch: (request: Request, env?: Record<string, unknown>) => Response | Promise<Response>
  port: number
  hostname?: string
  /** hono/bun websocket handler object (Bun only) */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  bunWebSocket?: any
}

// ============================================================================
// Server creation
// ============================================================================

/** Start the HTTP server and return a ServerInstance. */
export async function startServer(options: StartServerOptions): Promise<ServerInstance> {
  if (typeof globalThis.Bun !== "undefined") {
    return startBunServer(options)
  }
  return startNodeServer(options)
}

// ============================================================================
// Node.js
// ============================================================================

async function startNodeServer(options: StartServerOptions): Promise<ServerInstance> {
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
      },
      () => {
        nodeServer.removeListener("error", reject)
        resolve()
      },
    )
  })

  return {
    nodeServer: nodeServer as NodeHttpServer,
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

async function startBunServer(options: StartServerOptions): Promise<ServerInstance> {
  // Bun.serve() passes the server instance as 2nd arg to fetch.
  // Forward it to Hono's env so hono/bun's upgradeWebSocket can call server.upgrade().
  const bunServer = Bun.serve({
    fetch(request: Request, server: unknown) {
      return options.fetch(request, { server })
    },
    port: options.port,
    hostname: options.hostname,
    idleTimeout: 255, // seconds (Bun max — default 10s is too short for LLM streaming)
    ...(options.bunWebSocket ? { websocket: options.bunWebSocket } : {}),
  })

  return {
    close(force?: boolean): Promise<void> {
      bunServer.stop(force ?? false)
      return Promise.resolve()
    },
  }
}
