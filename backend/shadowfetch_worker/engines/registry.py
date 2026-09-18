"""Static engine descriptors (no torch imports here — safe for the main worker)."""
from __future__ import annotations

ENGINES: dict[str, dict] = {
    "qwen3-tts-base": {
        "id": "qwen3-tts-base",
        "name": "Qwen3-TTS 1.7B Base",
        "env": "main",
        "model_id": "qwen3-tts-12hz-1.7b-base",
        "adapter": "shadowfetch_worker.engines.qwen3_tts:Qwen3TTSAdapter",
        "optional": False,
        "description": "Reference-audio voice cloning (audio + transcript). Primary engine.",
    },
    "chatterbox-turbo": {
        "id": "chatterbox-turbo",
        "name": "Chatterbox-Turbo",
        "env": "chatterbox",
        "model_id": "chatterbox-turbo",
        "adapter": "shadowfetch_worker.engines.chatterbox_turbo:ChatterboxTurboAdapter",
        "optional": True,
        "description": "Optional secondary engine (Resemble AI). Keeps upstream Perth watermarking.",
    },
}


def load_adapter_class(engine_id: str):
    import importlib
    spec = ENGINES[engine_id]["adapter"]
    mod, cls = spec.split(":")
    return getattr(importlib.import_module(mod), cls)
