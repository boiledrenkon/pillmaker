#!/usr/bin/env python3
"""Image-generation backend dispatcher for the enhancement-product workflow.

Used only by the API backends (openai | gemini | replicate). The `manual`
backend never calls this — there the workflow pauses on a HumanTask and you
generate the image yourself.

Reads the final prompt from a file, optionally conditions on reference images,
and writes a single PNG to --out. Prints one JSON line: {"imagePath","ok","note"}.

    python tools/gen_image.py --backend gemini \
        --prompt-file /tmp/prompt.txt \
        --ref outputs/power_rod_11/ref_images \
        --out outputs/power_rod_11/candidates/attempt1.png

Each backend lazy-imports its SDK so the others aren't required to be installed.
Reference images may be individual files or directories (expanded recursively).
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

IMG_EXTS = {".png", ".jpg", ".jpeg", ".webp"}
DEFAULT_SIZE = "1024x1536"  # portrait blister-card aspect


def _fail(msg: str) -> int:
    print(json.dumps({"ok": False, "imagePath": None, "note": msg}), file=sys.stderr)
    return 1


def _expand_refs(refs: list[str], cap: int = 6) -> list[Path]:
    out: list[Path] = []
    for r in refs:
        p = Path(r)
        if p.is_dir():
            out += [q for q in sorted(p.rglob("*")) if q.suffix.lower() in IMG_EXTS]
        elif p.is_file() and p.suffix.lower() in IMG_EXTS:
            out.append(p)
    # de-dup, preserve order, cap (most models accept only a handful of refs)
    seen, uniq = set(), []
    for p in out:
        if p not in seen:
            seen.add(p)
            uniq.append(p)
    return uniq[:cap]


# Sibling paths for extra best-of-n candidates: attempt2.png -> attempt2b.png…
def _candidate_path(out: Path, i: int) -> Path:
    return out if i == 0 else out.with_name(f"{out.stem}{chr(ord('a') + i)}{out.suffix}")


# ---------------------------------------------------------------- OpenAI -----
def gen_openai(prompt: str, refs: list[Path], out: Path, model: str, size: str, quality: str, n: int) -> list[Path]:
    from openai import OpenAI  # noqa
    import base64

    client = OpenAI()
    # Model resolution: explicit --model wins, then OPENAI_IMAGE_MODEL env, then a
    # safe default. gpt-image-2 renders dense packaging text far better than v1.
    model = model or os.environ.get("OPENAI_IMAGE_MODEL") or "gpt-image-1"
    # gpt-image-1 quality tiers: low | medium | high | auto (cost rises with tier).
    common = {"model": model, "prompt": prompt, "size": size}
    if quality and quality != "auto":
        common["quality"] = quality

    def call(count: int):
        req = dict(common, n=count) if count > 1 else common
        if refs:
            files = [open(p, "rb") for p in refs]
            try:
                return client.images.edit(image=files, **req)
            finally:
                for f in files:
                    f.close()
        return client.images.generate(**req)

    try:
        res = call(n)
    except Exception:
        if n <= 1:
            raise
        # Some models/endpoints may not take n>1 — fall back to a single image
        # rather than failing the whole attempt.
        res = call(1)

    paths: list[Path] = []
    for i, item in enumerate(res.data):
        p = _candidate_path(out, i)
        p.write_bytes(base64.b64decode(item.b64_json))
        paths.append(p)
    return paths


# ---------------------------------------------------------------- Gemini -----
def gen_gemini(prompt: str, refs: list[Path], out: Path, model: str, size: str) -> list[Path]:
    from google import genai            # google-genai
    from google.genai import types

    client = genai.Client()  # reads GEMINI_API_KEY / GOOGLE_API_KEY
    model = model or "gemini-2.5-flash-image"
    contents: list = [prompt]
    for p in refs:
        mime = "image/png" if p.suffix.lower() == ".png" else "image/jpeg"
        contents.append(types.Part.from_bytes(data=p.read_bytes(), mime_type=mime))
    resp = client.models.generate_content(model=model, contents=contents)
    for part in resp.candidates[0].content.parts:
        inline = getattr(part, "inline_data", None)
        if inline and inline.data:
            out.write_bytes(inline.data)
            return [out]
    raise RuntimeError("Gemini returned no image part (likely a safety block or text-only reply).")


# ------------------------------------------------------------- Replicate -----
def gen_replicate(prompt: str, refs: list[Path], out: Path, model: str, size: str) -> list[Path]:
    import replicate
    import requests

    model = model or "black-forest-labs/flux-1.1-pro"
    inp: dict = {"prompt": prompt, "output_format": "png", "aspect_ratio": "2:3"}
    if refs:
        # Many Flux/SDXL models take a single conditioning image.
        inp["image"] = open(refs[0], "rb")
    result = replicate.run(model, input=inp)
    url = result[0] if isinstance(result, (list, tuple)) else result
    url = getattr(url, "url", url)  # FileOutput -> url
    out.write_bytes(requests.get(str(url), timeout=120).content)
    return [out]


# gemini/replicate take neither an OpenAI-style quality tier nor n>1 (they
# always produce one candidate); absorb+ignore both.
def _drop_quality(fn):
    def wrapped(prompt, refs, out, model, size, quality, n):  # noqa: ARG001
        return fn(prompt, refs, out, model, size)
    return wrapped


BACKENDS = {
    "openai": gen_openai,
    "gemini": _drop_quality(gen_gemini),
    "replicate": _drop_quality(gen_replicate),
}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--backend", required=True, choices=sorted(BACKENDS))
    ap.add_argument("--prompt-file", required=True)
    ap.add_argument("--ref", action="append", default=[], help="file or dir; repeatable")
    ap.add_argument("--out", required=True)
    ap.add_argument("--model", default="", help="override model id")
    ap.add_argument("--size", default=DEFAULT_SIZE)
    ap.add_argument("--quality", default=os.environ.get("IMG_QUALITY", "medium"),
                    help="openai gpt-image-1 tier: low|medium|high|auto (env IMG_QUALITY)")
    ap.add_argument("--n", type=int, default=int(os.environ.get("IMG_N", "1") or 1),
                    help="candidates per attempt, best-of-n (openai only; env IMG_N)")
    args = ap.parse_args()
    n = max(1, min(4, args.n))

    prompt = Path(args.prompt_file).read_text(encoding="utf-8").strip()
    if not prompt:
        return _fail("empty prompt file")
    refs = _expand_refs(args.ref)
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)

    try:
        paths = BACKENDS[args.backend](prompt, refs, out, args.model, args.size, args.quality, n)
    except ImportError as e:
        return _fail(f"SDK for backend '{args.backend}' not installed: {e}. "
                     f"pip install the backend SDK (openai | google-genai | replicate).")
    except Exception as e:  # noqa: BLE001 — surface any backend error to the agent
        return _fail(f"{args.backend} generation failed: {type(e).__name__}: {e}")

    paths = [p for p in paths if p.exists() and p.stat().st_size >= 1000]
    if not paths:
        return _fail("backend produced no usable image file")
    print(json.dumps({"ok": True, "imagePath": str(paths[0]),
                      "candidates": [str(p) for p in paths],
                      "note": f"{args.backend} wrote {len(paths)} candidate(s) "
                              f"using {len(refs)} reference image(s)."}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
