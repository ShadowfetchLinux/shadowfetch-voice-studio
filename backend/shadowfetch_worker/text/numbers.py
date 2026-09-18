"""Number spelling for TTS input (English).

Conventions (deliberately simple, all documented here):
- Integers 0 .. 999,999,999,999 are spelled in words ("1,234" -> "one thousand two hundred thirty-four").
  Larger integers are left as digits and reported as a note.
- Decimals: integer part in words, "point", then each fractional digit ("3.14" -> "three point one four").
- Percent: "50%" / "50 %" -> "fifty percent".
- Years: a bare 4-digit integer in 1100..1999 or 2000..2099 (no thousands separator, no decimal part, no
  currency symbol in front) is read as a year: 1984 -> "nineteen eighty-four", 1905 -> "nineteen oh five",
  1900 -> "nineteen hundred", 2005 -> "two thousand five", 2024 -> "twenty twenty-four".
- Left untouched: digits glued to letters ("mp3", "1st", "3D"), clock times ("10:30"), numbers inside words.
  A hyphen between numbers is kept as is ("1-5" -> "one-five").
"""
from __future__ import annotations

import re

ONES = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve",
        "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"]
TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"]
SCALES = [(1_000_000_000, "billion"), (1_000_000, "million"), (1_000, "thousand")]
MAX_SPELLED = 999_999_999_999
CURRENCY = "$€£¥#"

# integer (with optional thousands commas) + optional decimal part + optional percent sign; not glued to words,
# not part of a clock time (10:30), not preceded by a decimal point (the ".14" of "3.14" is consumed by the decimal
# branch of the same match, never on its own).
NUMBER_RE = re.compile(r"(?<![\w.])(?<!\d:)(?P<int>\d{1,3}(?:,\d{3})+|\d+)(?:\.(?P<frac>\d+))?(?P<pct>\s?%)?(?!\w)(?!:\d)")


def spell_int(n: int) -> str:
    """Spell a non-negative integer up to MAX_SPELLED in English words."""
    if n < 0:
        return "minus " + spell_int(-n)
    if n > MAX_SPELLED:
        raise ValueError(f"{n} is larger than {MAX_SPELLED}")
    if n < 20:
        return ONES[n]
    if n < 100:
        t, o = divmod(n, 10)
        return TENS[t] + (f"-{ONES[o]}" if o else "")
    if n < 1000:
        h, r = divmod(n, 100)
        return f"{ONES[h]} hundred" + (f" {spell_int(r)}" if r else "")
    for value, name in SCALES:
        if n >= value:
            q, r = divmod(n, value)
            return f"{spell_int(q)} {name}" + (f" {spell_int(r)}" if r else "")
    raise AssertionError("unreachable")


def spell_year(n: int) -> str:
    """Spell a year the way it is read aloud (see module docstring for the conventions)."""
    if 2000 <= n <= 2009:
        return "two thousand" + (f" {ONES[n - 2000]}" if n > 2000 else "")
    if 2010 <= n <= 2099:
        return "twenty " + spell_int(n - 2000)
    hi, lo = divmod(n, 100)
    if lo == 0:
        return f"{spell_int(hi)} hundred"
    if lo < 10:
        return f"{spell_int(hi)} oh {ONES[lo]}"
    return f"{spell_int(hi)} {spell_int(lo)}"


def is_year_like(token: str, preceded_by: str) -> bool:
    """True for a bare 4-digit token in a year range that is not a price/quantity."""
    if not re.fullmatch(r"\d{4}", token):
        return False
    n = int(token)
    if not (1100 <= n <= 2099):
        return False
    return not (preceded_by and preceded_by[-1] in CURRENCY)


def spell_match(m: re.Match) -> str | None:
    """Spell one NUMBER_RE match; None when the number is too large to spell."""
    raw_int = m.group("int")
    n = int(raw_int.replace(",", ""))
    if n > MAX_SPELLED:
        return None
    frac, pct = m.group("frac"), m.group("pct")
    before = m.string[max(0, m.start() - 1):m.start()]
    if frac is None and pct is None and "," not in raw_int and is_year_like(raw_int, before):
        return spell_year(n)
    words = spell_int(n)
    if frac is not None:
        words += " point " + " ".join(ONES[int(d)] for d in frac)
    if pct is not None:
        words += " percent"
    return words


def spell_numbers(text: str) -> tuple[str, list[dict], list[str]]:
    """Replace numbers in `text` with words.

    Returns (new_text, substitutions [{from, to, count, kind:"number"}], notes).
    """
    subs: dict[str, dict] = {}
    too_large: list[str] = []

    def repl(m: re.Match) -> str:
        src = m.group(0)
        out = spell_match(m)
        if out is None:
            too_large.append(src)
            return src
        entry = subs.setdefault(src, {"from": src, "to": out, "count": 0, "kind": "number"})
        entry["count"] += 1
        return out

    new_text = NUMBER_RE.sub(repl, text)
    notes: list[str] = []
    if too_large:
        notes.append("Numbers larger than 999,999,999,999 were left as digits: " + ", ".join(dict.fromkeys(too_large)))
    return new_text, list(subs.values()), notes
