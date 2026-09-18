"""Script -> paragraphs -> sentences -> engine-sized segments, plus text normalization.

`text` of every segment is the script text verbatim except that runs of whitespace (including single line
breaks inside a paragraph) collapse to one space. `normalized_text` is what the engine receives: the same
text after (1) pronunciation substitutions (case-sensitive, whole-word, longest rule first, one pass so a
rule never re-matches another rule's output) and (2) optional number spelling (see numbers.py). Every
replacement is reported in `substitutions`; nothing else is altered.
"""
from __future__ import annotations

import re
from typing import Any, Iterable

from .numbers import spell_numbers

# Tokens after which a "." does not end a sentence (case-sensitive, matched against the word before the dot).
ABBREVIATIONS = {"Mr.", "Mrs.", "Ms.", "Dr.", "Prof.", "Sr.", "Jr.", "St.", "vs.", "e.g.", "i.e.", "etc.", "Inc.", "Ltd.",
                 "No.", "Fig.", "approx.", "a.m.", "p.m.", "U.S.", "U.K."}
_TERMINATOR = re.compile(r"([.!?…]+)([\"'”’)\]»›]*)(?=\s|$)")
_OPENERS = "\"'“‘([«‹"
_CLAUSE_SPLIT = re.compile(r"(?<=[,;:—–])\s+")
_WS = re.compile(r"\s+")


def collapse_ws(s: str) -> str:
    return _WS.sub(" ", s).strip()


def split_paragraphs(text: str) -> list[str]:
    """Paragraphs are separated by blank lines; whitespace inside a paragraph collapses to single spaces."""
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    return [collapse_ws(p) for p in re.split(r"\n\s*\n", text) if collapse_ws(p)]


def _is_sentence_end(para: str, m: re.Match) -> bool:
    punct = m.group(1)
    before = para[:m.start()]
    tok_m = re.search(r"(\S+)$", before)
    token = tok_m.group(1).lstrip(_OPENERS) if tok_m else ""
    after = para[m.end():].lstrip()
    if punct == ".":
        if token + "." == "No.":
            return not (after[:1].isdigit())
        if token + "." in ABBREVIATIONS:
            return False
        # initials: "J. R. R. Tolkien", "A. Smith" (the pronoun "I" is excluded so "so do I. Then" splits)
        if re.fullmatch(r"[A-Z]", token) and token != "I" and after[:1].isupper():
            return False
    # "…" or "..." followed by a lowercase word continues the sentence; so does a closing quote followed by a
    # lowercase attribution ('"Really?" she asked.').
    if ("…" in punct or punct.count(".") >= 3 or m.group(2)) and after[:1].islower():
        return False
    return True


def split_sentences(para: str) -> list[str]:
    """Split one (whitespace-collapsed) paragraph into sentences, keeping closing quotes/brackets attached."""
    out: list[str] = []
    start = 0
    for m in _TERMINATOR.finditer(para):
        if _is_sentence_end(para, m):
            piece = para[start:m.end()].strip()
            if piece:
                out.append(piece)
            start = m.end()
    tail = para[start:].strip()
    if tail:
        out.append(tail)
    return out


class Normalizer:
    """Applies pronunciation rules then optional number spelling; reports every replacement."""

    def __init__(self, pronunciation: Iterable[dict] = (), spell: bool = False):
        rules: dict[str, str] = {}
        for r in pronunciation or ():
            src = str(r.get("from", "") or "")
            if src.strip() and src not in rules:
                rules[src] = str(r.get("to", "") or "")
        self.rules = rules
        self.spell = spell
        self._rx = None
        if rules:
            alternation = "|".join(re.escape(k) for k in sorted(rules, key=len, reverse=True))
            self._rx = re.compile(rf"(?<!\w)(?:{alternation})(?!\w)")

    def apply(self, text: str) -> tuple[str, list[dict], list[str]]:
        subs: dict[str, dict] = {}
        notes: list[str] = []
        if self._rx is not None:
            def repl(m: re.Match) -> str:
                src = m.group(0)
                e = subs.setdefault(src, {"from": src, "to": self.rules[src], "count": 0, "kind": "pronunciation"})
                e["count"] += 1
                return self.rules[src]
            text = self._rx.sub(repl, text)
        out = list(subs.values())
        if self.spell:
            text, num_subs, num_notes = spell_numbers(text)
            out.extend(num_subs)
            notes.extend(num_notes)
        return text, out, notes

    def length(self, text: str) -> int:
        return len(self.apply(text)[0])


