#!/usr/bin/env python3
"""
AskUserQuestion `questions` decode 线上诊断（Step 0 确诊用）。

用法: python3 exp/askuserquestion-decode-check/check.py [port] [limit]
扫最近 N 条 live history entry,对每个响应产出 AskUserQuestion tool_use 的 entry,
重建 raw 上游 vs forwarded(客户端实收) 两条流里 `questions` 的类型:
  - raw=str, fwd=array  -> decode 正常(已修)
  - raw=str, fwd=str    -> decode 未触发(BUG 复现,抓这个 id 深挖)
  - raw=array           -> 上游本就发数组(本案不适用)
"""
import sys, json, urllib.request
PORT = sys.argv[1] if len(sys.argv) > 1 else "4141"
LIMIT = int(sys.argv[2]) if len(sys.argv) > 2 else 120
BASE = f"http://localhost:{PORT}"

def get(path):
    return json.load(urllib.request.urlopen(BASE + path, timeout=8))

def block_questions(events, name="AskUserQuestion"):
    """return list of (index, questions_value) for tool_use blocks of `name`."""
    starts, chunks = {}, {}
    for ev in events or []:
        raw = ev.get("raw")
        if not isinstance(raw, str): continue
        try: p = json.loads(raw)
        except: continue
        t = p.get("type")
        if t == "content_block_start":
            cb = p.get("content_block") or {}
            if cb.get("type") == "tool_use" and cb.get("name") == name:
                starts[p.get("index")] = True; chunks[p.get("index")] = []
        elif t == "content_block_delta":
            i = p.get("index")
            if i in starts and (p.get("delta") or {}).get("type") == "input_json_delta":
                chunks[i].append(p["delta"].get("partial_json", ""))
    out = []
    for i in starts:
        try: inp = json.loads("".join(chunks[i]))
        except: out.append((i, "<unparsable-input>")); continue
        out.append((i, inp.get("questions", "<absent>")))
    return out

def qtype(v):
    if isinstance(v, list): return f"array[{len(v)}]"
    if isinstance(v, str): return f"string(len={len(v)})"
    return type(v).__name__

ids = [e["id"] for e in get(f"/history/api/entries?limit={LIMIT}")["entries"]]
hits = 0
for eid in ids:
    try: d = get(f"/history/api/entries/{eid}")
    except: continue
    raw = block_questions(d.get("sseEvents"))
    if not raw: continue
    fwd = block_questions((d.get("inboundResponse") or {}).get("sseEvents"))
    fwd_by_idx = dict(fwd)
    for idx, rq in raw:
        fq = fwd_by_idx.get(idx, "<missing>")
        verdict = "OK(decoded)" if isinstance(rq, str) and isinstance(fq, list) else \
                  "BUG(not decoded)" if isinstance(rq, str) and isinstance(fq, str) else \
                  "n/a(upstream array)" if isinstance(rq, list) else "?"
        print(f"{eid} block#{idx}: raw={qtype(rq)} fwd={qtype(fq)} -> {verdict}")
        hits += 1
if hits == 0:
    print(f"最近 {LIMIT} 条无'响应产出 AskUserQuestion tool_use'的 entry(现象间歇,多跑几次或加大 limit)")
