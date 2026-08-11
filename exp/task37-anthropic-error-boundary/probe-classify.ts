import { createAnthropicDeliveryProtocolAdapter } from "~/lib/pipeline/delivery/adapters/anthropic"
import { anthropicCommitBoundaries } from "~/lib/codec/anthropic/commit-boundaries"

const adapter = createAnthropicDeliveryProtocolAdapter()
const frames = [
  { name: "content_block_stop", frame: { event: "content_block_stop", data: JSON.stringify({ type: "content_block_stop", index: 0 }) } },
  { name: "error (upstream terminal)", frame: { event: "error", data: JSON.stringify({ type: "error", error: { type: "api_error", message: "boom" } }) } },
]
for (const { name, frame } of frames) {
  const classified = adapter.classify({ frame } as never) as { kind: string; error?: { semantic: string } }
  console.log(name)
  console.log(`  outer anthropicCommitBoundaries : ${anthropicCommitBoundaries(frame as never)}`)
  console.log(`  adapter.classify().kind         : ${classified.kind}${classified.error ? ` (semantic=${classified.error.semantic})` : ""}`)
  console.log(`  can ever yield complete-unit?   : ${classified.kind === "unit-close" ? "yes (grammar decides)" : "NO — not a unit-close"}`)
}
