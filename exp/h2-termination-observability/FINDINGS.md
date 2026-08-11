# H2 stream termination observability under Bun vs Node

**Measured 2026-08-11**, on `bun 1.3.14` and `node v24.16.0`, at base commit `f2a44579`.

## Why this exists

`tests/transport/http2-client.it.test.ts` carries a NOTE (locate it with `rg -n 'NOT unit-testable under Bun'`) asserting that under Bun, **every** mid-stream termination reaches the client as a synthetic clean `response → data → end → close` with `rstCode=0`, so a clean server `RST_STREAM` and a full connection drop are indistinguishable from a normal end — and that the `error` / `close-before-end` backstops fire only under Node.

That claim is load-bearing for plan A4, whose whole point is to let History mechanically tell a **peer** cancel apart from a **local** abort. The NOTE cites `exp/upstream-models-hang/` as its evidence, but that directory does not exist in this repo and never has (`git log --all -- 'exp/upstream-models-hang'` is empty), so the claim could not be reproduced from the repository and had to be re-measured.

## Headline result: the NOTE is false, and backwards

Under Bun, a genuine peer `RST_STREAM(CANCEL)` mid-body **is** fully observable — Bun raises `error(ERR_HTTP2_STREAM_ERROR)` with `rstCode=8`. It is **Node** that swallows a peer CANCEL into a clean `end` with no error at all.

The NOTE's original observation was almost certainly real, but it was produced by a **miswritten scenario** rather than by a runtime limitation. See the next section — that is the part with the widest blast radius.

## The trap: `serverStream.close(NGHTTP2_CANCEL)` does not send RST_STREAM

The frozen A4 acceptance recipe (HANDOVER §B.5.2) prescribes: "对端 `stream.close(NGHTTP2_CANCEL)` 发送 peer `RST_STREAM(CANCEL)`".

**It does not**, when the server stream still has an open writable side. Measured at the wire by `frame-oracle.mjs`, which decodes actual HTTP/2 frame headers through a TCP relay:

| Server-side spelling (after `respond()` + `write()`, no `end()`) | What actually crosses the wire |
|---|---|
| `stream.close(NGHTTP2_CANCEL)` | `DATA[10B]`, then **`DATA[END_STREAM, 0B]`** — no RST_STREAM at all |
| `stream.close(NGHTTP2_INTERNAL_ERROR)` | `DATA[10B]`, then **`DATA[END_STREAM, 0B]`** — no RST_STREAM at all |
| `stream.destroy()` | `DATA[10B]`, then `RST_STREAM[errorCode=0]` |
| `stream.destroy(new Error())` | `DATA[10B]`, then `RST_STREAM[errorCode=2]` |

`close(code)` ends the writable side first, and once the stream is closed the RST is never emitted. The client therefore sees a **genuinely clean end**, because the peer genuinely ended cleanly.

This matters more than the runtime question: a test written to that recipe would observe "peer CANCEL is indistinguishable from a clean end" **while never having sent a peer CANCEL**. It is a false-negative generator, and it reads as a profound runtime finding. Any A4 acceptance test must assert against the wire, or use the injector below, rather than trusting the server-side call.

Note also that none of the four spellings emits `RST_STREAM(CANCEL=8)` mid-body. To produce that exact frame you need frame injection.

## Method

Three scripts, each runnable under both runtimes:

- `probe.mjs` — client-side observation of seven termination shapes driven from an ordinary `node:http2` server.
- `frame-oracle.mjs` — a TCP relay that decodes 9-byte HTTP/2 frame headers, giving ground truth on which frames actually crossed. This is the independent oracle: `probe.mjs` reads the very API layer under suspicion, so it cannot confirm its own premise.
- `peer-rst-injector.mjs` — a TCP relay that writes a protocol-exact `RST_STREAM` frame (or rips out the TCP connection) at the client after the first DATA frame. This is the only way to test a specific peer error code mid-body, and is directly reusable as test infrastructure.

## Results: genuine peer RST_STREAM injected mid-body

