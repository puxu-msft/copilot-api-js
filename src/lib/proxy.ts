import consola from "consola"
import { getProxyForUrl } from "proxy-from-env"
import { Agent, ProxyAgent, setGlobalDispatcher, type Dispatcher } from "undici"

/**
 * Custom dispatcher that routes requests through proxies based on environment variables.
 * Extends Agent to properly inherit the Dispatcher interface.
 */
class ProxyDispatcher extends Agent {
  private proxies = new Map<string, ProxyAgent>()

  dispatch(
    options: Dispatcher.DispatchOptions,
    handler: Dispatcher.DispatchHandler,
  ): boolean {
    try {
      const origin = this.getOriginUrl(options.origin)
      const proxyUrl = this.getProxyUrl(origin)

      if (!proxyUrl) {
        consola.debug(`HTTP proxy bypass: ${origin.hostname}`)
        return super.dispatch(options, handler)
      }

      const agent = this.getOrCreateProxyAgent(proxyUrl)
      consola.debug(
        `HTTP proxy route: ${origin.hostname} via ${this.formatProxyLabel(proxyUrl)}`,
      )
      return agent.dispatch(options, handler)
    } catch {
      return super.dispatch(options, handler)
    }
  }

  private getOriginUrl(origin: Dispatcher.DispatchOptions["origin"]): URL {
    return typeof origin === "string" ? new URL(origin) : (origin as URL)
  }

  private getProxyUrl(origin: URL): string | undefined {
    const raw = getProxyForUrl(origin.toString())
    return raw && raw.length > 0 ? raw : undefined
  }

  private getOrCreateProxyAgent(proxyUrl: string): ProxyAgent {
    let agent = this.proxies.get(proxyUrl)
    if (!agent) {
      agent = new ProxyAgent(proxyUrl)
      this.proxies.set(proxyUrl, agent)
    }
    return agent
  }

  private formatProxyLabel(proxyUrl: string): string {
    try {
      const u = new URL(proxyUrl)
      return `${u.protocol}//${u.host}`
    } catch {
      return proxyUrl
    }
  }

  override async close(): Promise<void> {
    await super.close()
    await Promise.all([...this.proxies.values()].map((p) => p.close()))
    this.proxies.clear()
  }

  override destroy(err?: Error | null): Promise<void>
  override destroy(callback: () => void): void
  override destroy(err: Error | null, callback: () => void): void
  override destroy(
    errOrCallback?: Error | null | (() => void),
    callback?: () => void,
  ): Promise<void> | void {
    // Clean up proxy agents (fire-and-forget, errors are ignored)
    for (const agent of this.proxies.values()) {
      if (typeof errOrCallback === "function") {
        agent.destroy(errOrCallback)
      } else if (callback) {
        agent.destroy(errOrCallback ?? null, callback)
      } else {
        agent.destroy(errOrCallback ?? null).catch(() => {
          // Ignore cleanup errors
        })
      }
    }
    this.proxies.clear()

    // Call super with appropriate overload
    if (typeof errOrCallback === "function") {
      super.destroy(errOrCallback)
      return
    } else if (callback) {
      super.destroy(errOrCallback ?? null, callback)
      return
    } else {
      return super.destroy(errOrCallback ?? null)
    }
  }
}

export function initProxyFromEnv(): void {
  if (typeof Bun !== "undefined") return

  try {
    const dispatcher = new ProxyDispatcher()
    setGlobalDispatcher(dispatcher)
    consola.debug("HTTP proxy configured from environment (per-URL)")
  } catch (err) {
    consola.debug("Proxy setup skipped:", err)
  }
}
