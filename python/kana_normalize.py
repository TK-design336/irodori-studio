#!/usr/bin/env python3
"""Normalize text to kana for ASR CER matching.

Input (stdin): JSON {"texts": ["...", ...]} or {"text": "..."}
  or {"mode":"cer","expected":"...","actual":"..."}
Output (stdout): JSON only (no log noise).
"""
from __future__ import annotations

import contextlib
import json
import os
import re
import sys
import unicodedata

try:
    from alkana import get_kana
except Exception:  # noqa: BLE001
    get_kana = None  # type: ignore

try:
    import pyopenjtalk
except Exception:  # noqa: BLE001
    pyopenjtalk = None

WORD_RE = re.compile(r"[A-Za-z]+(?:'[A-Za-z]+)?")
PUNCT_RE = re.compile(
    r"[、。，．,.!?！？:：;；'\"「」『』（）()\[\]{}…・ー\-–—~/\\|*&^%$#@`＋+=<>]"
)

_OPENJTALK_READY = False


@contextlib.contextmanager
def _silence_stdio():
    """pyopenjtalk may print dictionary download progress to stdout."""
    old_out, old_err = sys.stdout, sys.stderr
    try:
        with open(os.devnull, "w", encoding="utf-8") as devnull:
            sys.stdout = devnull
            sys.stderr = devnull
            yield
    finally:
        sys.stdout = old_out
        sys.stderr = old_err


def _ensure_openjtalk() -> None:
    global _OPENJTALK_READY
    if _OPENJTALK_READY or pyopenjtalk is None:
        return
    with _silence_stdio():
        try:
            pyopenjtalk.g2p("あ", kana=True)
        except Exception:  # noqa: BLE001
            pass
    _OPENJTALK_READY = True


def _hiragana_to_katakana(s: str) -> str:
    out = []
    for ch in s:
        o = ord(ch)
        if 0x3041 <= o <= 0x3096:
            out.append(chr(o + 0x60))
        else:
            out.append(ch)
    return "".join(out)


def _english_to_katakana(text: str) -> str:
    if get_kana is None:
        return text

    def repl(m: re.Match[str]) -> str:
        word = m.group(0)
        kana = get_kana(word)
        return kana if kana else word

    return WORD_RE.sub(repl, text)


def _g2p_kana(text: str) -> str:
    """Convert Japanese (kanji etc.) to katakana reading."""
    if not text:
        return ""
    if pyopenjtalk is None:
        return _hiragana_to_katakana(text)
    _ensure_openjtalk()
    try:
        with _silence_stdio():
            kana = pyopenjtalk.g2p(text, kana=True)
        return kana.replace(" ", "")
    except Exception:  # noqa: BLE001
        return _hiragana_to_katakana(text)


def normalize_kana(text: str) -> str:
    t = unicodedata.normalize("NFKC", text or "")
    t = _english_to_katakana(t)
    t = _g2p_kana(t)
    t = _hiragana_to_katakana(t)
    t = t.replace("ー", "").replace("ｰ", "")
    t = t.replace("ヲ", "オ")
    t = t.replace("ヅ", "ズ").replace("ヂ", "ジ")
    t = PUNCT_RE.sub("", t)
    t = re.sub(r"\s+", "", t)
    cleaned = []
    for ch in t:
        o = ord(ch)
        if 0x30A0 <= o <= 0x30FF or ch in "ヴヵヶ":
            cleaned.append(ch)
        elif "0" <= ch <= "9":
            cleaned.append(ch)
    return "".join(cleaned)


def char_error_rate(expected: str, actual: str) -> float:
    exp = list(expected)
    act = list(actual)
    if not exp:
        return 0.0 if not act else 1.0
    prev = list(range(len(act) + 1))
    for i, ec in enumerate(exp, 1):
        cur = [i]
        for j, ac in enumerate(act, 1):
            ins = cur[j - 1] + 1
            delete = prev[j] + 1
            sub = prev[j - 1] + (0 if ec == ac else 1)
            cur.append(min(ins, delete, sub))
        prev = cur
    return prev[-1] / len(exp)


def _emit(obj: dict) -> None:
    sys.stdout.write(json.dumps(obj, ensure_ascii=False))
    sys.stdout.write("\n")
    sys.stdout.flush()


def main() -> int:
    try:
        sys.stdin.reconfigure(encoding="utf-8")
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:  # noqa: BLE001
        pass

    raw = sys.stdin.read()
    if not raw.strip():
        _emit({"results": []})
        return 0

    data = json.loads(raw)
    mode = data.get("mode", "normalize")
    if mode == "cer":
        expected = normalize_kana(str(data.get("expected", "")))
        actual = normalize_kana(str(data.get("actual", "")))
        cer = char_error_rate(expected, actual)
        _emit(
            {
                "expectedKana": expected,
                "actualKana": actual,
                "cer": cer,
            }
        )
        return 0

    texts = data.get("texts")
    if texts is None:
        texts = [str(data.get("text", ""))]
    results = [{"raw": t, "kana": normalize_kana(str(t))} for t in texts]
    _emit({"results": results})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