| Injected | Bun 1.3.14 | Node v24.16.0 |
|---|---|---|
| `RST_STREAM(CANCEL=8)` | `response → data → aborted → error(ERR_HTTP2_STREAM_ERROR)` , `rstCode=8` | `response → data → end → close`, `rstCode=8`, **no error** |
| `RST_STREAM(INTERNAL_ERROR=2)` | `… → aborted → error(ERR_HTTP2_STREAM_ERROR)`, `rstCode=2` | `… → error(ERR_HTTP2_STREAM_ERROR)`, `rstCode=2` |
| `RST_STREAM(REFUSED_STREAM=7)` | `… → aborted → error(ERR_HTTP2_STREAM_ERROR)`, `rstCode=7` | `… → error(ERR_HTTP2_STREAM_ERROR)`, `rstCode=7` |
| abrupt TCP drop, no frame | `… → aborted → end`, **no `close` within 4s**, `rstCode` reads 8 | `… → end → close`, `rstCode=8`, no error |

Node special-cases CANCEL as a non-error close; Bun does not. That is the entire disagreement, and it runs opposite to what the NOTE says.

## What discriminates what

- **Peer CANCEL vs local abort.** Distinguishable on both runtimes, but **not by `rstCode`** — a local `req.close(NGHTTP2_CANCEL)` also yields `rstCode=8`. The discriminator is that a local abort is locally observable by construction: we know we called it. Any classifier must take the local signal as its primary input and treat `rstCode` as corroboration.
- **Peer CANCEL vs abrupt connection drop.** Distinguishable **under Bun** (real CANCEL raises `ERR_HTTP2_STREAM_ERROR`; a TCP drop does not) but **not under Node**, where both are a clean `end` carrying `rstCode=8` and no error. This is the reverse of the NOTE's claim about which runtime is lossy.
- **A TCP drop reads as `rstCode=8` on both runtimes.** So `rstCode === NGHTTP2_CANCEL` on its own must never be reported as "the peer cancelled": it is equally consistent with the connection having died. On Bun the presence or absence of the stream `error` separates them; on Node nothing at this layer does.

## What this does NOT prove

- **It does not measure our adapter.** All three scripts drive `node:http2` directly. Whether `runHttp2Fetch` and the termination recorder preserve these distinctions is a separate question, to be checked against the production path rather than inferred from here.
- **It does not describe real GHC upstreams.** Every scenario is a local h2c loopback with no TLS, no proxy, and no intermediary. A real CDN or corporate proxy can rewrite or invent terminations, and h2 over TLS may differ.
- **It does not explain the original `upstream-models-hang` symptom.** That investigation's artifacts are gone; this only shows the mechanism the NOTE blamed is not the mechanism at work. The hang may still have been real and may have had another cause.
- **It says nothing about timing under load.** Everything ran on an idle loop with millisecond delays. Event-loop starvation, which Phase B lists as a suspected CANCEL cause, is deliberately not modelled.
- **Single Bun and Node version each.** `rstCode` handling is exactly the kind of behaviour that changes between minor releases — re-run these before trusting them on a different runtime build.
- **The `aborted` event is not a discriminator under Bun.** In `probe.mjs`, Bun fires `aborted` even on a perfectly clean end (scenario A), so its presence carries no information there.

## Reproduce

```
bun  exp/h2-termination-observability/probe.mjs
node exp/h2-termination-observability/probe.mjs
bun  exp/h2-termination-observability/frame-oracle.mjs
node exp/h2-termination-observability/frame-oracle.mjs
bun  exp/h2-termination-observability/peer-rst-injector.mjs
node exp/h2-termination-observability/peer-rst-injector.mjs
```

Each prints a per-scenario trace followed by a machine-readable JSON block.

## Consequences for A4

1. HANDOVER §B.5.2 pending item 1 ("peer RST may be unobservable in the production runtime") rests on a false premise and does not need the three-way adjudication it registered. Peer RST **is** observable under Bun.
2. The HTTP/2 injection recipe in that same section is wrong and will silently produce false negatives. It needs correcting to `stream.destroy()` / frame injection before any A4 acceptance test is written against it.
3. The `NOT unit-testable under Bun` NOTE in `tests/transport/http2-client.it.test.ts` should be corrected in place; it currently tells future readers that a testable thing is untestable.
