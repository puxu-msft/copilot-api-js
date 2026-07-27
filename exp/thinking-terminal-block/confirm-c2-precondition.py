#!/usr/bin/env python3
"""Confirm the C2 precondition isolated by subtractive bisection.

Bisection showed: keeping just [user, assistant(T,tool,T), user(tool_result)] returns
200, but prepending ONE earlier turn whose assistant message also carries thinking makes
the identical offending message 400. Test that directly, with a control that differs only
in whether the earlier assistant carries a thinking block.
"""
import copy
import json
import sys
import urllib.request

SRC = json.load(open("/tmp/e-896.json"))
PROD = SRC["attempts"][0]["upstreamRequest"]["body"]
M26 = PROD["messages"][26]["content"]  # [thinking, tool_use, tool_use]
M28 = PROD["messages"][28]["content"]  # [thinking, tool_use, thinking]  <- the C2 violation
EARLY_T, EARLY_TOOL = copy.deepcopy(M26[0]), copy.deepcopy(M26[1])
T1, TOOL, T2 = copy.deepcopy(M28[0]), copy.deepcopy(M28[1]), copy.deepcopy(M28[2])
TOOL_DEFS = [t for t in PROD["tools"] if t.get("name") in {TOOL["name"], EARLY_TOOL["name"]}]


def turns(early_assistant_blocks):
    return [
        {"role": "user", "content": [{"type": "text", "text": "Say hi."}]},
        {"role": "assistant", "content": early_assistant_blocks},
        {"role": "user", "content": [{"type": "tool_result", "tool_use_id": EARLY_TOOL["id"], "content": "ok"}]},
        {"role": "assistant", "content": [T1, TOOL, T2]},  # identical in every variant
        {"role": "user", "content": [{"type": "tool_result", "tool_use_id": TOOL["id"], "content": "ok"}]},
    ]


VARIANTS = {
    # No earlier turn at all — the shape bisection proved returns 200.
    "1-no-earlier-turn": [
        {"role": "user", "content": [{"type": "text", "text": "Say hi."}]},
        {"role": "assistant", "content": [T1, TOOL, T2]},
        {"role": "user", "content": [{"type": "tool_result", "tool_use_id": TOOL["id"], "content": "ok"}]},
    ],
    # Earlier turn present but WITHOUT thinking — isolates "extra turn" from "extra thinking".
    "2-earlier-turn-no-thinking": turns([EARLY_TOOL]),
    # Earlier turn WITH thinking — the production shape.
    "3-earlier-turn-with-thinking": turns([EARLY_T, EARLY_TOOL]),
    # Same two turns, ORDER SWAPPED: the offending message is now the FIRST assistant
    # while a later turn still follows. Separates "conversation has >=2 turns" from
    # "the offending message is not the first assistant message".
    "4-violation-first-assistant": [
        {"role": "user", "content": [{"type": "text", "text": "Say hi."}]},
        {"role": "assistant", "content": [T1, TOOL, T2]},
        {"role": "user", "content": [{"type": "tool_result", "tool_use_id": TOOL["id"], "content": "ok"}]},
        {"role": "assistant", "content": [EARLY_TOOL]},
        {"role": "user", "content": [{"type": "tool_result", "tool_use_id": EARLY_TOOL["id"], "content": "ok"}]},
    ],
}

port = sys.argv[1] if len(sys.argv) > 1 else "4142"
for name in sys.argv[2:] or list(VARIANTS):
    body = {
        "model": "claude-opus-5",
        "max_tokens": 2000,
        "stream": False,
        "thinking": copy.deepcopy(PROD.get("thinking")) or {"type": "enabled", "budget_tokens": 1024},
        "tools": TOOL_DEFS,
        "messages": VARIANTS[name],
    }
    req = urllib.request.Request(
        f"http://localhost:{port}/v1/messages",
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json", "anthropic-version": "2023-06-01"},
    )
    try:
        with urllib.request.urlopen(req, timeout=180) as r:
            d = json.load(r)
            print(f"{name}: HTTP {r.status} OK stop={d.get('stop_reason')}")
    except urllib.error.HTTPError as e:
        short = e.read().decode()[:200].replace("\\n", " ")
        print(f"{name}: HTTP {e.code} -> {short}")
    except Exception as e:  # noqa: BLE001
        print(f"{name}: ERROR {type(e).__name__} {e}")
