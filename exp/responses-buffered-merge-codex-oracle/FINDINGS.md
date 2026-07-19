# Responses buffered-merge — Codex real-consumer oracle (FINDINGS)

> **NON-BLOCKING manual verification.** This oracle does NOT gate the feature. `buffered_retry` is
> currently default **ON** (flipped in commit `1d318976`, before this branch), and `event_compaction`
> default `drop-delta` therefore rides on it for every Responses stream. This harness
> only gives a one-hand data point on whether a REAL Codex consumer reconstructs the **drop-delta merged**
> forwarded wire identically to the **verbatim** wire — evidence for a FUTURE "default-on" decision, not a
> prerequisite for landing the feature. Automated coverage (official `openai` SDK + `@ai-sdk/openai` +
> reducer unit + HTTP/WS dual-track golden) already proves client tolerance offline; this is the real-billed
> confirmation layer (skill `live-ghc-e2e-verification` sibling — but here the upstream is a LOCAL mock, so
> no GHC billing; only the Codex CLI runs for real).

## 背景 / Background

Block-level buffered retry (`responses.buffered_retry`) buffers each Responses generation and, on the
forwarded track, may DROP the per-`.delta` frames (`event_compaction: drop-delta`) — the terminal
`output_item.done` + `response.completed` carry the complete content, so a `finalResponse`-style consumer
loses nothing. This oracle checks that assumption against the REAL Codex CLI, not just SDK accumulators.

## 方法 / Method

Two arms, semantically identical, wire differs:

| Arm | Upstream wire | Frames |
|-----|---------------|--------|
| `verbatim` | function_call generation WITH `function_call_arguments.delta` × 2 | created / added / delta / delta / done / output_item.done / completed |
| `merged` | the SAME generation with the two `.delta` frames removed | created / added / done / output_item.done / completed |

Both carry an identical `response.completed.output` (`get_weather {"city":"Tokyo"}`). Run Codex against
each arm through the proxy; a matching agent reply for both arms confirms the merge is transparent.

Topology: `codex exec` → copilot-api proxy (buffered ON) → `mock-upstream.ts` (HTTPS/h2, this dir).

### 运行指令 / How to run (user)

```bash
# 0. self-check the mock arms WITHOUT the proxy (frame-shape sanity — see 自检 below).
# 1. start ONE long-lived proxy pointed at the mock:
#      ghc_api_base_url: https://localhost:8788
#      openai_responses.buffered_retry: true
#      openai_responses.buffered_merge.event_compaction: drop-delta
# 2. run each arm (this script starts the mock for that arm + drives one codex turn):
bun run exp/responses-buffered-merge-codex-oracle/run-proxy-arm.sh verbatim
bun run exp/responses-buffered-merge-codex-oracle/run-proxy-arm.sh merged
# 3. diff the two *.oracle.log — the agent replies should match (both "Tokyo").
```

### 自检 / Self-check (no proxy, no codex — frame-shape only)

```bash
# generate the cert once (or let run-proxy-arm.sh do it), then curl each arm directly:
MOCK_ARM=verbatim MOCK_UPSTREAM_PORT=8788 bun run exp/responses-buffered-merge-codex-oracle/mock-upstream.ts &
curl -sk --http2 -N https://localhost:8788/responses -X POST -d '{}' | grep -c 'function_call_arguments.delta'   # expect 2
MOCK_ARM=merged   MOCK_UPSTREAM_PORT=8788 bun run exp/responses-buffered-merge-codex-oracle/mock-upstream.ts &
curl -sk --http2 -N https://localhost:8788/responses -X POST -d '{}' | grep -c 'function_call_arguments.delta'   # expect 0
```

## 两臂结果对照 / Arm results

> **NOT pre-filled** — populated only after the user runs `codex exec` for real (per `no-auto-server`:
> the agent writes the harness, the user runs the proxy + Codex).

| Arm | codex rc | is_error | last agent message | notes |
|-----|----------|----------|--------------------|-------|
| verbatim | _tbd_ | _tbd_ | _tbd_ | |
| merged   | _tbd_ | _tbd_ | _tbd_ | |

## 结论 / Conclusion

> _tbd — fill after both arms run. Expected: identical agent replies → the drop-delta merge is transparent
> to a real Codex consumer, supporting (but not required for) a future default-on decision._
