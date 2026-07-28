import { cacheModels } from "~/lib/models/cache"
import { state } from "~/lib/state"

/** Ensure the models cache is populated, fetching if needed. */
export async function ensureModels() {
  if (!state.models) {
    await cacheModels()
  }
}
