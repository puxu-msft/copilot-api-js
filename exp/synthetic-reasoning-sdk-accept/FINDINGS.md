# FINDINGS — SDK acceptance of sentinel-signed thinking blocks

**Probe question**: Does the real `@anthropic-ai/sdk` (the SDK Claude Code uses) ACCEPT a streamed
`thinking` block stamped with our synthetic sentinel signature `copilot-api:synthetic-reasoning:v1`,
or does it reject / silently drop it? (Head assumption of commit `cb87ed65` — GPT-reasoning passthrough.)

**Verdict: ACCEPT — preserved verbatim, no throw, no silent drop.**

## Evidence

Real `@anthropic-ai/sdk@0.106.0` consumed via the HIGH-level `client.messages.stream(...).finalMessage()`
(not just the low-level `Stream` decoder) yields:

```json
[
  { "type": "thinking", "thinking": "first second", "signature": "copilot-api:synthetic-reasoning:v1" },
  { "type": "text", "text": "final answer" }
]
```

- `stop_reason === "end_turn"`.
- `thinking` delta callbacks fire in order (`"first "`, `"second"`).
- `signature` callback receives the full sentinel value.
- The SDK does NOT validate the signature against an Anthropic-issued value — it accumulates it as an
  opaque string and preserves it verbatim.
- ⇒ No need to fall back to a text block or `redacted_thinking`. The native `thinking` block is correct.

## Positive control (oracle is not a no-op / false-green)

The same server + same high-level SDK call path, fed a deliberately ILLEGAL frame order
(`content_block_delta` before `message_start`), DID reject:

```
Unexpected event order, got content_block_delta before "message_start"
```

So the harness genuinely observes the SDK accumulator's rejection behavior — the success on the target
stream is not "never reached" or a green that proves nothing.

## Reproduction

Fully offline: a local HTTP SSE server on a random kernel port. No project server, no GHC/Anthropic
network, no 4141 / History DB touched.

```sh
bun run exp/synthetic-reasoning-sdk-accept/probe.ts
```

Deterministic: the full JSON output's SHA-256 is identical across 3 consecutive runs:

```
70b50b3f08bd952322bea66d084af04e49094d2507adda404621d0c94250becc
```

## Unverified boundary

- Not verified: the Claude Code CLI's terminal UI *visual* rendering of the thinking block. But the SDK's
  `thinking` + `signature` callbacks both receive complete data, so the render layer's data source is intact.

## Cross-check

This corroborates the in-suite `sdkAccumulate` unit oracle
(`tests/openai/cc-to-anthropic-stream.unit.test.ts` — "SDK ORACLE: a reasoning+text stream accumulates a
well-formed thinking block via the REAL @anthropic-ai/sdk"), which exercises the lower-level `Stream`
decoder. This probe extends the proof to the high-level `MessageStream.finalMessage()` path.
