import type {
  //
  DeliveryProtocolAdapter,
} from "../protocol"

/** Create the Anthropic wire classifier. Additional classes and renderers land test-first. */
export function createAnthropicDeliveryProtocolAdapter(): DeliveryProtocolAdapter {
  return {
    deliveryMode: "unit",
    classify({ frame }) {
      const payload = JSON.parse(frame.data ?? "") as { type?: unknown; index?: unknown }
      if (payload.type === "content_block_start" && typeof payload.index === "number") {
        return {
          kind: "unit-open",
          unit: { boundary: "content-block", key: String(payload.index) },
          frame,
        }
      }
      throw new Error(`[anthropic-delivery-adapter] unsupported frame: ${String(payload.type)}`)
    },
    classifyFinish() {
      throw new Error("[anthropic-delivery-adapter] finish classification is not implemented")
    },
    renderTerminal() {
      throw new Error("[anthropic-delivery-adapter] terminal rendering is not implemented")
    },
    renderError() {
      throw new Error("[anthropic-delivery-adapter] error rendering is not implemented")
    },
    renderDone() {
      throw new Error("[anthropic-delivery-adapter] done rendering is not implemented")
    },
  }
}
