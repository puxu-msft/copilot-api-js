// Fixture: a valid hook module exporting one mount point (onExchange).
export const onExchange = async (_wire: unknown, _env: unknown, next: () => Promise<unknown>): Promise<unknown> => next()
