"""A/B: does defer_loading actually keep deferred tool schemas OUT of the prompt?

Same payload to two isolated servers differing ONLY in `anthropic.tool_search`.
Oracle is the upstream-reported usage (input + cache_creation), read back from each
server's own History — not our own byte counting.
"""
import json, sys, urllib.request, time

tools = json.load(open("/tmp/ab-tools.json"))
body = {
    "model": "claude-opus-5",
    "max_tokens": 64,
    "stream": False,
    "messages": [{"role": "user", "content": "Reply with exactly: PONG"}],
    "tools": tools,
}

def shot(port):
    req = urllib.request.Request(
        f"http://localhost:{port}/v1/messages",
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json", "anthropic-version": "2023-06-01"},
    )
    with urllib.request.urlopen(req, timeout=240) as r:
        json.load(r)
    time.sleep(1.5)
    eid = json.load(urllib.request.urlopen(f"http://localhost:{port}/history/api/entries?limit=1"))["entries"][0]["id"]
    d = json.load(urllib.request.urlopen(f"http://localhost:{port}/history/api/entries/{eid}"))
    a = d["attempts"][-1]
    up = a["upstreamRequest"]
    sent = (up.get("body") or {}).get("tools") or up.get("tools") or []
    u = (a.get("upstreamResponse") or {}).get("usage") or {}
    inp = u.get("input_tokens") or 0
    cc = u.get("cache_creation_input_tokens") or 0
    cr = u.get("cache_read_input_tokens") or 0
    deferred = [t for t in sent if t.get("defer_loading") is True]
    ts = [t for t in sent if str(t.get("type", "")).startswith("tool_search")]
    return {
        "port": port, "tools_sent": len(sent), "deferred": len(deferred), "tool_search_declared": len(ts),
        "input_tokens": inp, "cache_creation": cc, "cache_read": cr, "billed_prompt": inp + cc,
    }

res = [shot(p) for p in (sys.argv[1:] or ["4142", "4143"])]
for r in res:
    print(json.dumps(r))
if len(res) == 2:
    a, b = res
    print(f"\nA(port {a['port']}, tool_search on ): deferred={a['deferred']}  billed_prompt={a['billed_prompt']}")
    print(f"B(port {b['port']}, tool_search off): deferred={b['deferred']}  billed_prompt={b['billed_prompt']}")
    print(f"DELTA (B - A) = {b['billed_prompt'] - a['billed_prompt']} tokens saved by defer_loading")
