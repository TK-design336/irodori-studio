#!/usr/bin/env python3
"""Japanese number/unit reading conversion helpers."""
from __future__ import annotations

import json
import re
from functools import lru_cache
from pathlib import Path

DIGIT_HIRAGANA = {
    "0": "ぜろ",
    "1": "いち",
    "2": "に",
    "3": "さん",
    "4": "よん",
    "5": "ご",
    "6": "ろく",
    "7": "なな",
    "8": "はち",
    "9": "きゅう",
}

DIGIT_KATAKANA = {
    "0": "ゼロ",
    "1": "イチ",
    "2": "ニ",
    "3": "サン",
    "4": "ヨン",
    "5": "ゴ",
    "6": "ロク",
    "7": "ナナ",
    "8": "ハチ",
    "9": "キュウ",
}

KANJI_DIGITS = "〇零一二三四五六七八九十百千万億"
KANJI_TO_INT = {
    "〇": 0,
    "零": 0,
    "一": 1,
    "二": 2,
    "三": 3,
    "四": 4,
    "五": 5,
    "六": 6,
    "七": 7,
    "八": 8,
    "九": 9,
}

KATAKANA_MAP = str.maketrans(
    "あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめもやゆよらりるれろわをん"
    "ぁぃぅぇぉっゃゅょー",
    "アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワヲン"
    "ァィゥェォッャュョー",
)


def _data_dirs() -> list[Path]:
    here = Path(__file__).resolve().parent
    candidates = [here.parent / "data", here / "data", Path.cwd() / "data"]
    out: list[Path] = []
    for p in candidates:
        if p.is_dir() and p not in out:
            out.append(p)
    return out


@lru_cache(maxsize=1)
def _load_counter_data() -> dict:
    for d in _data_dirs():
        path = d / "counter_words.json"
        if path.is_file():
            try:
                return json.loads(path.read_text(encoding="utf-8"))
            except Exception:  # noqa: BLE001
                pass
    return {"entries": [], "units": {}}


def normalize_ascii_digits(s: str) -> str:
    return s.translate(str.maketrans("０１２３４５６７８９", "0123456789"))


def _int_to_hiragana(n: int) -> str:
    if n == 0:
        return "ぜろ"
    if n < 0:
        return "マイナス" + _int_to_hiragana(-n)
    if n < 10:
        return DIGIT_HIRAGANA[str(n)]
    if n < 100:
        tens, ones = divmod(n, 10)
        if tens == 1:
            head = "じゅう"
        else:
            head = DIGIT_HIRAGANA[str(tens)] + "じゅう"
        return head if ones == 0 else head + DIGIT_HIRAGANA[str(ones)]
    if n < 1000:
        hundreds, rem = divmod(n, 100)
        head = "ひゃく" if hundreds == 1 else DIGIT_HIRAGANA[str(hundreds)] + "ひゃく"
        if hundreds == 3:
            head = "さんびゃく"
        elif hundreds == 6:
            head = "ろっぴゃく"
        elif hundreds == 8:
            head = "はっぴゃく"
        return head if rem == 0 else head + _int_to_hiragana(rem)
    if n < 10000:
        thousands, rem = divmod(n, 1000)
        head = "せん" if thousands == 1 else DIGIT_HIRAGANA[str(thousands)] + "せん"
        if thousands == 3:
            head = "さんぜん"
        elif thousands == 8:
            head = "はっせん"
        return head if rem == 0 else head + _int_to_hiragana(rem)
    # Fallback: digit-by-digit for large numbers
    return "".join(DIGIT_HIRAGANA[d] for d in str(n))


def _int_to_kanji(n: int) -> str:
    if n == 0:
        return "零"
    if n < 10:
        return list(KANJI_TO_INT.keys())[list(KANJI_TO_INT.values()).index(n)]
    if n < 100:
        tens, ones = divmod(n, 10)
        tens_s = "十" if tens == 1 else list(KANJI_TO_INT.keys())[list(KANJI_TO_INT.values()).index(tens)] + "十"
        return tens_s if ones == 0 else tens_s + list(KANJI_TO_INT.keys())[list(KANJI_TO_INT.values()).index(ones)]
    # Simple fallback
    return str(n)


def _int_to_katakana(n: int) -> str:
    return _int_to_hiragana(n).translate(KATAKANA_MAP)


def _digit_reading(s: str, mode: str) -> str:
    s = normalize_ascii_digits(s)
    if not s.isdigit():
        return s
    n = int(s)
    if mode == "kanji":
        return _int_to_kanji(n)
    if mode == "katakana":
        return _int_to_katakana(n)
    return _int_to_hiragana(n)


DAY_READINGS = {
    1: "ついたち", 2: "ふつか", 3: "みっか", 4: "よっか", 5: "いつか",
    6: "むいか", 7: "なのか", 8: "ようか", 9: "ここのか", 10: "とおか",
    11: "じゅういちにち", 12: "じゅうににち", 13: "じゅうさんにち",
    14: "じゅうよっか", 15: "じゅうごにち", 16: "じゅうろくにち",
    17: "じゅうしちにち", 18: "じゅうはちにち", 19: "じゅうくにち",
    20: "はつか", 21: "にじゅういちにち", 22: "にじゅうににち",
    23: "にじゅうさんにち", 24: "にじゅうよっか", 25: "にじゅうごにち",
    26: "にじゅうろくにち", 27: "にじゅうしちにち", 28: "にじゅうはちにち",
    29: "にじゅうくにち", 30: "さんじゅうにち", 31: "さんじゅういちにち",
}

