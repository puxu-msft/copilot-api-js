#!/usr/bin/env python3
"""End-to-end: send the ORIGINAL CLIENT payload (the one whose de-stacked form 400'd)
through a proxy running the FIXED code with the default `move_blocks` strategy.

Success oracle is two-sided:
  1. HTTP 200 from the real upstream, and
  2. the History entry's upstream leg shows msg 28 laid out as
     [thinking, <separator>, thinking, tool_use] — separator in the middle,
     tool_use terminating the message.
"""
import json
import sys
import urllib.request

SRC = "/tmp/e-req_1785016294183_896.json"
d = json.load(open(SRC))
body = json.loads(json.dumps(d["clientRequest"]["body"]))
body["stream"] = False
body["max_tokens"] = min(body.get("max_tokens", 2000), 2000)

port = sys.argv[1] if len(sys.argv) > 1 else "4143"
c = body["messages"][28]["content"]
print("client msg28:", [b["type"] for b in c])

req = urllib.request.Request(
    f"http://localhost:{port}/v1/messages",
    data=json.dumps(body).encode(),
    headers={"Content-Type": "application/json", "anthropic-version": "2023-06-01"},
)
try:
    with urllib.request.urlopen(req, timeout=300) as r:
        data = json.load(r)
        print(f"HTTP {r.status} OK stop={data.get('stop_reason')} usage={data.get('usage', {}).get('output_tokens')}")
except urllib.error.HTTPError as e:
    print(f"HTTP {e.code} -> {e.read().decode()[:400]}")
    raise SystemExit(1)

eid = json.load(urllib.request.urlopen(f"http://localhost:{port}/history/api/entries?limit=1"))["entries"][0]["id"]
entry = json.load(urllib.request.urlopen(f"http://localhost:{port}/history/api/entries/{eid}"))
up = entry["attempts"][0]["upstreamRequest"]["body"]["messages"]
sent = up[28]["content"]
print("upstream msg28:", [(b["type"], b.get("text", "")[:40]) for b in sent])
print("destack stats:", json.dumps(entry.get("pipelineInfo", {}).get("sanitization")))
assert [b["type"] for b in sent] == ["thinking", "text", "thinking", "tool_use"], "layout not repaired as designed"
assert sent[1]["text"] == "[copilot-api: thinking separator]"
print("OK: C1+C2+C3 all satisfied on the wire")
