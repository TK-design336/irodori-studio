#!/usr/bin/env python3
"""Detect English words and suggest katakana via alkana.get_kana.

Input (stdin): JSON {"text": "..."} or raw plain text
Output (stdout): JSON array [{word, kana|null, start, end}]
  start/end are Unicode code-point offsets into the input text.
"""
from __future__ import annotations

import json
import re
import sys

from alkana import get_kana

WORD_RE = re.compile(r"[A-Za-z]+(?:'[A-Za-z]+)?")


def suggest(text: str) -> list[dict]:
    out: list[dict] = []
    for m in WORD_RE.finditer(text):
        word = m.group(0)
        kana = get_kana(word)
        out.append(
            {
                "word": word,
                "kana": kana,
                "start": m.start(),
                "end": m.end(),
            }
        )
    return out


def main() -> int:
    # Windows 既定コードページだと JSON 内のカタカナが壊れるため UTF-8 固定
    try:
        sys.stdin.reconfigure(encoding="utf-8")
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:  # noqa: BLE001
        pass

    raw = sys.stdin.read()
    if not raw.strip():
        print("[]")
        return 0
    try:
        data = json.loads(raw)
        text = data["text"] if isinstance(data, dict) else str(data)
    except json.JSONDecodeError:
        text = raw
    print(json.dumps(suggest(text), ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
