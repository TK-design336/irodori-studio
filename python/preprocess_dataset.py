#!/usr/bin/env python3
"""Build local_dataset.jsonl from sliced WAVs for speaker inversion."""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


def emit_fraction(i: int, n: int, detail: str = "") -> None:
    frac = (i / n) if n else 1.0
    payload = {"fraction": frac, "current": i, "total": n}
    if detail:
        payload["detail"] = detail
    print(f"PROGRESS\t{json.dumps(payload, ensure_ascii=False)}", flush=True)


def main() -> int:
    parser = argparse.ArgumentParser(description="Build local_dataset.jsonl")
    parser.add_argument("--sliced-dir", required=True)
    parser.add_argument("--output-jsonl", required=True)
    parser.add_argument("--text", default="音声")
    args = parser.parse_args()

    sliced_dir = Path(args.sliced_dir)
    out_jsonl = Path(args.output_jsonl)
    if not sliced_dir.is_dir():
        print(f"ERROR: sliced dir not found: {sliced_dir}", file=sys.stderr)
        return 1

    wavs = sorted(p for p in sliced_dir.iterdir() if p.suffix.lower() == ".wav")
    out_jsonl.parent.mkdir(parents=True, exist_ok=True)
    n = len(wavs)
    emit_fraction(0, n)
    count = 0
    with out_jsonl.open("w", encoding="utf-8") as f:
        for i, fname in enumerate(wavs, start=1):
            row = {"audio": {"path": str(fname.resolve())}, "text": args.text}
            f.write(json.dumps(row, ensure_ascii=False) + "\n")
            count += 1
            if i == n or i % 10 == 0:
                emit_fraction(i, n, fname.name)

    print(f"DONE: wrote {count} row(s) to {out_jsonl}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
