// Fixture: a valid hook module exporting one mount point (exchange) via `export const hooks`.
export const hooks = {
  exchange: async (_wire: unknown, _env: unknown, next: () => Promise<unknown>): Promise<unknown> => next(),
}
