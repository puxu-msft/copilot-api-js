import { createAnthropicDeliveryProtocolAdapter } from "~/lib/pipeline/delivery/adapters/anthropic"
import { anthropicCommitBoundaries } from "~/lib/codec/anthropic/commit-boundaries"

const adapter = createAnthropicDeliveryProtocolAdapter()

// The adapter's own renderError output, fed back into its own classify.
const rendered = adapter.renderError({ semantic: "terminal-failure", detail: "boom", sourceFrame: null, cause: undefined } as never)
for (const frame of rendered) {
  const classified = adapter.classify({ frame } as never) as { kind: string; error?: { semantic: string } }
  console.log("renderError() output:", JSON.stringify(frame))
  console.log(`  outer anthropicCommitBoundaries : ${anthropicCommitBoundaries(frame as never)}`)
  console.log(`  its own classify().kind         : ${classified.kind}${classified.error ? ` (semantic=${classified.error.semantic})` : ""}`)
}
