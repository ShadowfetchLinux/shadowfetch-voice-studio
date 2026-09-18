"""Real end-to-end path through the actual worker process (JSON lines), exactly as the desktop shell drives it:

import → stats → transcribe → correct transcript → save voice → project + script → plan → generate (Qwen) →
regenerate a passage → assemble → export WAV + MP3 → restart the worker → reopen the project → offline check →
cancellation keeps finished segments.

Runs only with SFVS_REAL_MODELS=1 (GPU + downloaded models). Reference speech comes from espeak-ng — real,
intelligible speech with a known transcript (a smoke/intelligibility test, not a voice-fidelity test).
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import threading
import time
from pathlib import Path

import pytest
import soundfile as sf

from tests.realharness import GENERATE_TEXT, REFERENCE_TEXT, espeak_clip, models_dir, realmodel, record, word_overlap

BACKEND = Path(__file__).resolve().parent.parent
SCRIPT = ("Welcome to the studio. This is the first paragraph, and it has two sentences.\n\n"
          "Here is a second paragraph. It talks about numbers like 42 and the year 1999. "
          "Finally, we finish with a question. Does the voice sound natural?")


class WorkerClient:
    """Minimal JSON-lines client for `python -m shadowfetch_worker` (mirrors src-tauri/src/worker.rs)."""

    def __init__(self, data: Path, config: Path, cache: Path, models: Path, env: dict | None = None):
        cmd = [sys.executable, "-m", "shadowfetch_worker", "--data-dir", str(data), "--config-dir", str(config),
               "--cache-dir", str(cache), "--models-dir", str(models)]
        self.proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=open(data / "worker-stderr.log", "ab"),
                                     cwd=str(BACKEND), text=True, bufsize=1, env={**os.environ, **(env or {}), "PYTHONPATH": str(BACKEND)})
        self.events: list[dict] = []
        self.progress: dict[str, list[dict]] = {}
        self._results: dict[str, dict] = {}
        self._cv = threading.Condition()
        self.ready = threading.Event()
        threading.Thread(target=self._reader, daemon=True).start()
        assert self.ready.wait(60), "worker did not become ready"
        self._n = 0

    def _reader(self):
        for line in self.proc.stdout:
            line = line.strip()
            if not line.startswith("{"):
                continue
            m = json.loads(line)
            t = m.get("type")
            if t == "ready":
                self.ready.set()
            elif t == "event":
                self.events.append(m)
            elif t == "progress":
                self.progress.setdefault(m["id"], []).append(m)
            elif t in ("result", "error"):
                with self._cv:
                    self._results[m["id"]] = m
                    self._cv.notify_all()

    def send(self, obj: dict):
        self.proc.stdin.write(json.dumps(obj) + "\n")
        self.proc.stdin.flush()

    def start(self, method: str, params: dict | None = None) -> str:
        self._n += 1
        rid = f"r{self._n}"
        self.send({"v": 1, "type": "request", "id": rid, "method": method, "params": params or {}})
        return rid

    def wait(self, rid: str, timeout: float = 900) -> dict:
        with self._cv:
            ok = self._cv.wait_for(lambda: rid in self._results, timeout=timeout)
        assert ok, f"timeout waiting for {rid}"
        return self._results.pop(rid)

    def call(self, method: str, params: dict | None = None, timeout: float = 900) -> dict:
        m = self.wait(self.start(method, params), timeout)
        if m["type"] == "error":
            raise WorkerFailure(m["error"])
        return m["result"]

    def cancel(self, rid: str):
        self.send({"v": 1, "type": "cancel", "id": rid})

    def shutdown(self):
        try:
            self.send({"v": 1, "type": "shutdown"})
            self.proc.wait(timeout=20)
        except Exception:  # noqa: BLE001
            self.proc.kill()


class WorkerFailure(Exception):
    def __init__(self, err: dict):
        super().__init__(f"{err.get('code')}: {err.get('message')}")
        self.err = err


@realmodel
@pytest.mark.timeout(1800)
def test_full_workflow_through_worker(tmp_path: Path):
    clip = espeak_clip(tmp_path / "ref.wav")
    if clip is None:
        pytest.skip("espeak-ng not available — no authorized speech sample on this machine")
    data, config, cache = tmp_path / "data", tmp_path / "config", tmp_path / "cache"
    for d in (data, config, cache):
        d.mkdir()
    report: dict = {}
    w = WorkerClient(data, config, cache, models_dir())
    try:
        w.call("system.settings.set", {"patch": {"idle_unload_minutes": 0}})
        # 1. import + inspect
        imp = w.call("audio.import", {"path": str(clip), "kind": "reference"})
        assert imp["probe"]["duration_s"] > 5 and Path(imp["working_path"]).exists() and Path(imp["original_path"]).exists()
        end = round(min(9.0, imp["probe"]["duration_s"] - 0.05), 2)
        st = w.call("audio.stats", {"path": imp["working_path"], "start_s": 0, "end_s": end})
        assert st["peak_dbfs"] < 0 and st["sample_rate"] == 48000
        peaks = w.call("audio.peaks", {"path": imp["working_path"], "points": 500})
        assert len(peaks["peaks"]) == 500
        # 2. transcribe the selection locally, then "correct" it (use the known text)
        tr = w.call("transcribe.run", {"path": imp["working_path"], "start_s": 0, "end_s": end, "device": "cpu"})
        report["asr_overlap_reference"] = word_overlap(REFERENCE_TEXT, tr["text"])
        assert report["asr_overlap_reference"] >= 0.6, tr["text"]
        transcript = " ".join(REFERENCE_TEXT.split()[:len(tr["text"].split())]) or tr["text"]
        # 3. save the voice (rights confirmation required)
        with pytest.raises(WorkerFailure) as ei:
            w.call("voices.create", {"name": "E2E voice", "tags": ["test"], "language": "en", "rights_confirmed": False,
                                     "asset_id": imp["asset_id"], "trim": {"start_s": 0, "end_s": end}, "transcript": transcript})
        assert ei.value.err["code"] == "INVALID_PARAMS"
        voice = w.call("voices.create", {"name": "E2E voice", "tags": ["test"], "language": "en", "rights_confirmed": True,
                                         "asset_id": imp["asset_id"], "trim": {"start_s": 0, "end_s": end}, "transcript": transcript,
                                         "transcript_confirmed": True, "transcript_source": "edited"})
        vid, ref_id = voice["id"], voice["selected_reference_id"]
        assert ref_id
        # 4. project + script + plan
        proj = w.call("projects.create", {"name": "E2E project", "voice_id": vid, "reference_id": ref_id, "engine_id": "qwen3-tts-base"})
        pid = proj["id"]
        w.call("projects.save_script", {"id": pid, "text": SCRIPT})
        plan = w.call("tts.plan", {"project_id": pid, "script_text": SCRIPT, "engine_id": "qwen3-tts-base",
                                   "options": {"max_chars": 120, "spell_numbers": True}})
        segs = plan["segments"]
        assert len(segs) >= 3 and segs[-1]["paragraph"] == 1
        assert any("forty-two" in s["normalized_text"] for s in segs), [s["normalized_text"] for s in segs]
        report["segments"] = len(segs)
        # 5. generate everything (real Qwen through the engine host)
        t0 = time.time()
        rid = w.start("tts.generate", {"project_id": pid, "engine_id": "qwen3-tts-base", "reference_id": ref_id, "language": "en",
                                       "settings": {"temperature": 0.8}, "seed": 1234})
        gen = w.wait(rid, timeout=1200)
        assert gen["type"] == "result", gen
        takes = gen["result"]["takes"]
        assert len(takes) == len(segs)
        msgs = [p["message"] for p in w.progress.get(rid, [])]
        assert any(m.startswith("Generating segment 1 of") for m in msgs), msgs[:5]
        report["generate_s"] = round(time.time() - t0, 1)
        report["audio_s"] = round(sum(t["duration_s"] for t in takes), 2)
        for t in takes:
            info = sf.info(t["path"])
            assert info.samplerate == 24000 and info.frames > 2400
        # 6. regenerate one passage without losing the others
        before = w.call("projects.get", {"id": pid})
        seg1 = before["segments"][1]
        old_take = seg1["selected_take_id"]
        regen = w.call("tts.generate", {"project_id": pid, "engine_id": "qwen3-tts-base", "reference_id": ref_id, "language": "en",
                                        "settings": {"temperature": 0.8}, "segment_indices": [1], "seed": 777}, timeout=600)
        assert len(regen["takes"]) == 1
        after = w.call("projects.get", {"id": pid})
        seg1b = after["segments"][1]
        assert seg1b["selected_take_id"] != old_take and len(seg1b["takes"]) == 2, seg1b
        assert all(Path(t["path"]).exists() for t in seg1b["takes"])
        w.call("projects.select_take", {"id": pid, "segment_index": 1, "take_id": old_take})
        # 7. assemble + audition transcript
        asm = w.call("tts.assemble", {"project_id": pid, "paragraph_pause_ms": 600, "sentence_pause_ms": 250})
        master = Path(asm["master_path"])
        assert master.exists() and asm["duration_s"] > report["audio_s"] * 0.8
        audio, sr = sf.read(str(master))
        assert sr == 24000 and len(audio) > 0 and float(abs(audio).max()) > 0.01
        trm = w.call("transcribe.run", {"path": str(master), "device": "cpu"})
        report["asr_overlap_master"] = word_overlap(SCRIPT.replace("42", "forty two").replace("1999", "nineteen ninety nine"), trm["text"])
        report["master_transcript"] = trm["text"]
        assert report["asr_overlap_master"] >= 0.5, trm["text"]
        # 8. exports
        out_wav = w.call("export.render", {"project_id": pid, "format": "wav", "out_path": str(tmp_path / "out.wav"), "wav_bit_depth": 24,
                                           "loudness": {"target_id": "podcast-16"}})
        assert out_wav["probe"]["sample_rate"] == 24000 and out_wav["loudness_measured"]["integrated_lufs"] > -18
        out_mp3 = w.call("export.render", {"project_id": pid, "format": "mp3", "out_path": str(tmp_path / "out.mp3"), "mp3_bitrate_kbps": 192})
        assert Path(out_mp3["path"]).stat().st_size > 10_000 and out_mp3["probe"]["codec"] == "mp3"
        assert master.exists()  # never overwritten
        report["exports"] = [out_wav["path"], out_mp3["path"]]
        # 9. cancellation keeps finished segments: long script, cancel after the first segment completes
        p2 = w.call("projects.create", {"name": "cancel test", "voice_id": vid, "reference_id": ref_id, "engine_id": "qwen3-tts-base"})
        long_script = "\n\n".join(f"Paragraph {i}. This sentence exists only to keep the generator busy for a while." for i in range(1, 7))
        w.call("tts.plan", {"project_id": p2["id"], "script_text": long_script, "engine_id": "qwen3-tts-base", "options": {"max_chars": 100}})
        rid = w.start("tts.generate", {"project_id": p2["id"], "engine_id": "qwen3-tts-base", "reference_id": ref_id, "language": "en", "settings": {}})
        deadline = time.time() + 300
        while time.time() < deadline and not any(p["message"].startswith("Generating segment 2 of") for p in w.progress.get(rid, [])):
            time.sleep(0.2)
        w.cancel(rid)
        m = w.wait(rid, timeout=120)
        assert m["type"] == "error" and m["error"]["code"] == "CANCELLED", m
        kept = w.call("projects.get", {"id": p2["id"]})["segments"]
        done = [s for s in kept if s["selected_take_id"]]
        assert 1 <= len(done) < len(kept), (len(done), len(kept))
        report["cancel_kept_segments"] = len(done)
    finally:
        w.shutdown()
    assert not _engine_hosts_alive(), "engine host processes left running after shutdown"

    # 10. restart the worker and reopen the project
    w2 = WorkerClient(data, config, cache, models_dir())
    try:
        got = w2.call("projects.get", {"id": pid})
        assert len(got["segments"]) == len(segs) and all(s["selected_take_id"] for s in got["segments"])
        assert got["project"]["master_path"] and Path(got["project"]["master_path"]).exists()
        assert got["script"]["text"] == SCRIPT
        eng = w2.call("engine.list")
        q = next(e for e in eng["engines"] if e["id"] == "qwen3-tts-base")
        assert q["state"] == "unloaded"
        # 11. offline mode: no downloads, but cached model still works
        w2.call("system.set_offline", {"offline": True})
        with pytest.raises(WorkerFailure) as ei:
            w2.call("models.download", {"model_id": "faster-whisper-base.en"})
        assert ei.value.err["code"] == "OFFLINE_BLOCKED"
        one = w2.call("engine.generate", {"engine_id": "qwen3-tts-base", "reference_id": ref_id, "text": GENERATE_TEXT, "language": "en",
                                          "settings": {}, "out_dir": str(data / "exports" / "offline")}, timeout=600)
        assert one["duration_s"] > 1
        report["offline_generate_ok"] = True
    finally:
        w2.shutdown()
    record("e2e", report)


def _engine_hosts_alive() -> bool:
    out = subprocess.run(["pgrep", "-f", "shadowfetch_worker.engine_host"], capture_output=True, text=True).stdout
    return bool(out.strip())
