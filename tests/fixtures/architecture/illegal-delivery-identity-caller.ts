import type { ClientSink } from "~/lib/pipeline/types"

import { inheritDownstreamDeliverySession as inheritIdentity } from "~/lib/pipeline/delivery/session"

export function illegalDeliveryIdentityCaller(source: ClientSink, decorator: ClientSink): void {
  const renamedAgain = inheritIdentity
  renamedAgain(source, decorator, { transparency: "write-pass-through" })
}
