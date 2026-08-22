#!/usr/bin/env python3
"""Detect numbers, units, dates, times, and related spans in Japanese text."""
from __future__ import annotations

import re
import unicodedata

from numeric_convert import candidates_for_number, normalize_ascii_digits

# Order matters: longer / more specific patterns first
PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    ("version", re.compile(r"(?i)v\d+(?:\.\d+)+")),
    ("time_jp", re.compile(r"[0-9０-９]{1,2}時[0-9０-９]{1,2}分(?:[0-9０-９]{1,2}秒)?")),
    ("time", re.compile(r"[0-9０-９]{1,2}[:：][0-9０-９]{2}(?:[:：][0-9０-９]{2})?")),
    ("date", re.compile(r"[0-9０-９]{4}[/\-年][0-9０-９]{1,2}[/\-月][0-9０-９]{1,2}日?")),
    ("fraction_date", re.compile(r"[0-9０-９]{1,4}[/／][0-9０-９]{1,4}")),
    ("ordinal", re.compile(r"第\d+|[0-9０-９]+番目")),
    ("range", re.compile(r"\d+[〜~\-]\d+(?:本|匹|個|人|枚|冊|台|階|歳|分|秒|年|月|日)?")),
    ("counter", re.compile(r"[0-9０-９]+(?:\.\d+)?(?:本|匹|個|人|杯|枚|冊|台|階|歳|分|秒|年|月|日)")),
    ("unit_suffix", re.compile(r"[0-9０-９]+(?:\.\d+)?(?:%|％|km|kg|cm|mm|m|g|円)")),
    ("decimal", re.compile(r"[0-9０-９]+\.[0-9０-９]+")),
    ("integer", re.compile(r"[0-9０-９]+")),
]

COUNTER_RE = re.compile(
    r"^([0-9０-９]+(?:\.\d+)?)(本|匹|個|人|杯|枚|冊|台|階|歳|分|秒|年|月|日)$"
)
UNIT_SUFFIX_RE = re.compile(r"^([0-9０-９]+(?:\.\d+)?)(%|％|km|kg|cm|mm|m|g|円)$")
ORDINAL_RE = re.compile(r"^第(\d+)|^([0-9０-９]+)番目$")


def _char_len(s: str) -> int:
    return len(s)


def _extract_parts(surface: str, kind: str) -> tuple[str, str]:
    m = COUNTER_RE.match(surface)
    if m:
        return normalize_ascii_digits(m.group(1)), m.group(2)
    m = UNIT_SUFFIX_RE.match(surface)
    if m:
        return normalize_ascii_digits(m.group(1)), m.group(2)
    m = ORDINAL_RE.match(surface)
    if m:
        num = m.group(1) or m.group(2) or ""
        return normalize_ascii_digits(num), ""
    digits = re.findall(r"[0-9０-９]+(?:\.[0-9０-９]+)?", surface)
    if digits:
        return normalize_ascii_digits(digits[0]), ""
    return surface, ""


def detect(text: str) -> list[dict]:
    if not text:
        return []

    used = [False] * _char_len(text)
    hits: list[dict] = []

    for kind, pattern in PATTERNS:
        for m in pattern.finditer(text):
            start, end = m.start(), m.end()
            if any(used[start:end]):
                continue
            surface = m.group(0)
            num_part, unit_part = _extract_parts(surface, kind)
            cands = candidates_for_number(surface, num_part, unit_part, kind)
            if kind == "version":
                cands = [
                    {
                        "reading": "バージョン" + num_part.replace(".", "てん"),
                        "label": "バージョン",
                    }
                ]
            elif kind == "ordinal":
                cands = [
                    {"reading": "だい" + num_part, "label": "序数"},
                    {"reading": num_part + "ばんめ", "label": "番目"},
                ]
            elif kind == "range":
                cands = [{"reading": surface, "label": "範囲"}]
            elif kind == "time_jp":
                cands = candidates_for_number(surface, num_part, unit_part, "time")
            elif kind == "date":
                cands = candidates_for_number(surface, num_part, unit_part, "date")

            if not cands:
                continue

            for i in range(start, end):
                used[i] = True
            hits.append(
                {
                    "kind": "numeric",
                    "start": start,
                    "end": end,
                    "surface": surface,
                    "candidates": cands,
                }
            )

    hits.sort(key=lambda h: h["start"])
    return hits
