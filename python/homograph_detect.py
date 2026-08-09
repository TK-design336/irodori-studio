#!/usr/bin/env python3
"""Detect likely homographs (同形異音) in Japanese text.

Primary strategy: morphological tokenize (pyopenjtalk/MeCab) → for each
token that contains kanji, look up the exact surface in the bundled /
user dictionary. This avoids false hits like 気 inside 元気.

Fallback (no MeCab): longest-match substring, but only for surfaces with
length >= 2 (single-kanji never substring-matched).

Input (stdin): JSON {
  "text": "...",
  "extraEntries": [{"surface": "今日", "note": "任意メモ"}, ...],
}
Output: JSON {"hits": [{"surface": "...", "start": 0, "end": 2, "note": "..."}]}
"""
from __future__ import annotations

import json
import re
import sys
from functools import lru_cache
from pathlib import Path

try:
    import pyopenjtalk
except Exception:  # noqa: BLE001
    pyopenjtalk = None

KANJI_RE = re.compile(r"[\u4e00-\u9fff]")

# Seed list when JSON is missing (readings filled from JSON when present)
FALLBACK_AMBIGUOUS = {
    "今日",
    "明日",
    "昨日",
    "行方",
    "人気",
    "生物",
    "市場",
    "風車",
    "上手",
    "下手",
    "一筋",
    "一日",
    "二人",
    "日本",
    "開く",
    "入る",
    "行く",
    "言う",
    "辛い",
    "早い",
    "高い",
    "長い",
    "強い",
    "空く",
    "空",
    "雨",
    "気",
    "方",
    "角",
    "通",
    "生",
    "行",
    "作法",
    "係る",
}


def _data_dirs() -> list[Path]:
    here = Path(__file__).resolve().parent
    # Release layout: $RESOURCE/python/*.py + $RESOURCE/data/*.json
    # Dev layout:     <repo>/python/*.py + <repo>/data/*.json
    candidates = [
        here.parent / "data",
        here / "data",
        Path.cwd() / "data",
    ]
    out: list[Path] = []
    for p in candidates:
        if p.is_dir() and p not in out:
            out.append(p)
    return out


@lru_cache(maxsize=1)
def _load_bundled() -> dict[str, dict]:
    """surface -> {readings: list[str]}"""
    by_surface: dict[str, dict] = {}

    def merge_file(path: Path) -> None:
        if not path.is_file():
            return
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except Exception:  # noqa: BLE001
            return
        for e in data.get("entries") or []:
            surface = str(e.get("surface") or "").strip()
            if not surface:
                continue
            readings = [
                str(r).strip()
                for r in (e.get("readings") or [])
                if str(r).strip()
            ]
            prev = by_surface.get(surface)
            if prev is None:
                by_surface[surface] = {"readings": readings}
            elif len(readings) > len(prev["readings"]):
                prev["readings"] = readings

    for d in _data_dirs():
        merge_file(d / "homographs_ndl_seed.json")
        merge_file(d / "homographs_runtime.json")

    for s in FALLBACK_AMBIGUOUS:
        by_surface.setdefault(s, {"readings": []})

    return by_surface


def _readings_note(readings: list[str], chosen: str | None = None) -> str:
    uniq: list[str] = []
    seen: set[str] = set()
    for r in readings:
        if r and r not in seen:
            seen.add(r)
            uniq.append(r)
    if chosen:
        c = chosen.strip()
        if c and c not in seen:
            uniq.insert(0, c)
    if not uniq:
        return "読み候補あり"
    return " / ".join(uniq)


def _dict_note(memo: str | None) -> str:
    memo = (memo or "").strip()
    return f"辞書: {memo}" if memo else "辞書"


