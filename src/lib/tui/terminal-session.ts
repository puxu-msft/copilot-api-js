export interface TerminalSessionOptions {
  stdin?: NodeJS.ReadStream
  interactive: boolean
  onData: (chunk: Buffer) => void
  beforeRestore: () => void
  registerExitHook: (fn: () => void) => void
}

/** Owns raw/cooked stdin lifecycle independently from rendering and request state. */
export class TerminalSession {
  private readonly stdin: NodeJS.ReadStream | undefined
  private readonly onData: (chunk: Buffer) => void
  private readonly beforeRestore: () => void
  private restored = false

  constructor(options: TerminalSessionOptions) {
    this.stdin = options.interactive ? options.stdin : undefined
    this.onData = options.onData
    this.beforeRestore = options.beforeRestore
    if (!this.stdin) return
    this.stdin.setRawMode(true)
    this.stdin.resume()
    this.stdin.on("data", this.onData)
    options.registerExitHook(() => this.restoreSyncBestEffort())
  }

  restoreSyncBestEffort(): void {
    if (!this.stdin || this.restored) return
    this.restored = true
    try {
      this.beforeRestore()
    } catch {
      // Visual restore failure must not skip cooked-mode restoration.
    } finally {
      this.stdin.removeListener("data", this.onData)
      this.stdin.pause()
      try {
        this.stdin.setRawMode(false)
      } catch {
        // A closing terminal may already be unavailable.
      }
    }
  }
}
