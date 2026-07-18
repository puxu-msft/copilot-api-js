import type { Writable } from "node:stream"

/**
 * Never-throw process diagnostic fallback. It owns stderr error/close handling so
 * a broken pipe cannot turn an attempt to report another sink failure into an
 * uncaught exception.
 */
export class EmergencyOutput {
  private readonly stream: Writable
  private faulted = false
  private silentFailures = 0
  private readonly onFault = (): void => {
    this.faulted = true
    this.silentFailures++
  }

  constructor(stream: Writable = process.stderr) {
    this.stream = stream
    stream.on("error", this.onFault)
    stream.on("close", this.onFault)
  }

  writeLine(line: string): boolean {
    if (this.faulted || this.stream.destroyed || this.stream.writableEnded) {
      this.silentFailures++
      return false
    }
    try {
      return this.stream.write(`${line}\n`)
    } catch {
      this.onFault()
      return false
    }
  }

  get failures(): number {
    return this.silentFailures
  }
}

const processEmergencyOutput = new EmergencyOutput()

export function writeEmergencyFallback(line: string): boolean {
  return processEmergencyOutput.writeLine(line)
}