def _tokenize(text: str) -> list[tuple[int, int, str, str]]:
    """Return [(start, end, surface, reading), ...] via OpenJTalk frontend."""
    if pyopenjtalk is None or not text:
        return []
    try:
        features = pyopenjtalk.run_frontend(text)
    except Exception:  # noqa: BLE001
        return []

    tokens: list[tuple[int, int, str, str]] = []
    offset = 0
    for feat in features:
        surface = ""
        reading = ""
        if isinstance(feat, dict):
            surface = str(feat.get("string") or feat.get("surface") or "")
            reading = str(feat.get("pron") or feat.get("reading") or "")
        elif isinstance(feat, (list, tuple)) and len(feat) >= 1:
            surface = str(feat[0])
            if len(feat) >= 10:
                reading = str(feat[9] or feat[8] or "")
        if not surface:
            continue
        idx = text.find(surface, offset)
        if idx < 0:
            # Alignment fallback: advance by surface length from offset
            idx = offset
            if idx + len(surface) > len(text) or text[idx : idx + len(surface)] != surface:
                offset += len(surface)
                continue
        end = idx + len(surface)
        tokens.append((idx, end, surface, reading))
        offset = end
    return tokens


def _mark_spans_multi(
    text: str,
    surfaces: list[tuple[str, str]],
    used: list[bool],
) -> list[dict]:
    """Longest-first substring match for surfaces with len >= 2 only."""
    hits: list[dict] = []
    ordered = sorted(
        [(s, n) for s, n in surfaces if len(s) >= 2],
        key=lambda x: len(x[0]),
        reverse=True,
    )
    for surface, note in ordered:
        start = 0
        while True:
            idx = text.find(surface, start)
            if idx < 0:
                break
            end = idx + len(surface)
            if not any(used[idx:end]):
                for i in range(idx, end):
                    used[i] = True
                hits.append(
                    {
                        "surface": surface,
                        "start": idx,
                        "end": end,
                        "note": note,
                    }
                )
            start = idx + 1
    return hits


def detect(text: str, entries: list[dict]) -> list[dict]:
    used = [False] * len(text)
    hits: list[dict] = []

    # User dict: surface -> note
    user_lookup: dict[str, str] = {}
    for e in entries:
        surface = str(e.get("surface") or "").strip()
        if not surface or surface in user_lookup:
            continue
        memo = e.get("note")
        user_lookup[surface] = _dict_note(str(memo).strip() if memo else None)

    bundled = _load_bundled()
    bundled_lookup = {
        s: _readings_note(list(info.get("readings") or []))
        for s, info in bundled.items()
    }

    tokens = _tokenize(text)
    if tokens:
        # 1) User dict exact token match (incl. single kanji)
        for start, end, surface, _reading in tokens:
            if any(used[start:end]):
                continue
            if not KANJI_RE.search(surface):
                continue
            note = user_lookup.get(surface)
            if note is None:
                continue
            for i in range(start, end):
                used[i] = True
            hits.append(
                {"surface": surface, "start": start, "end": end, "note": note}
            )

        # 2) Bundled dict exact token match
        for start, end, surface, _reading in tokens:
            if any(used[start:end]):
                continue
            if not KANJI_RE.search(surface):
                continue
            note = bundled_lookup.get(surface)
            if note is None:
                continue
            for i in range(start, end):
                used[i] = True
            hits.append(
                {"surface": surface, "start": start, "end": end, "note": note}
            )

        # 3) Multi-char user entries that MeCab may have split / missed
        #    (e.g. custom compounds) — never for single-char
        user_multi = [(s, n) for s, n in user_lookup.items() if len(s) >= 2]
        hits.extend(_mark_spans_multi(text, user_multi, used))
    else:
        # No MeCab: substring fallback, multi-char only
        user_multi = [(s, n) for s, n in user_lookup.items() if len(s) >= 2]
        bundled_multi = [(s, n) for s, n in bundled_lookup.items() if len(s) >= 2]
        hits.extend(_mark_spans_multi(text, user_multi, used))
        hits.extend(_mark_spans_multi(text, bundled_multi, used))

    hits.sort(key=lambda h: h["start"])
    return hits


def main() -> int:
    try:
        sys.stdin.reconfigure(encoding="utf-8")
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:  # noqa: BLE001
        pass

    raw = sys.stdin.read()
    if not raw.strip():
        print(json.dumps({"hits": []}, ensure_ascii=False))
        return 0

    data = json.loads(raw)
    text = str(data.get("text", ""))
    entries = data.get("extraEntries") or data.get("extra_entries") or []
    if not entries:
        surfaces = data.get("extraSurfaces") or data.get("extra_surfaces") or []
        entries = [{"surface": str(s)} for s in surfaces]

    hits = detect(text, entries if isinstance(entries, list) else [])
    print(json.dumps({"hits": hits}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
