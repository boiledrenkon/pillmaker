#!/usr/bin/env python3
"""Backend preflight: confirm the credentials the chosen image backend needs are
present BEFORE the workflow spends tokens composing prompts.

`manual` needs nothing (full human-in-the-loop). Every API backend needs its key.
Exits 0 and prints a JSON line on success; exits 1 with a clear message if a
required key is missing.

    python tools/preflight.py --backend gemini
"""
from __future__ import annotations

import argparse
import json
import os
import sys

# backend -> the env var that must be set for it to work
REQUIRED_KEY = {
    "manual": None,
    "openai": "OPENAI_API_KEY",
    "gemini": "GEMINI_API_KEY",
    "replicate": "REPLICATE_API_TOKEN",
}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--backend", required=True, choices=sorted(REQUIRED_KEY))
    args = ap.parse_args()

    key = REQUIRED_KEY[args.backend]
    if key is None:
        print(json.dumps({"backend": args.backend, "ok": True,
                          "message": "manual backend: no API key required."}))
        return 0

    if os.environ.get(key):
        print(json.dumps({"backend": args.backend, "ok": True,
                          "message": f"{key} is set."}))
        return 0

    # GOOGLE_API_KEY is a common alias for Gemini.
    if args.backend == "gemini" and os.environ.get("GOOGLE_API_KEY"):
        print(json.dumps({"backend": args.backend, "ok": True,
                          "message": "GOOGLE_API_KEY is set (Gemini alias)."}))
        return 0

    print(json.dumps({
        "backend": args.backend, "ok": False,
        "message": (f"Missing {key} for backend '{args.backend}'. "
                    f"Export it and re-run, or switch to backend=manual "
                    f"(full human-in-the-loop, no key needed)."),
    }), file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
