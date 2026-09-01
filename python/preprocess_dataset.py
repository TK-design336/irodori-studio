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


def load_exclusions(path: Path | None) -> set[str]:
    if path is None or not path.is_file():
        return set()
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return set()
    if not isinstance(data, dict):
        return set()
    out: set[str] = set()
    for name, meta in data.items():
        if isinstance(meta, dict) and meta.get("excluded"):
            out.add(str(name))
        elif meta is True:
            out.add(str(name))
    return out


def load_transcripts(sliced_dir: Path, wavs: list[Path]) -> dict[str, str]:
    out: dict[str, str] = {}
    tj = sliced_dir / "transcripts.json"
    if tj.is_file():
        try:
            data = json.loads(tj.read_text(encoding="utf-8"))
            if isinstance(data, dict):
                for k, v in data.items():
                    if isinstance(v, str) and v.strip():
                        out[str(k)] = v.strip()
        except (OSError, json.JSONDecodeError):
            pass
    for w in wavs:
        if w.name in out:
            continue
        side = w.with_suffix(".txt")
        if side.is_file():
            try:
                t = side.read_text(encoding="utf-8").strip()
                if t:
                    out[w.name] = t
            except OSError:
                pass
    return out


def load_diarization_exclusions(path: Path | None) -> set[str]:
    if path is None or not path.is_file():
        return set()
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return set()
    if not isinstance(data, dict) or not data.get("enabled"):
        return set()
    labels = data.get("labels")
    if not isinstance(labels, dict):
        return set()
    selected = data.get("selected")
    if not isinstance(selected, list):
        selected = []
    selected_set = {str(x) for x in selected if str(x)}
    clusters = data.get("clusters")
    known = {
        str(c)
        for c in (clusters if isinstance(clusters, list) else [])
        if str(c) and str(c) != "?"
    }
    if len(known) <= 1:
        return set()
    if not selected_set:
        return set(labels.keys())
    out: set[str] = set()
    for name, cluster in labels.items():
        if str(cluster) not in selected_set:
            out.add(str(name))
    return out


def main() -> int:
    parser = argparse.ArgumentParser(description="Build local_dataset.jsonl")
    parser.add_argument("--sliced-dir", required=True)
    parser.add_argument("--output-jsonl", required=True)
    parser.add_argument("--text", default="音声")
    parser.add_argument(
        "--exclusions-json",
        default="",
        help="slice_review/exclusions.json — excluded wavs are skipped",
    )
    parser.add_argument(
        "--diarization-json",
        default="",
        help="slice_review/diarization.json — non-selected speaker clusters are skipped",
    )
    args = parser.parse_args()

    sliced_dir = Path(args.sliced_dir)
    out_jsonl = Path(args.output_jsonl)
    if not sliced_dir.is_dir():
        print(f"ERROR: sliced dir not found: {sliced_dir}", file=sys.stderr)
        return 1

    excl_path = Path(args.exclusions_json) if args.exclusions_json.strip() else None
    if excl_path is None:
        # Default location beside sliced parent job
        candidate = sliced_dir.parent / "slice_review" / "exclusions.json"
        if candidate.is_file():
            excl_path = candidate
    excluded = load_exclusions(excl_path)
    diar_path = Path(args.diarization_json) if args.diarization_json.strip() else None
    if diar_path is None:
        candidate = sliced_dir.parent / "slice_review" / "diarization.json"
        if candidate.is_file():
            diar_path = candidate
    excluded |= load_diarization_exclusions(diar_path)

    wavs = sorted(p for p in sliced_dir.iterdir() if p.suffix.lower() == ".wav")
    transcripts = load_transcripts(sliced_dir, wavs)
    out_jsonl.parent.mkdir(parents=True, exist_ok=True)
    n = len(wavs)
    emit_fraction(0, n)
    count = 0
    skipped = 0
    with out_jsonl.open("w", encoding="utf-8") as f:
        for i, fname in enumerate(wavs, start=1):
            if fname.name in excluded:
                skipped += 1
                if i == n or i % 10 == 0:
                    emit_fraction(i, n, f"skip:{fname.name}")
                continue
            text = transcripts.get(fname.name) or args.text
            row = {"audio": {"path": str(fname.resolve())}, "text": text}
            f.write(json.dumps(row, ensure_ascii=False) + "\n")
            count += 1
            if i == n or i % 10 == 0:
                emit_fraction(i, n, fname.name)

    print(
        f"DONE: wrote {count} row(s) to {out_jsonl} (excluded {skipped})",
        flush=True,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
