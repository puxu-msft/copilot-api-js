"""Quantify the tool_search injection: what it costs vs what it buys.

Benefit  = prompt tokens saved by NOT inlining deferred tools' schemas.
Cost     = the tool_search round-trips the model actually spends (server_tool_use +
           result + the extra thinking segment), plus the whole mechanism chain.

All offline — reads history only, burns nothing.
"""
import json, urllib.request, collections
base = "http://localhost:4141/history/api"

def get(u):
    return json.load(urllib.request.urlopen(u))

# page back far enough for a representative sample of claude turns with tools
entries, cursor = [], None
for _ in range(6):
    d = get(f"{base}/entries?limit=500" + (f"&cursor={cursor}" if cursor else ""))
    es = d.get("entries") or []
    if not es: break
    entries += es
    cursor = d.get("nextCursor")
    if not cursor: break

claude = [e for e in entries if (e.get("responseModel") or e.get("requestModel") or "").startswith("claude")]
print(f"paged {len(entries)} entries, {len(claude)} claude turns")

stats = collections.Counter()
deferred_chars, total_tool_chars, searched = [], [], []
sample = claude[:120]
for e in sample:
    try:
        d = get(f"{base}/entries/{e['id']}")
    except Exception:
        continue
    atts = d.get("attempts") or []
    if not atts: continue
    ur = atts[-1].get("upstreamRequest") or {}
    tools = (ur.get("body") or {}).get("tools") or ur.get("tools") or []
    if not tools:
        stats["no_tools"] += 1
        continue
    stats["with_tools"] += 1
    has_ts = any(str(t.get("type", "")).startswith("tool_search") for t in tools)
    if has_ts: stats["tool_search_injected"] += 1
    dfr = [t for t in tools if t.get("defer_loading") is True]
    if dfr:
        stats["has_deferred"] += 1
        deferred_chars.append(sum(len(json.dumps(t)) for t in dfr))
        total_tool_chars.append(sum(len(json.dumps(t)) for t in tools))
    # did the model ACTUALLY use tool_search this turn?
    up = atts[-1].get("upstreamResponse") or {}
    usage = up.get("usage") or {}
    stu = (usage.get("server_tool_use") or {}) if isinstance(usage.get("server_tool_use"), dict) else {}
    n = stu.get("tool_search_requests") or 0
    blob = "".join(ev.get("raw", "") for ev in (up.get("sseEvents") or []))
    used = n > 0 or "tool_search_tool_result" in blob
    if used:
        stats["tool_search_ACTUALLY_used"] += 1
        searched.append(e["id"])

print(json.dumps(dict(stats), indent=2))
if deferred_chars:
    import statistics as st
    print(f"\ndeferred schema chars/turn: median={st.median(deferred_chars):.0f} mean={st.mean(deferred_chars):.0f} max={max(deferred_chars)}")
    print(f"total tools chars/turn    : median={st.median(total_tool_chars):.0f}")
    ratio = st.median(deferred_chars) / st.median(total_tool_chars)
    print(f"deferred share of tool payload: {ratio:.1%}")
    print(f"rough token estimate (chars/3.5): ~{st.median(deferred_chars)/3.5:.0f} tok/turn saved")
print(f"\nturns that actually invoked tool_search: {searched[:5]}")
