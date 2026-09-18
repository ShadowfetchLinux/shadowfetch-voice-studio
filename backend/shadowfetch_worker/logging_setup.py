"""File logging with redaction of paths, transcripts and secrets."""
from __future__ import annotations

import logging
import logging.handlers
import re
import sys
from pathlib import Path

_HOME = str(Path.home())
_SECRET = re.compile(r"(hf_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9]{20,}|Bearer\s+[A-Za-z0-9._-]+)")
_TRANSCRIPT = re.compile(r"(transcript|ref_text|text)(['\"]?\s*[:=]\s*['\"])([^'\"]{0,4000})(['\"])")


class RedactingFormatter(logging.Formatter):
    def __init__(self, fmt: str, redact: bool = True):
        super().__init__(fmt)
        self.redact = redact

    def format(self, record: logging.LogRecord) -> str:
        s = super().format(record)
        if not self.redact:
            return s
        s = _SECRET.sub("<redacted-secret>", s)
        s = _TRANSCRIPT.sub(lambda m: f"{m.group(1)}{m.group(2)}<redacted {len(m.group(3))} chars>{m.group(4)}", s)
        s = s.replace(_HOME, "~")
        return s


def setup_logging(log_dir: Path, name: str = "worker", redact: bool = True, level: int = logging.INFO) -> Path:
    log_dir.mkdir(parents=True, exist_ok=True)
    path = log_dir / f"{name}.log"
    fmt = RedactingFormatter("%(asctime)s %(levelname)s %(name)s: %(message)s", redact)
    root = logging.getLogger()
    root.setLevel(level)
    for h in list(root.handlers):
        root.removeHandler(h)
    fh = logging.handlers.RotatingFileHandler(path, maxBytes=5_000_000, backupCount=3, encoding="utf-8")
    fh.setFormatter(fmt)
    root.addHandler(fh)
    sh = logging.StreamHandler(sys.stderr)   # stderr is captured by the shell; stdout is the protocol channel
    sh.setFormatter(fmt)
    sh.setLevel(logging.WARNING)
    root.addHandler(sh)
    for noisy in ("urllib3", "httpx", "filelock", "huggingface_hub", "numba"):
        logging.getLogger(noisy).setLevel(logging.WARNING)
    return path


def protect_stdout() -> int:
    """Reserve fd 1 for the protocol: return a dup of the real stdout and point sys.stdout at stderr."""
    import os
    real = os.dup(1)
    os.dup2(2, 1)            # anything that writes to fd 1 (C libs, tqdm) now lands on stderr
    sys.stdout = sys.stderr  # and Python-level prints too
    return real
