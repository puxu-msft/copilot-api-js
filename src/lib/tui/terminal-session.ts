export interface TerminalCapabilities {
  interactive: boolean
  jobControl: boolean
  reason?: "disabled" | "non-tty" | "dumb" | "no-raw-mode" | "unsupported-platform"
}

export interface TerminalJobControl {
  platform: NodeJS.Platform
  pid: number
  on: (signal: "SIGTSTP" | "SIGCONT", listener: () => void) => void
  off: (signal: "SIGTSTP" | "SIGCONT", listener: () => void) => void
  kill: (pid: number, signal: "SIGTSTP") => unknown
}

export interface TerminalSessionOptions {
  stdin?: NodeJS.ReadStream
  interactive: boolean
  isTTY?: boolean
  term?: string
  onData: (chunk: Buffer) => void
  beforeRestore: () => void
  beforeSuspend?: () => void
  drainOutput?: () => Promise<void>
  onResume?: () => void
  registerExitHook: (fn: () => void) => unknown
  jobControl?: TerminalJobControl
}

type SessionState = "inactive" | "active" | "suspending" | "suspended" | "restored"

/** Owns raw/cooked input, exit-hook lifetime, and Unix foreground job control. */
export class TerminalSession {
  readonly capabilities: TerminalCapabilities
  private readonly stdin: NodeJS.ReadStream | undefined
  private readonly onData: (chunk: Buffer) => void
  private readonly beforeRestore: () => void
  private readonly beforeSuspend: () => void
  private readonly drainOutput: () => Promise<void>
  private readonly onResume: () => void
  private readonly jobs: TerminalJobControl
  private unregisterExitHook: (() => void) | undefined
  private state: SessionState
  private tstpInstalled = false
  private readonly handleTstp = (): void => {
    void this.suspend()
  }
  private readonly handleCont = (): void => this.resumeAfterContinue()

  constructor(options: TerminalSessionOptions) {
    this.stdin = options.stdin
    this.onData = options.onData
    this.beforeRestore = options.beforeRestore
    this.beforeSuspend = options.beforeSuspend ?? options.beforeRestore
    this.drainOutput = options.drainOutput ?? (() => Promise.resolve())
    this.onResume = options.onResume ?? (() => {})
    this.jobs = options.jobControl ?? {
      platform: process.platform,
      pid: process.pid,
      on: (signal, listener) => process.on(signal, listener),
      off: (signal, listener) => process.off(signal, listener),
      kill: (pid, signal) => sendSuspendSignal(pid, signal),
    }
    this.capabilities = detectCapabilities(options)
    this.state = this.capabilities.interactive ? "active" : "inactive"
    if (!this.capabilities.interactive || !this.stdin) return

    this.attachRawInput()
    this.installJobControl()
    const unregister = options.registerExitHook(() => this.restoreSyncBestEffort())
    if (typeof unregister === "function") this.unregisterExitHook = unregister as () => void
  }

  get interactive(): boolean {
    return this.capabilities.interactive
  }

  beginShutdownRestore(): void {
    this.restoreSyncBestEffort()
  }

  async suspend(): Promise<boolean> {
    if (!this.capabilities.jobControl || this.state !== "active" || !this.stdin) return false
    this.state = "suspending"
    try {
      this.beforeSuspend()
    } catch {
      /* cooked restoration must still proceed */
    }
    await this.drainOutput()
    this.detachInputAndCook()
    this.removeTstpListener()
    this.state = "suspended"
    try {
      await this.jobs.kill(this.jobs.pid, "SIGTSTP")
      return true
    } catch {
      this.installTstpListener()
      this.attachRawInput()
      this.state = "active"
      return false
    }
  }

  restoreSyncBestEffort(): void {
    if (!this.stdin || this.state === "restored" || this.state === "inactive") return
    this.state = "restored"
    try {
      this.beforeRestore()
    } catch {
      /* visual failure must not skip cooked mode */
    } finally {
      this.detachInputAndCook()
      this.removeJobControl()
      this.unregisterExitHook?.()
      this.unregisterExitHook = undefined
    }
  }

  private attachRawInput(): void {
    if (!this.stdin) return
    this.stdin.setRawMode(true)
    this.stdin.resume()
    this.stdin.on("data", this.onData)
  }

  private detachInputAndCook(): void {
    if (!this.stdin) return
    this.stdin.removeListener("data", this.onData)
    this.stdin.pause()
    try {
      this.stdin.setRawMode(false)
    } catch {
      /* terminal may already be unavailable */
    }
  }

  private installJobControl(): void {
    if (!this.capabilities.jobControl) return
    this.installTstpListener()
    this.jobs.on("SIGCONT", this.handleCont)
  }

  private installTstpListener(): void {
    if (this.tstpInstalled) return
    this.jobs.on("SIGTSTP", this.handleTstp)
    this.tstpInstalled = true
  }

  private removeTstpListener(): void {
    if (!this.tstpInstalled) return
    this.jobs.off("SIGTSTP", this.handleTstp)
    this.tstpInstalled = false
  }

  private removeJobControl(): void {
    if (!this.capabilities.jobControl) return
    this.removeTstpListener()
    this.jobs.off("SIGCONT", this.handleCont)
  }

  private resumeAfterContinue(): void {
    if (this.state !== "suspended") return
    this.installTstpListener()
    this.attachRawInput()
    this.state = "active"
    try {
      this.onResume()
    } catch {
      /* resume repaint is best effort */
    }
  }
}

function detectCapabilities(options: TerminalSessionOptions): TerminalCapabilities {
  if (!options.interactive) return { interactive: false, jobControl: false, reason: "disabled" }
  if (options.isTTY === false || !options.stdin) return { interactive: false, jobControl: false, reason: "non-tty" }
  if ((options.term ?? process.env.TERM) === "dumb") return { interactive: false, jobControl: false, reason: "dumb" }
  if (typeof options.stdin.setRawMode !== "function") return { interactive: false, jobControl: false, reason: "no-raw-mode" }
  const platform = options.jobControl?.platform ?? process.platform
  return { interactive: true, jobControl: platform !== "win32", reason: platform === "win32" ? "unsupported-platform" : undefined }
}

async function sendSuspendSignal(pid: number, signal: "SIGTSTP"): Promise<void> {
  if (typeof Bun !== "undefined") {
    // Bun 1.3 process.kill(self, SIGTSTP) returns without stopping. Calling libc
    // directly preserves real POSIX job-control semantics; execution resumes
    // inside this call only after the parent/shell sends SIGCONT.
    const { dlopen, FFIType } = await import("bun:ffi")
    const libc = dlopen("libc.so.6", {
      signal: { args: [FFIType.i32, FFIType.ptr], returns: FFIType.ptr },
      getpgrp: { args: [], returns: FFIType.i32 },
      kill: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
    })
    try {
      // Bun retains its native signal trampoline after process.off(); reset the
      // disposition to SIG_DFL so SIGTSTP performs a real job-control stop.
      libc.symbols.signal(20, null)
      // Bun executes scripts in a worker child beneath its CLI launcher. Real
      // shell job control stops the whole foreground process group, not one PID.
      const result = libc.symbols.kill(-libc.symbols.getpgrp(), 20)
      if (result !== 0) throw new Error(`failed to send ${signal}`)
    } finally {
      libc.close()
    }
    return
  }
  process.kill(pid, signal)
}
