# FINDINGS — GHC reasoning summary event shape (with reasoning.summary:"auto")

**Probe question**: after requesting `reasoning: { effort, summary: "auto" }` on the Responses hop, what
reasoning-summary SSE events does real GHC gpt-5.x emit, and where is `encrypted_content`? (Authoritative
contract for the `responses-to-cc-stream.ts` bridge — the type defs already misled once.)

**Verdict: request side works; summary streams as plaintext deltas — but only at sufficient effort.**

## Evidence (isolated server 4155, real GHC, independent history.db)

History confirms the real upstream request carried `reasoning: { effort, summary: "auto" }` (model resolved
it to `summary: "detailed"`). `hooks.enabled: false`, no `hook-mock` markers → genuine GHC.

### effort: low → NO summary
`summary: "auto"` was sent, but the reasoning item's `summary: []` — no summary frames. **Requesting a
summary does NOT guarantee one.** The bridge MUST tolerate complete absence.

### effort: medium → full summary stream
Authoritative event order:
```
response.output_item.added        # item.type "reasoning"; summary: [], encrypted_content ALREADY non-empty
response.reasoning_summary_part.added     # summary_index 0, part {type:"summary_text", text:""}
response.reasoning_summary_text.delta × N # delta = plaintext summary increment (64 frames here)
response.reasoning_summary_text.done      # text = full summary
response.reasoning_summary_part.done      # part.text = full summary
response.output_item.done         # reasoning item; summary aggregated, encrypted_content non-empty (len 1804)
```
The 64 `delta`s concatenate to a clean plaintext summary ("**Calculating speed**\n\nI need to find out...").

`encrypted_content` present + non-empty in BOTH `output_item.added` and `.done` reasoning items.

## Bridge contract (implemented in a9f9b874)
1. `response.reasoning_summary_text.delta.delta` → CC `delta.reasoning` (stream).
2. `output_item.added(reasoning).encrypted_content` → CC `delta.reasoning_encrypted_content`.
3. Downstream `cc-to-anthropic-stream.ts` opens the synthetic thinking block; signature =
   `copilot-api:synthetic-reasoning:v1:<base64url(encrypted_content)>`.
4. Absence graceful: no summary delta → no reasoning chunk → no thinking block (never an empty one).

## Client verification (before the bridge landed)
Even with 67 upstream reasoning-summary frames, the client Anthropic SSE had ONLY a text block — proving
the request side worked but the response bridge was missing. (Now wired in a9f9b874.)

## Artifacts
- exp/synthetic-reasoning-summary-shape/{request,request-2}.json
- exp/synthetic-reasoning-summary-shape/{client,client-2}.sse
- exp/synthetic-reasoning-summary-shape/{history,history-2}.json
- exp/synthetic-reasoning-summary-shape/{upstream-event-types,upstream-event-types-2}.json
- exp/synthetic-reasoning-summary-shape/summary-text-2.txt

4141 protection honored: isolated server on 4155 killed by PID, 4141 /health verified healthy after.
