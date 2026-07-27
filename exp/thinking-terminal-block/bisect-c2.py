#!/usr/bin/env python3
"""Additive bisection: what makes `[T, tool, T]` flip from 200 to 400?

The minimal conversation returns 200 for the very layout that 400s inside the full
production payload. Start from the minimal 200 case and add ONE production trait at a
time until it flips — that names the real precondition of the C2 constraint.

Cheap by design: the minimal payload is a few kB, so each shot costs ~1-3k input tokens
(the full replay costs ~90k).
"""
import copy
import json
import sys
import urllib.request

B = json.load(open("/tmp/probe-blocks.json"))
T1, TOOL, T2 = B["T1"], B["TOOL"], B["T2"]
TOOL_ID = TOOL["id"]
SRC = json.load(open("/tmp/e-896.json"))
PROD = SRC["attempts"][0]["upstreamRequest"]["body"]
INJECTED = {"Grep", "KillShell", "tool_search_tool_regex", "Glob", "Task"}
PROD_TOOLS = [t for t in PROD.get("tools", []) if t.get("name") not in INJECTED]
PROD_SYSTEM_MSGS = [m for m in PROD["messages"] if m["role"] == "system"]
PROD_SYSTEM = PROD.get("system")


def base_messages():
    """The minimal conversation that empirically returns 200 with [T, tool, T]."""
    return [
        {"role": "user", "content": [{"type": "text", "text": "Say hi."}]},
        {"role": "assistant", "content": [T1, TOOL, T2]},  # C2 violation: ends on thinking
        {
            "role": "user",
            "content": [
                {"type": "tool_result", "tool_use_id": TOOL_ID, "content": "ok"},
                {"type": "text", "text": "Reply with exactly: PONG"},
            ],
        },
    ]


def build(name):
    body = {
        "model": "claude-opus-5",
        "max_tokens": 1100,
        "stream": False,
        "thinking": {"type": "enabled", "budget_tokens": 1024},
        "messages": base_messages(),
    }
    if name == "baseline":
        pass
    elif name == "plus-inline-system":
        # Splice the three real inline role:"system" messages in, as production had them.
        msgs = body["messages"]
        body["messages"] = [msgs[0], copy.deepcopy(PROD_SYSTEM_MSGS[0]), msgs[1], msgs[2]]
    elif name == "plus-top-system":
        body["system"] = copy.deepcopy(PROD_SYSTEM)
    elif name == "plus-tools":
        body["tools"] = copy.deepcopy(PROD_TOOLS)
    elif name == "plus-bulk-turns":
        # Pad with prior benign turns so the offending message sits deep in the history.
        pad = []
        for i in range(13):
            pad.append({"role": "user", "content": [{"type": "text", "text": f"turn {i}"}]})
            pad.append({"role": "assistant", "content": [{"type": "text", "text": f"ack {i}"}]})
        body["messages"] = pad + body["messages"]
    elif name == "plus-all":
        body["system"] = copy.deepcopy(PROD_SYSTEM)
        body["tools"] = copy.deepcopy(PROD_TOOLS)
        msgs = body["messages"]
        body["messages"] = [msgs[0], copy.deepcopy(PROD_SYSTEM_MSGS[0]), msgs[1], msgs[2]]
    else:
        raise SystemExit(f"unknown variant {name}")
    return body


port = sys.argv[1] if len(sys.argv) > 1 else "4142"
for name in sys.argv[2:] or ["baseline"]:
    body = build(name)
    req = urllib.request.Request(
        f"http://localhost:{port}/v1/messages",
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json", "anthropic-version": "2023-06-01"},
    )
    size = len(json.dumps(body))
    try:
        with urllib.request.urlopen(req, timeout=180) as r:
            d = json.load(r)
            print(f"{name}: [{size}B] HTTP {r.status} OK stop={d.get('stop_reason')}")
    except urllib.error.HTTPError as e:
        msg = e.read().decode()
        short = msg[:220].replace("\\n", " ")
        print(f"{name}: [{size}B] HTTP {e.code} -> {short}")
    except Exception as e:  # noqa: BLE001
        print(f"{name}: ERROR {type(e).__name__} {e}")
