#!/usr/bin/env python3
"""Replay the exact upstream payload of the 400'd request, plus repair variants.

Ground truth for: which assistant message layout actually triggers
"The final block in an assistant message cannot be `thinking`."
"""
import copy
import json
import sys
import urllib.request

SRC = "/tmp/e-req_1785016294183_896.json"
d = json.load(open(SRC))
BASE = d["attempts"][0]["upstreamRequest"]["body"]
SEP = {"type": "text", "text": "[copilot-api: thinking separator]"}


def send(name, body, port):
    req = urllib.request.Request(
        f"http://localhost:{port}/v1/messages",
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json", "anthropic-version": "2023-06-01"},
    )
    try:
        with urllib.request.urlopen(req, timeout=300) as r:
            data = json.load(r)
            print(f"{name}: HTTP {r.status} OK stop={data.get('stop_reason')} usage={data.get('usage')}")
    except urllib.error.HTTPError as e:
        print(f"{name}: HTTP {e.code} -> {e.read().decode()[:400]}")
    except Exception as e:  # noqa: BLE001
        print(f"{name}: ERROR {type(e).__name__} {e}")


def variant(name):
    b = copy.deepcopy(BASE)
    b["stream"] = False
    b["max_tokens"] = min(b.get("max_tokens", 2000), 2000)
    # Strip the tools OUR proxy injects (deferred/tool-search); replaying the upstream
    # body verbatim would make it inject a second copy -> "Tool names must be unique".
    injected = {"Grep", "KillShell", "tool_search_tool_regex", "Glob", "Task"}
    b["tools"] = [t for t in b.get("tools", []) if t.get("name") not in injected]
    msgs = b["messages"]
    c = msgs[28]["content"]  # [T1, tool, T2] — the de-stacked layout that 400s
    if name == "replay-asis":
        pass
    elif name == "sep-mid-tool-end":
        msgs[28]["content"] = [c[0], SEP, c[2], c[1]]
    elif name == "append-sep-at-end":
        msgs[28]["content"] = [*c, SEP]
    elif name == "thinking-only-sep-end":
        # drop the tool_use entirely -> [T1, SEP, T2, SEP]; also drop the matching
        # tool_result from the next message so no orphan reference remains.
        msgs[28]["content"] = [c[0], SEP, c[2], SEP]
        tid = c[1]["id"]
        msgs[29]["content"] = [x for x in msgs[29]["content"] if x.get("tool_use_id") != tid] or [
            {"type": "text", "text": "continue"}
        ]
    elif name == "tool-interleaved-mid":
        # msg26 [T, tool1, tool2] -> [T, tool1, T2', tool2]: a tool_use sits BETWEEN two
        # thinking blocks while the LAST block is still tool_use. Decides whether the
        # constraint is "tool_use must be last" (ok) or "all tool_use must trail" (not ok).
        m26 = msgs[26]["content"]
        msgs[26]["content"] = [m26[0], m26[1], copy.deepcopy(c[2]), m26[2]]
        msgs[28]["content"] = [c[0], SEP, c[2], c[1]]  # known-good layout, isolates the variable
    elif name == "orig-client-adjacent":
        msgs[28]["content"] = [c[0], c[2], c[1]]
    else:
        raise SystemExit(f"unknown variant {name}")
    return b


port = sys.argv[1] if len(sys.argv) > 1 else "4142"
for name in sys.argv[2:] or ["replay-asis"]:
    send(name, variant(name), port)
