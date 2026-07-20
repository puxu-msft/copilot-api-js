const responseSessions = new Map<string, string>()

export function registerResponseSession(responseId: string | null | undefined, sessionId: string | undefined): void {
  if (!responseId || !sessionId) return
  responseSessions.set(responseId, sessionId)
}

export function resolveResponseSessionId(previousResponseId: string | null | undefined): string | undefined {
  if (!previousResponseId) return undefined
  return responseSessions.get(previousResponseId)
}

export function resetResponseSessionStoreForTests(): void {
  responseSessions.clear()
}
