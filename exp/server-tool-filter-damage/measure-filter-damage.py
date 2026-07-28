"""How often does OUR server-tool filter create adjacent thinking on the client leg?"""
import json, urllib.request
base = "http://localhost:4141/history/api"
T = ("thinking", "redacted_thinking")

def seq(events):
    out = []
    for e in events or []:
        if e.get("type") == "content_block_start":
            try: p = json.loads(e["raw"])
            except Exception: continue
            out.append((p.get("content_block") or {}).get("type"))
    return out

def adj(t):
    return any(t[i] in T and t[i-1] in T for i in range(1, len(t)))

ids = json.load(open("/tmp/incident-session-ids.json"))
stats = {"scanned": 0, "with_servertool": 0, "created_adjacent": 0, "created_terminal": 0}
for eid in ids:
    d = json.load(urllib.request.urlopen(f"{base}/entries/{eid}"))
    atts = d.get("attempts") or []
    if not atts: continue
    up = seq((atts[-1].get("upstreamResponse") or {}).get("sseEvents"))
    cli = seq((d.get("clientResponse") or {}).get("sseEvents"))
    if not up or not cli: continue
    stats["scanned"] += 1
    stripped = len(up) - len(cli)
    if stripped > 0:
        stats["with_servertool"] += 1
    if adj(cli) and not adj(up):
        stats["created_adjacent"] += 1
        print(f"  CREATED-ADJACENT {eid}")
        print(f"     upstream: {','.join(up)}")
        print(f"     client  : {','.join(cli)}")
    if cli and cli[-1] in T and not (up and up[-1] in T):
        stats["created_terminal"] += 1
        print(f"  CREATED-TERMINAL-THINKING {eid}: {','.join(up)} -> {','.join(cli)}")
print(json.dumps(stats, indent=2))
