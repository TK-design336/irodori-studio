#!/usr/bin/env python3
"""Unified annotation detection: heteronym, english, numeric."""
from __future__ import annotations

import json
import re
import sys

try:
    import alkana_suggest
except ImportError:
    alkana_suggest = None  # type: ignore[assignment]
import homograph_detect
import numeric_detect


def _split_readings(raw: object) -> list[str]:
    if isinstance(raw, str):
        return [p.strip() for p in re.split(r"[/／]", raw) if p.strip()]
    if isinstance(raw, list):
        return [str(r).strip() for r in raw if str(r).strip()]
    return []


def _reading_extras(reading_dict: list[dict]) -> dict[str, dict[str, list[str]]]:
    out: dict[str, dict[str, list[str]]] = {
        "english": {},
        "heteronym": {},
        "numeric": {},
    }
    for e in reading_dict or []:
        kind = str(e.get("kind") or "").strip()
        surface = str(e.get("surface") or "").strip()
        if kind not in out or not surface:
            continue
        readings = _split_readings(e.get("reading") or e.get("readings"))
        bucket = out[kind]
        prev = bucket.get(surface, [])
        for r in readings:
            if r not in prev:
                prev.append(r)
        bucket[surface] = prev
    return out


def _merge_cands(cands: list[dict], extras: list[str]) -> list[dict]:
    out = list(cands or [])
    seen = {str(c.get("reading") or "") for c in out}
    for r in extras:
        if r and r not in seen:
            seen.add(r)
            out.append({"reading": r, "label": "辞書"})
    return out


def _overlaps(start: int, end: int, spans: list[tuple[int, int]]) -> bool:
    return any(start < b and a < end for a, b in spans)


def _add_uncovered_surfaces(
    text: str,
    kind: str,
    surfaces: dict[str, list[str]],
    annotations: list[dict],
) -> None:
    spans = [(a["start"], a["end"]) for a in annotations]
    ordered = sorted(surfaces.items(), key=lambda kv: len(kv[0]), reverse=True)
    for surface, readings in ordered:
        if not surface:
            continue
        start = 0
        while True:
            idx = text.find(surface, start)
            if idx < 0:
                break
            end = idx + len(surface)
            if not _overlaps(idx, end, spans):
                annotations.append(
                    {
                        "kind": kind,
                        "start": idx,
                        "end": end,
                        "surface": surface,
                        "candidates": [{"reading": r, "label": "辞書"} for r in readings],
                    }
                )
                spans.append((idx, end))
            start = idx + 1


def detect_all(
    text: str,
    extra_homographs: list[dict],
    reading_dict: list[dict],
) -> list[dict]:
    extras = _reading_extras(reading_dict)
    annotations: list[dict] = []

    for h in homograph_detect.detect(text, extra_homographs):
        surface = h["surface"]
        annotations.append(
            {
                "kind": "heteronym",
                "start": h["start"],
                "end": h["end"],
                "surface": surface,
                "candidates": _merge_cands(
                    h.get("candidates") or [],
                    extras["heteronym"].get(surface, []),
                ),
            }
        )

    for hit in (alkana_suggest.suggest(text) if alkana_suggest else []):
        word = hit["word"]
        kana = hit.get("kana")
        cands = [{"reading": kana}] if kana else []
        annotations.append(
            {
                "kind": "english",
                "start": hit["start"],
                "end": hit["end"],
                "surface": word,
                "candidates": _merge_cands(cands, extras["english"].get(word, [])),
            }
        )

    for h in numeric_detect.detect(text):
        surface = h["surface"]
        h["candidates"] = _merge_cands(
            h.get("candidates") or [],
            extras["numeric"].get(surface, []),
        )
        annotations.append(h)

    _add_uncovered_surfaces(text, "english", extras["english"], annotations)
    _add_uncovered_surfaces(text, "numeric", extras["numeric"], annotations)

    annotations.sort(key=lambda a: (a["start"], a["end"]))
    return annotations


def main() -> int:
    try:
        sys.stdin.reconfigure(encoding="utf-8")
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:  # noqa: BLE001
        pass

    raw = sys.stdin.read()
    if not raw.strip():
        print(json.dumps({"annotations": []}, ensure_ascii=False))
        return 0

    data = json.loads(raw)
    text = str(data.get("text", ""))
    extra = data.get("extraHomographs") or data.get("extraEntries") or []
    reading_dict = data.get("readingDict") or data.get("reading_dict") or []

    annotations = detect_all(
        text,
        extra if isinstance(extra, list) else [],
        reading_dict if isinstance(reading_dict, list) else [],
    )
    print(json.dumps({"annotations": annotations}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
