#!/usr/bin/env python3
"""Subtractive bisection on the real 400 payload: which part is the C2 precondition?

Additive probing failed — inline system messages, the top-level system prompt, the tool
definitions, extra turns, and all of them combined each returned 200 with the offending
`[T, tool, T]` layout. So the precondition lives in the production MESSAGE HISTORY.

Halve the history (keeping the offending assistant message at index 28 and its
tool_result follower) until the 400 flips to 200; that names the real trigger.

Keeps cost down by dropping the top-level system prompt and keeping only the tool
definitions actually referenced by the retained messages (orphan tool_use would
otherwise be deleted by our own sanitize pass and change the shape under test).
"""
import copy
import json
import sys
import urllib.request

SRC = json.load(open("/tmp/e-896.json"))
PROD = SRC["attempts"][0]["upstreamRequest"]["body"]
INJECTED = {"Grep", "KillShell", "tool_search_tool_regex", "Glob", "Task"}


def slice_from(start):
    """Retain messages[start:] and make it a well-formed conversation."""
    msgs = copy.deepcopy(PROD["messages"][start:])
    # Drop tool_result blocks whose tool_use was cut away (they would be stripped by our
    # own sanitize anyway); drop any message left empty.
    live_ids = {b["id"] for m in msgs if isinstance(m["content"], list) for b in m["content"] if b.get("type") == "tool_use"}
    seen_ids = set()
    cleaned = []
    for m in msgs:
        if not isinstance(m["content"], list):
            cleaned.append(m)
            continue
        kept = []
        for b in m["content"]:
            if b.get("type") == "tool_result" and b.get("tool_use_id") not in live_ids | seen_ids:
                continue
            kept.append(b)
        for b in m["content"]:
            if b.get("type") == "tool_use":
                seen_ids.add(b["id"])
        if kept:
            cleaned.append({**m, "content": kept})
    # Conversation must open with a user message.
    if not cleaned or cleaned[0]["role"] != "user":
        cleaned.insert(0, {"role": "user", "content": [{"type": "text", "text": "continue"}]})
    return cleaned


def build(start):
    msgs = slice_from(start)
    used = {b["name"] for m in msgs if isinstance(m["content"], list) for b in m["content"] if b.get("type") == "tool_use"}
    tools = [t for t in PROD.get("tools", []) if t.get("name") in used and t.get("name") not in INJECTED]
    body = {
        "model": PROD.get("model", "claude-opus-5"),
        "max_tokens": 2000,
        "stream": False,
        "messages": msgs,
    }
    if PROD.get("thinking"):
        body["thinking"] = copy.deepcopy(PROD["thinking"])
    if tools:
        body["tools"] = tools
    return body


port = sys.argv[1] if len(sys.argv) > 1 else "4142"
for arg in sys.argv[2:] or ["0"]:
    start = int(arg)
    body = build(start)
    shape = [b["type"] for m in body["messages"] if isinstance(m["content"], list) for b in m["content"]][-4:]
    req = urllib.request.Request(
        f"http://localhost:{port}/v1/messages",
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json", "anthropic-version": "2023-06-01"},
    )
    size = len(json.dumps(body))
    tag = f"from[{start}] msgs={len(body['messages'])} tools={len(body.get('tools', []))} {size // 1024}KB"
    try:
        with urllib.request.urlopen(req, timeout=240) as r:
            d = json.load(r)
            print(f"{tag}: HTTP {r.status} OK stop={d.get('stop_reason')}")
    except urllib.error.HTTPError as e:
        short = e.read().decode()[:200].replace("\\n", " ")
        print(f"{tag}: HTTP {e.code} -> {short}")
    except Exception as e:  # noqa: BLE001
        print(f"{tag}: ERROR {type(e).__name__} {e}")