MONTH_READINGS = {
    1: "いちがつ", 2: "にがつ", 3: "さんがつ", 4: "しがつ",
    5: "ごがつ", 6: "ろくがつ", 7: "しちがつ", 8: "はちがつ",
    9: "くがつ", 10: "じゅうがつ", 11: "じゅういちがつ", 12: "じゅうにがつ",
}


def _day_reading(day: int) -> str:
    return DAY_READINGS.get(day, _int_to_hiragana(day) + "にち")


def _month_reading(month: int) -> str:
    return MONTH_READINGS.get(month, _int_to_hiragana(month) + "がつ")


HOUR_READINGS = {
    4: "よじ", 7: "しちじ", 9: "くじ",
}

MINUTE_SOUND_CHANGES = {
    1: "いっぷん", 3: "さんぷん", 4: "よんぷん", 6: "ろっぷん",
    8: "はっぷん", 10: "じゅっぷん",
}


def _hour_reading(h: int) -> str:
    return HOUR_READINGS.get(h, _int_to_hiragana(h) + "じ")


def _minute_reading(m: int) -> str:
    if m == 0:
        return ""
    if m in MINUTE_SOUND_CHANGES:
        return MINUTE_SOUND_CHANGES[m]
    return _int_to_hiragana(m) + "ふん"


def _digit_by_digit(s: str, mode: str) -> str:
    s = normalize_ascii_digits(s)
    if mode == "katakana":
        return "".join(DIGIT_KATAKANA.get(c, c) for c in s)
    if mode == "kanji":
        return "".join(_int_to_kanji(int(c)) if c.isdigit() else c for c in s)
    return "".join(DIGIT_HIRAGANA.get(c, c) for c in s)


def counter_reading(num: str, counter: str, mode: str = "hiragana") -> str | None:
    data = _load_counter_data()
    num = normalize_ascii_digits(num)
    for entry in data.get("entries") or []:
        if entry.get("counter") != counter:
            continue
        forms = entry.get("forms") or {}
        if num in forms:
            r = forms[num]
            if mode == "katakana":
                return r.translate(KATAKANA_MAP)
            return r
    if num.isdigit():
        base = _digit_reading(num, mode)
        unit = counter
        if mode == "katakana":
            unit_data = (data.get("units") or {}).get(counter)
            unit = unit_data.get("katakana", counter) if unit_data else counter.translate(KATAKANA_MAP)
        return base + unit
    return None


def unit_reading(unit: str, mode: str = "hiragana") -> str:
    data = _load_counter_data()
    info = (data.get("units") or {}).get(unit)
    if info:
        return info.get("katakana" if mode == "katakana" else "hiragana", unit)
    if mode == "katakana":
        return unit.translate(KATAKANA_MAP) if re.search(r"[a-zA-Z%]", unit) else unit
    return unit


def candidates_for_number(
    surface: str,
    num_part: str,
    unit_part: str = "",
    pattern: str = "plain",
) -> list[dict]:
    """Return reading candidates with labels."""
    out: list[dict] = []
    num = normalize_ascii_digits(num_part)

    if pattern == "fraction_date" and "/" in surface:
        parts = surface.split("/")
        if len(parts) == 2 and all(normalize_ascii_digits(p).isdigit() for p in parts):
            a, b = parts
            out.append(
                {
                    "reading": _int_to_hiragana(int(b)) + "ぶんの" + _int_to_hiragana(int(a)),
                    "label": "分数",
                }
            )
            if int(a) <= 12 and int(b) <= 31:
                out.append(
                    {
                        "reading": _month_reading(int(a)) + _day_reading(int(b)),
                        "label": "日付",
                    }
                )
            return out

    if pattern == "time":
        if ":" in surface:
            h, m = surface.split(":", 1)
            h, m = normalize_ascii_digits(h), normalize_ascii_digits(m)
            if h.isdigit() and m.isdigit():
                out.append(
                    {
                        "reading": _hour_reading(int(h)) + _minute_reading(int(m)),
                        "label": "時刻",
                    }
                )
        return out

    if pattern == "counter" and unit_part:
        for mode, label in [("hiragana", "ひらがな"), ("katakana", "カタカナ")]:
            r = counter_reading(num, unit_part, mode)
            if r:
                out.append({"reading": r, "label": label})
        return out

    if pattern == "unit_suffix" and unit_part:
        for mode, label in [("hiragana", "ひらがな"), ("katakana", "カタカナ")]:
            nr = _digit_reading(num, mode)
            ur = unit_reading(unit_part, mode)
            out.append({"reading": nr + ur, "label": label})
        return out

    if num.isdigit():
        n = int(num)
        out.append({"reading": _int_to_hiragana(n), "label": "数"})
        out.append({"reading": _int_to_katakana(n), "label": "カタカナ"})
        out.append({"reading": _int_to_kanji(n), "label": "漢数字"})
        if len(num) >= 2:
            out.append({"reading": _digit_by_digit(num, "hiragana"), "label": "桁読み"})
            out.append({"reading": _digit_by_digit(num, "katakana"), "label": "桁読みカタカナ"})
    return out
