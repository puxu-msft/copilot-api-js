import type { Writable } from "node:stream"

import { writeEmergencyFallback } from "~/lib/diagnostics/emergency-output"

/** Single never-throw owner for writes to the service terminal stream. */
export class OutputArbiter {
  private readonly stream: NodeJS.WritableStream
  private isFaulted = false
  private onFaultCallback: (() => void) | undefined
  private readonly onStreamFault = (): void => this.fault()

  constructor(stream: NodeJS.WritableStream) {
    this.stream = stream
    const writable = stream as Partial<Writable>
    writable.on?.("error", this.onStreamFault)
    writable.on?.("close", this.onStreamFault)
  }

  setOnFault(callback: () => void): void {
    this.onFaultCallback = callback
    if (this.isFaulted) callback()
  }

  write(data: string): boolean {
    const writable = this.stream as NodeJS.WritableStream & Partial<Writable>
    if (this.isFaulted || writable.destroyed || writable.writableEnded) {
      this.fault()
      return false
    }
    try {
      return writable.write(data)
    } catch {
      this.fault()
      return false
    }
  }

  get faulted(): boolean {
    return this.isFaulted
  }

  destroy(): void {
    const writable = this.stream as Partial<Writable>
    writable.removeListener?.("error", this.onStreamFault)
    writable.removeListener?.("close", this.onStreamFault)
  }

  private fault(): void {
    if (this.isFaulted) return
    this.isFaulted = true
    try {
      this.onFaultCallback?.()
    } catch {
      // Fault handling must not escape into the log producer.
    }
    writeEmergencyFallback("[terminal] output stream unavailable; terminal rendering disabled")
  }
}
