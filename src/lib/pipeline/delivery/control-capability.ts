import type { DeliveryControlCapability } from "./protocol"

class RuntimeDeliveryControlCapability {
  readonly controlKind: "keepalive" | "protocol-ping"

  constructor(controlKind: "keepalive" | "protocol-ping") {
    this.controlKind = controlKind
  }
}

const issuedCapabilities = new WeakSet<object>()

/** Issue one runtime-authenticated capability for a non-structural control frame. */
export function createDeliveryControlCapability(controlKind: "keepalive" | "protocol-ping"): DeliveryControlCapability {
  const capability = Object.freeze(new RuntimeDeliveryControlCapability(controlKind))
  issuedCapabilities.add(capability)
  return capability as unknown as DeliveryControlCapability
}

/** Internal identity check; structural lookalikes and copied symbol properties are rejected. */
export function isDeliveryControlCapability(value: unknown, controlKind: "keepalive" | "protocol-ping"): value is DeliveryControlCapability {
  return typeof value === "object" && value !== null && issuedCapabilities.has(value) && (value as RuntimeDeliveryControlCapability).controlKind === controlKind
}
