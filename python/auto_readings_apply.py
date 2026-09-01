#!/usr/bin/env python3
"""Background auto-readings for TTS (manual readings take precedence)."""
from __future__ import annotations

import json
import re
import sys

import homograph_detect
from annotate_detect import _reading_extras, detect_all

_HW_KATA = re.compile(r"[\uff61-\uff9f]+")
_NET_PATTERNS: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"w{2,}", re.I), "ダブリュー"),
    (re.compile(r"https?://\S+", re.I), ""),
    (re.compile(r"@[A-Za-z0-9_]{2,}"), ""),
]


def _manual_spans(manual: list[dict]) -> list[tuple[int, int]]:
    out: list[tuple[int, int]] = []
    for m in manual or []:
        try:
            a = int(m.get("start", -1))
            b = int(m.get("end", -1))
        except (TypeError, ValueError):
            continue
        if a >= 0 and b > a:
            out.append((a, b))
    return out


def _overlaps(start: int, end: int, spans: list[tuple[int, int]]) -> bool:
    return any(start < b and a < end for a, b in spans)


def _halfwidth_katakana_to_full(s: str) -> str:
    out: list[str] = []
    for ch in s:
        code = ord(ch)
        if 0xFF61 <= code <= 0xFF9F:
            full = chr(code - 0xFF61 + 0x30A1)
            if full == "゛":
                if out:
                    out[-1] = homograph_detect.katakana_to_hiragana(out[-1] + "゛")
                continue
            if full == "゜":
                if out:
                    out[-1] = homograph_detect.katakana_to_hiragana(out[-1] + "゜")
                continue
            out.append(homograph_detect.katakana_to_hiragana(full))
        else:
            out.append(ch)
    return "".join(out)


def _add_halfwidth_katakana(
    text: str,
    readings: list[dict],
    blocked: list[tuple[int, int]],
) -> None:
    spans = blocked + [(r["start"], r["end"]) for r in readings]
    for m in _HW_KATA.finditer(text):
        start, end = m.start(), m.end()
        if _overlaps(start, end, spans):
            continue
        surface = m.group(0)
        reading = _halfwidth_katakana_to_full(surface)
        if reading and reading != surface:
            readings.append(
                {
                    "kind": "english",
                    "start": start,
                    "end": end,
                    "surface": surface,
                    "reading": reading,
                }
            )
            spans.append((start, end))


def _add_net_patterns(
    text: str,
    readings: list[dict],
    blocked: list[tuple[int, int]],
) -> None:
    spans = blocked + [(r["start"], r["end"]) for r in readings]
    for pat, reading in _NET_PATTERNS:
        for m in pat.finditer(text):
            start, end = m.start(), m.end()
            if _overlaps(start, end, spans):
                continue
            readings.append(
                {
                    "kind": "english",
                    "start": start,
                    "end": end,
                    "surface": m.group(0),
                    "reading": reading,
                }
            )
            spans.append((start, end))


def _dict_surface_readings(
    text: str,
    reading_dict: list[dict],
    blocked: list[tuple[int, int]],
) -> list[dict]:
    extras = _reading_extras(reading_dict)
    out: list[dict] = []
    spans = list(blocked)
    for kind in ("english", "numeric"):
        bucket = extras.get(kind) or {}
        ordered = sorted(bucket.items(), key=lambda kv: len(kv[0]), reverse=True)
        for surface, readings in ordered:
            if not surface or not readings:
                continue
            start = 0
            while True:
                idx = text.find(surface, start)
                if idx < 0:
                    break
                end = idx + len(surface)
                if not _overlaps(idx, end, spans):
                    out.append(
                        {
                            "kind": kind,
                            "start": idx,
                            "end": end,
                            "surface": surface,
                            "reading": readings[0],
                        }
                    )
                    spans.append((idx, end))
                start = idx + 1
    return out


def _pick_auto_from_annotations(
    text: str,
    annotations: list[dict],
    blocked: list[tuple[int, int]],
) -> list[dict]:
    out: list[dict] = []
    spans = list(blocked)
    for a in annotations:
        kind = str(a.get("kind") or "")
        if kind == "heteronym":
            continue
        start = int(a["start"])
        end = int(a["end"])
        if _overlaps(start, end, spans):
            continue
        cands = a.get("candidates") or []
        if not cands:
            continue
        reading = None
        if kind == "english":
            if len(cands) == 1:
                reading = str(cands[0].get("reading") or "")
            elif cands[0].get("label") != "辞書":
                reading = str(cands[0].get("reading") or "")
        elif kind == "numeric":
            if len(cands) == 1:
                reading = str(cands[0].get("reading") or "")
            elif cands and cands[0].get("label") != "辞書":
                reading = str(cands[0].get("reading") or "")
        if reading and reading.strip():
            if kind == "heteronym":
                reading = homograph_detect.katakana_to_hiragana(reading)
            out.append(
                {
                    "kind": kind,
                    "start": start,
                    "end": end,
                    "surface": a.get("surface") or text[start:end],
                    "reading": reading.strip(),
                }
            )
            spans.append((start, end))
    return out


def auto_readings(
    text: str,
    manual: list[dict],
    reading_dict: list[dict],
) -> list[dict]:
    blocked = _manual_spans(manual)
    annotations = detect_all(text, [], reading_dict)
    out: list[dict] = []
    out.extend(_dict_surface_readings(text, reading_dict, blocked))
    blocked = blocked + [(r["start"], r["end"]) for r in out]
    out.extend(_pick_auto_from_annotations(text, annotations, blocked))
    blocked = blocked + [(r["start"], r["end"]) for r in out]
    _add_halfwidth_katakana(text, out, blocked)
    blocked = blocked + [(r["start"], r["end"]) for r in out]
    _add_net_patterns(text, out, blocked)
    out.sort(key=lambda r: (r["start"], r["end"]))
    return out


def main() -> int:
    try:
        sys.stdin.reconfigure(encoding="utf-8")
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:  # noqa: BLE001
        pass

    raw = sys.stdin.read()
    if not raw.strip():
        print(json.dumps({"readings": []}, ensure_ascii=False))
        return 0

    data = json.loads(raw)
    text = str(data.get("text", ""))
    manual = data.get("manualReadings") or data.get("manual_readings") or []
    reading_dict = data.get("readingDict") or data.get("reading_dict") or []
    readings = auto_readings(
        text,
        manual if isinstance(manual, list) else [],
        reading_dict if isinstance(reading_dict, list) else [],
    )
    print(json.dumps({"readings": readings}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
