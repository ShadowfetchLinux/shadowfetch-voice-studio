"""Known models. Revisions are pinned at bootstrap time and recorded in docs/MODEL_LICENSES.md."""
from __future__ import annotations

# ASR required_files: faster-whisper 1.2.1 falls back to tokenizers.Tokenizer.from_pretrained("openai/whisper-…") — a
# network fetch that ignores HF_HUB_OFFLINE — when tokenizer.json is absent, and CTranslate2 needs the vocabulary file
# (vocabulary.txt in the Systran *.en repos, vocabulary.json in the multilingual deepdml repo).
MODELS: dict[str, dict] = {
    "qwen3-tts-12hz-1.7b-base": {
        "id": "qwen3-tts-12hz-1.7b-base", "kind": "tts", "engine_id": "qwen3-tts-base",
        "repo": "Qwen/Qwen3-TTS-12Hz-1.7B-Base", "revision": "fd4b254389122332181a7c3db7f27e918eec64e3",  # pinned (2026-01-23)
        "companions": [],   # the 12 Hz speech tokenizer is bundled in speech_tokenizer/ inside this repo
        "license": "Apache-2.0", "license_url": "https://huggingface.co/Qwen/Qwen3-TTS-12Hz-1.7B-Base",
        "approx_size_bytes": 4_540_000_000,
        # Everything Qwen3TTSModel.from_pretrained opens unconditionally (verified against the pinned snapshot):
        # generation_config.json (cached_file raises on a local dir without it), the AutoProcessor files and the
        # bundled speech tokenizer's own configs. A download killed between files leaves no *.incomplete blob for
        # files not yet started, so every one of them must be checked explicitly.
        "required_files": ["config.json", "model.safetensors", "generation_config.json", "preprocessor_config.json",
                           "tokenizer_config.json", "vocab.json", "merges.txt",
                           "speech_tokenizer/model.safetensors", "speech_tokenizer/config.json",
                           "speech_tokenizer/configuration.json", "speech_tokenizer/preprocessor_config.json"],
        "description": "Primary voice-cloning engine (Base checkpoint — the one that accepts uploaded reference audio).",
    },
    "chatterbox-turbo": {
        "id": "chatterbox-turbo", "kind": "tts", "engine_id": "chatterbox-turbo",
        "repo": "ResembleAI/chatterbox-turbo", "revision": "749d1c1a46eb10492095d68fbcf55691ccf137cd", "companions": [],
        "ignore_patterns": ["s3gen.safetensors"],   # 1.06 GB file the Turbo class never loads (from_local uses s3gen_meanflow)
        "license": "MIT", "license_url": "https://huggingface.co/ResembleAI/chatterbox-turbo",
        "approx_size_bytes": 2_990_000_000, "required_files": ["t3_turbo_v1.safetensors", "s3gen_meanflow.safetensors", "ve.safetensors", "conds.pt",
                                                                    "tokenizer_config.json", "vocab.json", "merges.txt"],   # the repo has no tokenizer.json (verified at the pinned revision); AutoTokenizer loads vocab+merges
        "description": "Optional secondary engine. Outputs carry Resemble's Perth watermark.",
    },
    "faster-whisper-small.en": {
        "id": "faster-whisper-small.en", "kind": "asr", "engine_id": None,
        "repo": "Systran/faster-whisper-small.en", "revision": None, "companions": [],
        "license": "MIT", "license_url": "https://huggingface.co/Systran/faster-whisper-small.en",
        "approx_size_bytes": 490_000_000, "required_files": ["model.bin", "config.json", "tokenizer.json", "vocabulary.txt"],
        "description": "English transcription, fast on CPU (default).",
    },
    "faster-whisper-base.en": {
        "id": "faster-whisper-base.en", "kind": "asr", "engine_id": None,
        "repo": "Systran/faster-whisper-base.en", "revision": None, "companions": [],
        "license": "MIT", "license_url": "https://huggingface.co/Systran/faster-whisper-base.en",
        "approx_size_bytes": 150_000_000, "required_files": ["model.bin", "config.json", "tokenizer.json", "vocabulary.txt"],
        "description": "Smaller/faster English transcription.",
    },
    "faster-whisper-large-v3-turbo": {
        "id": "faster-whisper-large-v3-turbo", "kind": "asr", "engine_id": None,
        "repo": "deepdml/faster-whisper-large-v3-turbo-ct2", "revision": None, "companions": [],
        "license": "MIT", "license_url": "https://huggingface.co/deepdml/faster-whisper-large-v3-turbo-ct2",
        "approx_size_bytes": 1_600_000_000, "required_files": ["model.bin", "config.json", "tokenizer.json", "vocabulary.json"],
        "description": "Multilingual, most accurate; best on GPU.",
    },
}
