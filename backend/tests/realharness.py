"""Harness for the real-model tests (SFVS_REAL_MODELS=1): a real Server + EngineManager + ModelManager on the
machine's model cache, isolated data/config/cache dirs, and a speech clip made with espeak-ng.

The engine hosts are real subprocesses (backend/.venv and backend/envs/chatterbox) — exactly what the app runs.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import time
from pathlib import Path

import pytest

from tests.conftest import FakeTransport

REAL = os.environ.get("SFVS_REAL_MODELS") == "1"
realmodel = pytest.mark.skipif(not REAL, reason="set SFVS_REAL_MODELS=1 to run against the real models/GPU")

# The shared scratch dir lets test_real_whisper transcribe what test_real_qwen produced.
SCRATCH = Path(os.environ.get("SFVS_REAL_SCRATCH") or (Path(os.environ.get("XDG_CACHE_HOME") or Path.home() / ".cache")
                                                        / "shadowfetch-voice-studio" / "realtests"))
REPORT = SCRATCH / "report.json"

# ~11 s at espeak's default rate; every word is plain English so the ASR check is fair.
REFERENCE_TEXT = ("The quick brown fox jumps over the lazy dog near the river bank. "
                  "Please remember to water the garden before the sun goes down this evening.")
GENERATE_TEXT = "Good morning everyone. Today we are testing a voice clone with a short and simple sentence."


def models_dir() -> Path:
    d = os.environ.get("SFVS_MODELS_DIR")
    if d:
        return Path(d)
    from shadowfetch_worker.paths import AppPaths
    return AppPaths.build().models   # the app's own models dir (…/shadowfetch-voice-studio/models)


def record(section: str, data: dict) -> None:
    SCRATCH.mkdir(parents=True, exist_ok=True)
    cur = {}
    if REPORT.exists():
        try:
            cur = json.loads(REPORT.read_text())
        except ValueError:
            cur = {}
    cur[section] = {**cur.get(section, {}), **data, "ts": time.strftime("%Y-%m-%dT%H:%M:%S")}
    REPORT.write_text(json.dumps(cur, indent=2, default=str))


def espeak_clip(path: Path, text: str = REFERENCE_TEXT, voice: str = "en-us", wpm: int = 150) -> Path | None:
    """A speech clip from espeak-ng (synthetic but real, intelligible speech with a known transcript)."""
    exe = shutil.which("espeak-ng") or shutil.which("espeak")
    if not exe:
        return None
    path.parent.mkdir(parents=True, exist_ok=True)
    r = subprocess.run([exe, "-v", voice, "-s", str(wpm), "-w", str(path), text], capture_output=True, text=True, timeout=60)
    if r.returncode != 0 or not path.exists():
        return None
    return path


def make_server(tmp_path: Path, offline: bool = False):
    """Real Server with EngineManager + ModelManager. data/config/cache are temporary; models dir is the real one."""
    from shadowfetch_worker.engines.manager import EngineManager
    from shadowfetch_worker.jobs.models import get_models
    from shadowfetch_worker.paths import AppPaths
    from shadowfetch_worker.rpc import Server
    from shadowfetch_worker.runtime import Runtime
    from shadowfetch_worker.settings import SettingsStore
    from shadowfetch_worker.store.db import Database
    import shadowfetch_worker.jobs  # noqa: F401  (registers methods)

    paths = AppPaths.build(str(tmp_path / "data"), str(tmp_path / "config"), str(tmp_path / "cache"), str(models_dir()))
    settings = SettingsStore(paths.settings_file)
    settings.patch({"offline": offline, "idle_unload_minutes": 0})
    if offline:
        os.environ["HF_HUB_OFFLINE"] = "1"
        os.environ["TRANSFORMERS_OFFLINE"] = "1"
    else:
        os.environ.pop("HF_HUB_OFFLINE", None)
        os.environ.pop("TRANSFORMERS_OFFLINE", None)
    os.environ["HF_HUB_CACHE"] = str(paths.hf_cache)
    transport = FakeTransport()
    server = Server(transport, worker_name="realtest", gpu_slots=1)
    server.state.update({"paths": paths, "settings": settings, "runtime": Runtime(paths), "db": Database(paths.db_file)})
    server.state["engines"] = EngineManager(server)
    get_models(server)
    return server


def make_ctx(server, req_id: str = "real-1"):
    from shadowfetch_worker.rpc import Ctx
    return Ctx(req_id=req_id, method="test", transport=server.transport, server=server)


def seed_reference(server, clip: Path, transcript: str, engine_id: str = "qwen3-tts-base") -> str:
    """Insert asset + voice + voice_reference rows pointing at `clip`; returns the reference id."""
    import hashlib
    import soundfile as sf
    from shadowfetch_worker.store.db import new_id
    db = server.state["db"]
    paths = server.state["paths"]
    info = sf.info(str(clip))
    asset_id = new_id("as")
    dest_dir = paths.recordings / asset_id
    dest_dir.mkdir(parents=True, exist_ok=True)
    original = dest_dir / ("original" + clip.suffix)
    shutil.copy2(clip, original)
    sha = hashlib.sha256(original.read_bytes()).hexdigest()
    db.insert("assets", {"id": asset_id, "kind": "reference", "source": "import", "original_name": clip.name, "original_path": str(original),
                         "working_path": None, "sha256": sha, "format": "wav", "codec": info.subtype, "duration_s": info.duration,
                         "sample_rate": info.samplerate, "channels": info.channels, "size_bytes": original.stat().st_size})
    voice_id = new_id("vo")
    db.insert("voices", {"id": voice_id, "name": "espeak test voice", "language": "en", "rights_confirmed": 1})
    ref_id = new_id("rf")
    fp = hashlib.sha256(json.dumps({"sha": sha, "start": 0.0, "end": info.duration, "transcript": transcript, "processing": []}).encode()).hexdigest()
    db.insert("voice_references", {"id": ref_id, "voice_id": voice_id, "asset_id": asset_id, "label": "espeak", "start_s": 0.0,
                                   "end_s": float(info.duration), "transcript": transcript, "transcript_source": "edited",
                                   "transcript_confirmed": 1, "fingerprint": fp})
    db.update("voices", voice_id, {"selected_reference_id": ref_id})
    return ref_id


def word_overlap(expected: str, got: str) -> float:
    import re
    norm = lambda s: re.findall(r"[a-z']+", s.lower())  # noqa: E731
    e, g = norm(expected), set(norm(got))
    if not e:
        return 0.0
    return sum(1 for w in e if w in g) / len(e)
