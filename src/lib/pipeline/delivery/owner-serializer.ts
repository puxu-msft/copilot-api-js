/**
 * The generation owner's single serializer.
 *
 * Every client-visible emission for one generation goes through one queue, so "what order did the
 * client see" has exactly one answer. That is the whole point: the defects this RFC fixes are
 * states where wire order and owner state disagreed because two writers each had their own idea of
 * ordering.
 *
 * **Non-reentrant on purpose.** A command that calls {@link OwnerSerializer.run} from inside
 * another command would wait for a queue it is itself blocking. We do not paper over that with a
 * reentrant lock — that hides the bug instead of fixing it. Compound commands use
 * {@link OwnerSerializer.runInternal}, which runs inline and never touches the queue.
 *
 * **Why the "am I inside a command" test is not a boolean.** A counter cannot tell a genuine
 * nested call apart from an unrelated caller (a heartbeat timer) that happens to fire while a
 * command is awaiting — both see the flag set. `AsyncLocalStorage` gets the async context right,
 * but on its own it is also wrong here: a `setTimeout` armed INSIDE a command inherits the store
 * and still sees it after that command finished (measured in Bun 1.3.14). So the store carries a
 * token the serializer retires on completion, and "inside" means store present AND token live.
 *
 * Not wired into any production root — the owner that uses it is published in Commit 4.
 */

import { AsyncLocalStorage } from "node:async_hooks"

interface CommandContext {
  /** Flipped when the command settles. A deferred callback armed inside it inherits the store but sees this false. */
  live: boolean
}

export class OwnerSerializerReentrancyError extends Error {
  constructor() {
    super("[owner-serializer] a command tried to enqueue another command; compound steps must use runInternal")
    this.name = "OwnerSerializerReentrancyError"
  }
}

export interface OwnerSerializer {
  /** True only inside a running command's own async context. */
  readonly inCommand: boolean
  /** The public entry every command uses. Throws {@link OwnerSerializerReentrancyError} if called from inside a command. */
  run<T>(operation: () => Promise<T> | T): Promise<T>
  /**
   * A step of a compound command. Runs INLINE — no queue, no second ordering point — so a compound
   * command holds the queue for its whole duration and no other command can interleave between its
   * halves. That is what makes `close anchor → start real block` atomic on the wire.
   *
   * Throws if called outside a command: an internal primitive that runs unserialized is a second
   * writer, which is the class of bug this module exists to remove.
   */
  runInternal<T>(operation: () => Promise<T> | T): Promise<T>
}

export function createOwnerSerializer(): OwnerSerializer {
  const storage = new AsyncLocalStorage<CommandContext>()
  let chain: Promise<unknown> = Promise.resolve()

  const inCommand = (): boolean => storage.getStore()?.live === true

  return {
    get inCommand() {
      return inCommand()
    },

    run(operation) {
      if (inCommand()) throw new OwnerSerializerReentrancyError()
      const next = chain.then(async () => {
        const context: CommandContext = { live: true }
        try {
          return await storage.run(context, async () => operation())
        } finally {
          context.live = false
        }
      })
      // Later commands stay runnable after one rejection, and each caller still gets its own real
      // result or error — the queue orders work, it does not decide whether work succeeded.
      chain = next.catch(() => undefined)
      return next
    },

    async runInternal(operation) {
      if (!inCommand()) throw new Error("[owner-serializer] runInternal called outside a command")
      return await operation()
    },
  }
}
