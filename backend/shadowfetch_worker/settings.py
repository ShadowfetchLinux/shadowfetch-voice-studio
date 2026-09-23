"""Persisted app settings (JSON in the config dir)."""
from __future__ import annotations

import json
import os
import threading
from pathlib import Path
from typing import Any

from pydantic import BaseModel, Field


class Settings(BaseModel):
    offline: bool = False
    models_dir: str = ""                 # "" = <data>/models
    default_engine: str = "qwen3-tts-base"
    default_language: str = "en"
    asr_model: str = "faster-whisper-small.en"
    asr_device: str = "cpu"              # cpu | cuda
    gpu_jobs: int = 1
    idle_unload_minutes: int = 15        # 0 = never
    record_sample_rate: int = 48000
    record_subtype: str = "PCM_24"
    record_device_index: int | None = None
    output_device_index: int | None = None
    monitor_input: bool = False          # playback monitoring off by default (feedback)
    max_chars_per_segment: int = 400
    paragraph_pause_ms: int = 600
    sentence_pause_ms: int = 250
    export_default_format: str = "wav"
    export_wav_bit_depth: int = 24
    export_mp3_bitrate_kbps: int = 192
    export_ai_metadata: bool = True
    redact_logs: bool = True
    onboarding_done: bool = False
    rights_notice_accepted: bool = False
    engine_settings: dict[str, dict[str, Any]] = Field(default_factory=dict)   # per-engine last-used controls
    # Speak screen
    speak_project_id: str | None = None  # the hidden scratch project behind Speak (created on first use)
    speak_autoplay: bool = True          # play the result as soon as it is ready
    export_loudness_target: str | None = None   # Save Audio: optional named loudness target (audio/export.py)
    extra: dict[str, Any] = Field(default_factory=dict)


class SettingsStore:
    def __init__(self, path: Path):
        self.path = path
        self._lock = threading.Lock()
        self.value = self._load()

    def _load(self) -> Settings:
        try:
            return Settings.model_validate(json.loads(self.path.read_text()))
        except (OSError, ValueError):
            return Settings()

    def save(self) -> None:
        with self._lock:
            tmp = self.path.with_suffix(".json.tmp")
            tmp.write_text(json.dumps(self.value.model_dump(), indent=2))
            os.replace(tmp, self.path)
            try:
                os.chmod(self.path, 0o600)
            except OSError:
                pass

    def patch(self, patch: dict[str, Any]) -> Settings:
        data = self.value.model_dump()
        data.update({k: v for k, v in patch.items() if k in Settings.model_fields})
        self.value = Settings.model_validate(data)
        self.save()
        return self.value
