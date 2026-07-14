# FINDINGS — real GHC gpt-5.x reasoning shape (NO plaintext without a summary request)

**Probe question**: does GHC's gpt-5.x emit displayable plaintext reasoning through the Anthropic
`/v1/messages` translation leg, so the `cb87ed65` reasoning→thinking passthrough actually fires?

**Verdict: conditionally — but the gpt-5.x Responses-first MAIN path emitted NO plaintext reasoning,
so the passthrough was DORMANT.** The full reasoning is ENCRYPTED; only a `summary` (requested
separately) is displayable, and we were not requesting one.

## Evidence (isolated server 4154, real GHC, independent history.db)

Streaming `/v1/messages` with `thinking` / `output_config.effort`, short arithmetic, max_tokens 256.

### gpt-5.4-mini, no suffix → Responses-first main path
Route: `{"resolved":"gpt-5.4-mini","outboundEndpoint":"/responses","translated":true}`
- `response.created/in_progress`: `response.reasoning` is a CONFIG object `{effort, mode, summary: null}` — not prose.
- `response.output_item.{added,done}`: one `item.type: "reasoning"` with:
  - `encrypted_content`: NON-empty
  - `summary: []` (empty)
  - `content: []` (empty)
- No displayable reasoning plaintext. usage confirms reasoning happened: `reasoning_tokens: 22`.
- Client Anthropic SSE: only a text block. No `thinking` content_block_start / thinking_delta / signature_delta.

### gpt-5.4@cc → CC leg (control)
Route: `{"resolved":"gpt-5.4","routeOverride":"cc","outboundEndpoint":"/chat/completions","translated":true}`
- CC SSE: only `delta.content`. NO `delta.reasoning` / `delta.reasoning_content`. Final usage `reasoning_tokens: 14`.

## Root gap

`responses-to-cc-stream.ts` dropped reasoning items (`if (event.item.type !== "function_call") return []`),
and `cc-to-anthropic-stream.ts` only reads `delta.reasoning` — but even upstream, no plaintext reasoning
exists unless a `summary` is requested. The reasoning is `encrypted_content` (opaque).

## Consequence

Drove the follow-up: request `reasoning.summary:"auto"` on the Responses hop, then bridge the resulting
summary events. See exp/synthetic-reasoning-summary-shape (probe ③) for the with-summary event shape.

## Artifacts
- exp/synthetic-reasoning-upstream-shape/history-responses.json
- exp/synthetic-reasoning-upstream-shape/history-cc.json
- exp/synthetic-reasoning-upstream-shape/client-responses.sse
- exp/synthetic-reasoning-upstream-shape/client-cc.sse
- exp/synthetic-reasoning-upstream-shape/model-catalog.json

4141 protection honored: isolated server on 4154, killed by PID, 4141 /health verified healthy after.
