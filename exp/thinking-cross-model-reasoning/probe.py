#!/usr/bin/env python3
import argparse
import hashlib
import json
import urllib.error
import urllib.request


def post(base_url: str, body: dict) -> tuple[int, dict]:
    request = urllib.request.Request(
        f"{base_url.rstrip('/')}/responses",
        data=json.dumps(body).encode(),
        headers={"content-type": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            return response.status, json.loads(response.read())
    except urllib.error.HTTPError as error:
        return error.code, {"error_type": "http_error"}


def visible_text(response: dict) -> str:
    return "".join(
        part.get("text", "")
        for output in response.get("output", [])
        if output.get("type") == "message"
        for part in output.get("content", [])
        if part.get("type") == "output_text"
    )


def replay(base_url: str, model: str, encrypted_content: str | None) -> dict:
    reasoning = {"type": "reasoning", "summary": []}
    if encrypted_content is not None:
        reasoning["encrypted_content"] = encrypted_content
    status, response = post(
        base_url,
        {
            "model": model,
            "stream": False,
            "max_output_tokens": 64,
            "reasoning": {"effort": "low", "summary": "auto"},
            "input": [
                reasoning,
                {
                    "type": "message",
                    "role": "user",
                    "content": [
                        {
                            "type": "input_text",
                            "text": "Repeat exactly the integer computed in the preceding reasoning item. Output only that integer; if unavailable output UNKNOWN.",
                        }
                    ],
                },
            ],
        },
    )
    return {
        "http": status,
        "model": response.get("model"),
        "status": response.get("status"),
        "text": visible_text(response),
        **({"error_type": response["error_type"]} if "error_type" in response else {}),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", required=True)
    parser.add_argument("--model-a", required=True)
    parser.add_argument("--model-b", required=True)
    args = parser.parse_args()

    status, first = post(
        args.base_url,
        {
            "model": args.model_a,
            "stream": False,
            "max_output_tokens": 64,
            "reasoning": {"effort": "low", "summary": "auto"},
            "input": [
                {
                    "type": "message",
                    "role": "user",
                    "content": [{"type": "input_text", "text": "Compute 17*19, then answer only the number."}],
                }
            ],
        },
    )
    reasoning = next(
        (
            item
            for item in first.get("output", [])
            if item.get("type") == "reasoning" and isinstance(item.get("encrypted_content"), str)
        ),
        None,
    )
    if status != 200 or reasoning is None:
        raise SystemExit(json.dumps({"http": status, "error_type": first.get("error_type"), "reasoning_found": reasoning is not None}))

    encrypted = reasoning["encrypted_content"]
    results = {
        "initial": {
            "http": status,
            "model": first.get("model"),
            "status": first.get("status"),
            "text": visible_text(first),
            "summary_count": len(reasoning.get("summary", [])),
            "encrypted_present": True,
            "encrypted_sha256": hashlib.sha256(encrypted.encode()).hexdigest(),
        },
        "comparisons": {
            "A-with-A-encrypted": replay(args.base_url, args.model_a, encrypted),
            "A-without-encrypted": replay(args.base_url, args.model_a, None),
            "B-with-A-encrypted": replay(args.base_url, args.model_b, encrypted),
            "B-without-encrypted": replay(args.base_url, args.model_b, None),
        },
    }
    print(json.dumps(results, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
