import type { DispatchHandle } from "~/lib/context/model-operation-record"
import type {
  GoawayFreezeResult,
  GoawaySnapshotSource,
} from "~/lib/transport/http2-observation-types"

export class SessionGoawayLedger {
  acquireDispatchLease(dispatch: DispatchHandle): GoawaySnapshotSource<null> & { readonly dispatch: DispatchHandle } {
    return Object.freeze({
      dispatch,
      freezeAtTerminal(): GoawayFreezeResult<null> {
        return {
          snapshot: {
            availability: "not-observed-before-snapshot",
            events: [],
            protocolViolation: { availability: "none" },
          },
          operationLease: null,
        }
      },
    })
  }
}
