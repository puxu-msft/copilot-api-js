/** A single-writer Promise queue used by every downstream delivery operation. */
export interface DeliverySerializer {
  enqueue<T>(operation: () => T | Promise<T>): Promise<T>
}

/**
 * Create a queue that preserves submission order while keeping later operations runnable after one
 * rejection. The returned promise retains each operation's real result/error.
 */
export function createDeliverySerializer(): DeliverySerializer {
  let chain: Promise<unknown> = Promise.resolve()
  return {
    enqueue(operation) {
      const next = chain.then(operation)
      chain = next.catch(() => undefined)
      return next
    },
  }
}
