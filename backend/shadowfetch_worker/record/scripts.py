"""Guided reading scripts for capturing a voice reference (three delivery styles, ~45–60 s each).

The texts are deliberately varied: short and long sentences, numbers, dates, questions and a few
exclamations, so a single take covers a useful range of pitch and rhythm. `approx_seconds` is an estimate
from the word count at a typical speaking rate for the style — the real take length is measured from the file.
"""
from __future__ import annotations

from typing import Any

STYLE_WPM = {"conversational": 155, "calm_narration": 130, "energetic_presentation": 165}

_SCRIPTS: list[dict[str, str]] = [
    {
        "id": "conversational",
        "title": "Everyday conversation",
        "style": "conversational",
        "text": (
            "Okay, so here's what happened this morning. I was supposed to catch the 8:15 train, but the kitchen "
            "clock was running about ten minutes slow, and I only noticed when the coffee was already brewing. "
            "Have you ever had one of those days where every little thing lines up against you? I got to the "
            "platform at 8:20, just in time to watch the doors close. The next one was at 8:47, which honestly "
            "wasn't the end of the world. I read a couple of chapters, answered three emails, and by the time I "
            "walked into the office nobody had even noticed. Do you want to grab lunch later? There's a new place "
            "on Fourth Street with a lunch special for twelve dollars, and apparently the soup is really good. "
            "Anyway, I'll text you around half past twelve and we can figure it out from there."
        ),
    },
    {
        "id": "calm_narration",
        "title": "Calm narration",
        "style": "calm_narration",
        "text": (
            "The river begins as a thin stream, high in the hills, where snow lingers until late May. By the time "
            "it reaches the valley floor, some forty kilometres downstream, it is wide enough to carry small boats, "
            "and slow enough to reflect the sky. Along its banks, the first settlements appeared more than two "
            "thousand years ago, and the stone bridge finished in 1712 still carries traffic today. Why here, and "
            "not further north? The answer is simple: the soil is rich, the winters are mild, and the water never "
            "runs dry. In the early evening the surface goes still, and for a few minutes the whole valley seems "
            "to hold its breath. Then the wind returns, the reeds begin to move, and the river carries on toward "
            "the sea."
        ),
    },
    {
        "id": "energetic_presentation",
        "title": "Energetic presentation",
        "style": "energetic_presentation",
        "text": (
            "Good morning, everyone, and thank you for being here! Let's jump straight in, because we have a lot "
            "to cover in the next 20 minutes. Last quarter, the team shipped 14 updates, cut the average "
            "response time from 6 seconds to under 2, and grew the number of active users by thirty-one "
            "percent. Thirty-one percent! So what changed? Three things. First, we listened. Second, we simplified. "
            "Third, we stopped guessing and started measuring. Now, here is the question I want you to keep in "
            "mind: what would you build if you knew exactly what your users needed on Tuesday morning at nine "
            "o'clock? That's where we're headed next. Over the coming five weeks we'll roll out two new features, "
            "run a survey with 500 participants, and share every result with you. Ready? Let's go!"
        ),
    },
]


def reading_scripts() -> list[dict[str, Any]]:
    """`[{id, title, style, text, word_count, approx_seconds}]` — the three guided reading scripts."""
    out = []
    for s in _SCRIPTS:
        words = len(s["text"].split())
        out.append({**s, "word_count": words, "approx_seconds": round(words / STYLE_WPM[s["style"]] * 60)})
    return out


def get_script(script_id: str) -> dict[str, Any] | None:
    return next((s for s in reading_scripts() if s["id"] == script_id), None)
