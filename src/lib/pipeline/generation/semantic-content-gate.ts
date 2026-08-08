/** Whether this client delivery has already emitted real semantic content. */
export function hasDeliveredSemanticContent(session: { hasEmittedRealClientContent: boolean } | undefined): boolean {
  return session?.hasEmittedRealClientContent === true
}
