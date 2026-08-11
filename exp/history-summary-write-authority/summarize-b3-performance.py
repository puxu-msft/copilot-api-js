import json
from pathlib import Path

root = Path(__file__).parent
payloads = {"small": 64, "large": 262144}
records = {}
for refs in (0, 4, 32):
    records[str(refs)] = {}
    for label in payloads:
        path = root / f"b3-perf-refs{refs}-{label}.json"
        records[str(refs)][label] = json.loads(path.read_text())

summary = {
    "scope": "B3 EXPLAIN and local in-memory timing observations; no threshold and no zero-regression claim",
    "environment": records["0"]["small"]["environment"],
    "matrix": {"rows": 512, "refs": [0, 4, 32], "payloadBytes": payloads, "queries": ["get", "list", "session", "stats"]},
    "explain": {},
    "timingSummaryUsPerExecution": {},
    "payloadSizeComparison": {},
    "rawFiles": [],
}
for refs, by_size in records.items():
    summary["explain"][refs] = {}
    summary["timingSummaryUsPerExecution"][refs] = {}
    summary["payloadSizeComparison"][refs] = {}
    for label, record in by_size.items():
        summary["rawFiles"].append(f"b3-perf-refs{refs}-{label}.json")
        summary["timingSummaryUsPerExecution"][refs][label] = {
            query: result["summaryUsPerExecution"] for query, result in record["results"].items()
        }
        if label == "large":
            summary["explain"][refs] = {
                query: result["explain"] for query, result in record["results"].items()
            }
    for query in ("get", "list", "session", "stats"):
        small = by_size["small"]["results"][query]["summaryUsPerExecution"]
        large = by_size["large"]["results"][query]["summaryUsPerExecution"]
        summary["payloadSizeComparison"][refs][query] = {
            "baselineMedianDeltaLargeMinusSmallUs": large["baselineMedian"] - small["baselineMedian"],
            "integrityMedianDeltaLargeMinusSmallUs": large["integrityMedian"] - small["integrityMedian"],
            "note": "Observed delta only; no threshold or equivalence claim.",
        }

all_plans = [
    shape
    for refs in summary["explain"].values()
    for query in refs.values()
    for shape in query.values()
]
summary["planFacts"] = {
    "anyManifestPayloadNamed": any(item["manifestPayloadNamed"] for item in all_plans),
    "allIntegrityOperationsCoveringIndex": all(
        query["integrity"]["operationsCoveringIndex"]
        for refs in summary["explain"].values()
        for query in refs.values()
    ),
    "allIntegrityCorrelatedRefsScan": all(
        query["integrity"]["correlatedRefsScan"]
        for refs in summary["explain"].values()
        for query in refs.values()
    ),
    "allIntegrityRefsIndexSearch": all(
        query["integrity"]["refsIndexSearch"]
        for refs in summary["explain"].values()
        for query in refs.values()
    ),
}
summary["limitations"] = [
    "In-memory Bun 1.3.14 PoC; not a production benchmark.",
    "The correlated anti-join is per candidate summary row and scales with normalized refs.",
    "Covering-index EXPLAIN and omitted projection show no manifest payload access in this query shape; they do not prove every future query avoids blobs.",
    "B3 does not stop ordinary SQL from rewriting both canonical and derived validation state; it cannot replace an authority boundary.",
]
(root / "b3-performance-summary.json").write_text(json.dumps(summary, indent=2) + "\n")