def _pack(units: list[str], nlen: dict[str, int], limit: int) -> list[str]:
    """Greedily join consecutive units with single spaces while the normalized length stays within `limit`."""
    segs: list[str] = []
    cur, cur_len = "", 0
    for u in units:
        if cur and cur_len + 1 + nlen[u] > limit:
            segs.append(cur)
            cur, cur_len = u, nlen[u]
        else:
            cur, cur_len = (f"{cur} {u}" if cur else u), (cur_len + 1 + nlen[u] if cur else nlen[u])
    if cur:
        segs.append(cur)
    return segs


def _split_long(sentence: str, norm: Normalizer, limit: int, warnings: list[str], where: str) -> list[str]:
    """Split one overlong sentence at clause punctuation, then at word boundaries."""
    pieces: list[str] = []
    for clause in _CLAUSE_SPLIT.split(sentence):
        if norm.length(clause) <= limit:
            pieces.append(clause)
            continue
        words = clause.split(" ")
        lens = {w: norm.length(w) for w in words}
        for w in words:
            if lens[w] > limit:
                warnings.append(f"{where}: the word {w[:40]!r} is longer than the {limit}-character limit and is kept whole.")
        pieces.extend(_pack(words, lens, limit))
    parts = _pack(pieces, {p: norm.length(p) for p in pieces}, limit)
    warnings.append(f"{where} is {norm.length(sentence)} characters, longer than the {limit}-character limit; "
                    f"it was split into {len(parts)} parts at clause/word boundaries.")
    return parts


def plan_segments(text: str, max_chars: int, pronunciation: list[dict] | None = None, spell_numbers: bool = False,
                  engine_max_chars: int | None = None) -> dict[str, Any]:
    """Plan engine segments for a script.

    Returns {segments: [{index, paragraph, text, normalized_text, substitutions, char_count}], warnings, normalization_notes}.
    `max_chars` is clamped to `engine_max_chars` when given; `char_count` measures `normalized_text`.
    """
    warnings: list[str] = []
    limit = int(max_chars)
    if engine_max_chars and limit > int(engine_max_chars):
        warnings.append(f"Segment size {limit} exceeds the engine limit of {engine_max_chars} characters; using {engine_max_chars}.")
        limit = int(engine_max_chars)
    limit = max(1, limit)
    norm = Normalizer(pronunciation or [], spell_numbers)
    segments: list[dict[str, Any]] = []
    notes: list[str] = []
    for p_idx, para in enumerate(split_paragraphs(text)):
        groups: list[list[str]] = [[]]           # an overlong sentence forms its own group so its parts stay together
        for s_idx, sentence in enumerate(split_sentences(para)):
            if norm.length(sentence) > limit:
                parts = _split_long(sentence, norm, limit, warnings, f"Paragraph {p_idx + 1}, sentence {s_idx + 1}")
                groups.append(parts)
                groups.append([])
            else:
                groups[-1].append(sentence)
        for units in groups:
            if not units:
                continue
            lens = {u: norm.length(u) for u in units}
            for seg_text in _pack(units, lens, limit):
                normalized, subs, seg_notes = norm.apply(seg_text)
                notes.extend(n for n in seg_notes if n not in notes)
                segments.append({"index": len(segments), "paragraph": p_idx, "text": seg_text, "normalized_text": normalized,
                                 "substitutions": subs, "char_count": len(normalized)})
                if len(normalized) > limit:
                    warnings.append(f"Segment {len(segments)} is {len(normalized)} characters after normalization "
                                    f"(limit {limit}); the engine may truncate it.")
    if norm.rules:
        n_rules = sum(1 for s in segments for _ in s["substitutions"] if _["kind"] == "pronunciation")
        notes.insert(0, f"Pronunciation rules: {len(norm.rules)} defined, {n_rules} distinct matches applied.")
    if spell_numbers:
        n_nums = sum(x["count"] for s in segments for x in s["substitutions"] if x["kind"] == "number")
        notes.insert(0, f"Numbers spelled out: {n_nums} (bare 4-digit numbers in 1100-2099 are read as years).")
    return {"segments": segments, "warnings": warnings, "normalization_notes": notes}
