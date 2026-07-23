export interface SensitiveOutputPort {
  isInteractive: () => boolean
  write: (text: string) => boolean
}

let activePort: SensitiveOutputPort | undefined
const emittedKeys = new Set<string>()

/** Register the current command's direct sensitive-output owner. */
export function registerSensitiveOutput(port: SensitiveOutputPort): () => void {
  activePort = port
  return () => {
    if (activePort === port) activePort = undefined
  }
}

/**
 * Write a credential exactly once to a healthy interactive terminal. This path
 * deliberately bypasses consola, the observability bus, file logs and replay.
 */
export function writeSensitiveOnce(key: string, label: string, value: string): boolean {
  if (emittedKeys.has(key)) return false
  const port = activePort
  if (!port?.isInteractive()) return false
  let written: boolean
  try {
    written = port.write(`${label}: ${value}\n`)
  } catch {
    written = false
  }
  if (written) emittedKeys.add(key)
  return written
}

export function resetSensitiveOutputForTests(): void {
  activePort = undefined
  emittedKeys.clear()
}
