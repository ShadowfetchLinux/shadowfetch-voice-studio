"""Segmenter + normalization tests (pure functions, no audio)."""
from __future__ import annotations

import pytest

from shadowfetch_worker.text.numbers import spell_int, spell_numbers, spell_year
from shadowfetch_worker.text.segmenter import Normalizer, plan_segments, split_paragraphs, split_sentences


# ---------------------------------------------------------------- sentences
def test_abbreviations_do_not_split():
    s = split_sentences("Dr. Smith met Mr. and Mrs. Jones at 5 p.m. on St. John Street, e.g. near Acme Inc. headquarters. Then they left.")
    assert s == ["Dr. Smith met Mr. and Mrs. Jones at 5 p.m. on St. John Street, e.g. near Acme Inc. headquarters.", "Then they left."]
    assert split_sentences("See Fig. 3 and No. 5 vs. the U.S. report, approx. 2 pages. Done.") == \
        ["See Fig. 3 and No. 5 vs. the U.S. report, approx. 2 pages.", "Done."]


def test_decimals_and_initials():
    assert split_sentences("Pi is 3.14 and e is 2.71 roughly. J. R. R. Tolkien agreed.") == ["Pi is 3.14 and e is 2.71 roughly.", "J. R. R. Tolkien agreed."]
    # the pronoun "I" still ends a sentence
    assert split_sentences("So do I. Then we left.") == ["So do I.", "Then we left."]


def test_quotes_and_brackets_stay_attached():
    assert split_sentences('He said "Go home." She replied (quietly). "Really?" she asked. "Yes!" Then silence.') == \
        ['He said "Go home."', "She replied (quietly).", '"Really?" she asked.', '"Yes!"', "Then silence."]
    assert split_sentences("Wait… what? Hmm... no way. Fine...") == ["Wait… what?", "Hmm... no way.", "Fine..."]


def test_paragraphs_and_whitespace():
    assert split_paragraphs("One\nline.\r\n\r\n  Two   spaces.\n\n\n") == ["One line.", "Two spaces."]
    r = plan_segments("Para one.\n\nPara two. Still two.", 400)
    assert [(s["paragraph"], s["text"]) for s in r["segments"]] == [(0, "Para one."), (1, "Para two. Still two.")]
    assert plan_segments("   \n\n  ", 400)["segments"] == []


# ---------------------------------------------------------------- packing
def test_packing_respects_limit_and_order():
    text = " ".join(f"Sentence number {i} ends here." for i in range(1, 9))   # 8 x 28-29 chars
    r = plan_segments(text, 60)
    assert [s["index"] for s in r["segments"]] == list(range(len(r["segments"])))
    assert all(s["char_count"] <= 60 for s in r["segments"])
    assert " ".join(s["text"] for s in r["segments"]) == text                # verbatim, nothing lost
    assert len(r["segments"]) == 4 and r["warnings"] == []
    # engine limit clamps max_chars with a warning
    r2 = plan_segments(text, 600, engine_max_chars=60)
    assert len(r2["segments"]) == 4 and "engine limit" in r2["warnings"][0]


def test_overlong_sentence_split_with_warning():
    long = "This sentence is long, it has several clauses; it keeps going and going: never stopping — until the very end."
    r = plan_segments(long, 40)
    assert len(r["segments"]) > 1 and all(s["char_count"] <= 40 for s in r["segments"])
    assert " ".join(s["text"] for s in r["segments"]) == long
    assert any("longer than the 40-character limit" in w for w in r["warnings"])
    # clause pieces end at clause punctuation when possible
    assert r["segments"][0]["text"].endswith(",")
    # no clause punctuation at all -> word boundaries
    words = "word " * 30
    r = plan_segments(words.strip() + ".", 40)
    assert all(s["char_count"] <= 40 for s in r["segments"]) and all(not s["text"].startswith(" ") for s in r["segments"])
    # an overlong sentence does not merge with its neighbours
    r = plan_segments("Short one. " + long + " Short two.", 40)
    assert r["segments"][0]["text"] == "Short one." and r["segments"][-1]["text"] == "Short two."


