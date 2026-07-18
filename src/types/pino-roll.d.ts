declare module "pino-roll" {
  import type { DestinationStream } from "pino"

  export interface PinoRollDestination extends DestinationStream {
    readonly fd: number
    readonly file: string
    readonly destroyed: boolean
    readonly writableEnded?: boolean
    write(data: string): boolean
    flush(callback?: (error?: Error | null) => void): void
    end(): void
    on(event: "ready" | "close" | "drain", listener: () => void): this
    on(event: "error", listener: (error: Error) => void): this
    on(event: "drop", listener: (data: string) => void): this
    on(event: "write", listener: (bytes: number) => void): this
    once(event: "ready" | "close" | "drain", listener: () => void): this
    once(event: "error", listener: (error: Error) => void): this
    removeListener(event: "ready" | "close" | "drain", listener: () => void): this
    removeListener(event: "error", listener: (error: Error) => void): this
  }

  export interface PinoRollOptions {
    file: string | (() => string)
    size?: string | number
    frequency?: "daily" | "hourly" | number
    extension?: string
    dateFormat?: string
    symlink?: boolean
    mkdir?: boolean
    mode?: number
    minLength?: number
    maxLength?: number
    maxWrite?: number
    sync?: boolean
  }

  export default function build(options: PinoRollOptions): Promise<PinoRollDestination>
}