# ---------------------------------------------------------------- substitutions
def test_pronunciation_substitutions_listed():
    rules = [{"from": "GPT", "to": "G P T"}, {"from": "GPT-4o", "to": "G P T four oh"}, {"from": "read", "to": "red"}]
    r = plan_segments("GPT-4o and GPT read the read-me. Read it! gpt stays.", 400, pronunciation=rules)
    seg = r["segments"][0]
    assert seg["text"] == "GPT-4o and GPT read the read-me. Read it! gpt stays."
    assert seg["normalized_text"] == "G P T four oh and G P T red the red-me. Read it! gpt stays."
    subs = {(s["from"], s["to"]): s["count"] for s in seg["substitutions"]}
    assert subs == {("GPT-4o", "G P T four oh"): 1, ("GPT", "G P T"): 1, ("read", "red"): 2}   # longest first, case-sensitive, whole word
    assert all(s["kind"] == "pronunciation" for s in seg["substitutions"])
    # a rule never re-matches another rule's output
    n = Normalizer([{"from": "a", "to": "b"}, {"from": "b", "to": "c"}])
    assert n.apply("a b")[0] == "b c"
    assert Normalizer([{"from": "", "to": "x"}]).rules == {}


def test_nothing_else_is_altered():
    text = "Keep <b>tags</b>, symbols & emoji 🙂 and   extra spaces."
    r = plan_segments(text, 400)
    assert r["segments"][0]["text"] == "Keep <b>tags</b>, symbols & emoji 🙂 and extra spaces."
    assert r["segments"][0]["normalized_text"] == r["segments"][0]["text"] and r["segments"][0]["substitutions"] == []


# ---------------------------------------------------------------- numbers
@pytest.mark.parametrize("n, words", [
    (0, "zero"), (7, "seven"), (13, "thirteen"), (20, "twenty"), (21, "twenty-one"), (100, "one hundred"), (101, "one hundred one"),
    (999, "nine hundred ninety-nine"), (1000, "one thousand"), (1234, "one thousand two hundred thirty-four"),
    (1_000_000, "one million"), (2_500_017, "two million five hundred thousand seventeen"),
    (999_999_999_999, "nine hundred ninety-nine billion nine hundred ninety-nine million nine hundred ninety-nine thousand nine hundred ninety-nine"),
])
def test_spell_int(n, words):
    assert spell_int(n) == words


@pytest.mark.parametrize("n, words", [
    (1984, "nineteen eighty-four"), (1900, "nineteen hundred"), (1905, "nineteen oh five"), (1100, "eleven hundred"),
    (2000, "two thousand"), (2005, "two thousand five"), (2010, "twenty ten"), (2024, "twenty twenty-four"), (2099, "twenty ninety-nine"),
])
def test_spell_year(n, words):
    assert spell_year(n) == words


def test_spell_numbers_in_text():
    text, subs, notes = spell_numbers("In 1984 we sold 1,234 units at 3.14 each, 50% off, $1984 total; the 3 of us, 12.5 % more.")
    assert text == ("In nineteen eighty-four we sold one thousand two hundred thirty-four units at three point one four each, "
                    "fifty percent off, $one thousand nine hundred eighty-four total; the three of us, twelve point five percent more.")
    assert {s["from"]: s["to"] for s in subs}["1984"] == "nineteen eighty-four"
    assert all(s["kind"] == "number" for s in subs) and notes == []
    # untouched: digits glued to letters, clock times, ordinals; too-large numbers are left with a note
    text, subs, notes = spell_numbers("mp3 files, 1st place, at 10:30, H2O, and 1,000,000,000,000 grains.")
    assert text == "mp3 files, 1st place, at 10:30, H2O, and 1,000,000,000,000 grains."
    assert subs == [] and "left as digits" in notes[0]
    assert spell_numbers("Call 5 5 5.")[0] == "Call five five five."


def test_plan_with_number_spelling_reports_substitutions():
    r = plan_segments("Room 101 opened in 1999.", 400, spell_numbers=True)
    seg = r["segments"][0]
    assert seg["text"] == "Room 101 opened in 1999."
    assert seg["normalized_text"] == "Room one hundred one opened in nineteen ninety-nine."
    assert [(s["from"], s["to"], s["count"]) for s in seg["substitutions"]] == [("101", "one hundred one", 1), ("1999", "nineteen ninety-nine", 1)]
    assert seg["char_count"] == len(seg["normalized_text"])
    assert any("Numbers spelled out: 2" in n for n in r["normalization_notes"])
    # pronunciation rules run before number spelling, so a rule may target digits
    r = plan_segments("GPT-4 in 2024.", 400, pronunciation=[{"from": "GPT-4", "to": "G P T four"}], spell_numbers=True)
    assert r["segments"][0]["normalized_text"] == "G P T four in twenty twenty-four."
