# Model licenses and provenance

Every model Shadowfetch Voice Studio can use is listed here with its pinned revision, license, size, and the exact
files the app reads. **No model weights are bundled in the application package.** The app downloads them from
Hugging Face only after the user sees the size and license and clicks *Download* (blocked entirely in offline mode),
and stores them under `<data>/models/hf/` (a standard Hugging Face cache: `models--<Org>--<Name>/{refs,snapshots,blobs}`).
Users may also point the app at an existing local copy (*Use existing folder*) — such folders are never copied or deleted.

The registry of record is `backend/shadowfetch_worker/models/registry.py`; this document must be kept in sync with it.
Sizes are the measured on-disk totals of a verified install (September 2026).

| id | repo | pinned revision | license | download size |
|----|------|-----------------|---------|---------------|
| `qwen3-tts-12hz-1.7b-base` | `Qwen/Qwen3-TTS-12Hz-1.7B-Base` | `fd4b254389122332181a7c3db7f27e918eec64e3` | Apache-2.0 | 4.54 GB |
| `chatterbox-turbo` | `ResembleAI/chatterbox-turbo` | `749d1c1a46eb10492095d68fbcf55691ccf137cd` | MIT | 2.99 GB |
| `faster-whisper-small.en` | `Systran/faster-whisper-small.en` | `refs/main` (installed: `d1d751a5f8271d482d14ca55d9e2deeebbae577f`) | MIT | 0.49 GB |
| `faster-whisper-base.en` | `Systran/faster-whisper-base.en` | `refs/main` | MIT | ~0.15 GB |
| `faster-whisper-large-v3-turbo` | `deepdml/faster-whisper-large-v3-turbo-ct2` | `refs/main` | MIT | ~1.6 GB |

---

## Qwen3-TTS 1.7B Base (`qwen3-tts-12hz-1.7b-base`)

- **Repo:** https://huggingface.co/Qwen/Qwen3-TTS-12Hz-1.7B-Base — pinned revision `fd4b254389122332181a7c3db7f27e918eec64e3` (2026-01-23).
- **License:** Apache License 2.0 — applies to both the inference code (`qwen-tts` 0.1.1, PyPI) and the weights
  (see the repo's `LICENSE`/model card). Commercial use and redistribution are permitted with attribution and
  inclusion of the license text; the app ships the license notice in `THIRD_PARTY_NOTICES.md`.
- **Role:** primary voice-cloning engine (the *Base* checkpoint is the one that accepts uploaded reference audio;
  the CustomVoice/VoiceDesign checkpoints are not used).
- **What is downloaded (whole repo, 13 files, 4,544,229,700 bytes):**
  `config.json`, `generation_config.json`, `model.safetensors` (3.86 GB), `merges.txt`, `vocab.json`,
  `tokenizer_config.json`, `preprocessor_config.json`, `README.md`, `.gitattributes`, and the bundled 12 Hz speech
  tokenizer `speech_tokenizer/{config.json, configuration.json, model.safetensors (0.68 GB), preprocessor_config.json}`.
- **Files the app actually uses:** everything `Qwen3TTSModel.from_pretrained(<snapshot>)` reads — `config.json`,
  `model.safetensors`, the tokenizer files, `generation_config.json`, and `speech_tokenizer/*`.
  Verification requires every file the loader opens unconditionally: `config.json`, `model.safetensors`, `generation_config.json`,
  `preprocessor_config.json`, `tokenizer_config.json`, `vocab.json`, `merges.txt`, `speech_tokenizer/{model.safetensors, config.json,
  configuration.json, preprocessor_config.json}` (a download killed between files leaves no `*.incomplete` marker for files not yet started).
- **Runtime:** bf16 on CUDA (~4.2 GB VRAM after load), fp32 on CPU; SDPA attention (no flash-attn on sm_120).
  Output: 24 kHz mono. No watermark is applied by the engine.
- **Redistribution notes:** weights are never part of the app package, an export, or a project backup. Reusable voice
  prompts (`<cache>/prompts/*.pt`) are derived from the user's reference audio, not from the weights, and are regenerable.

## Chatterbox-Turbo (`chatterbox-turbo`)

- **Repo:** https://huggingface.co/ResembleAI/chatterbox-turbo — pinned revision `749d1c1a46eb10492095d68fbcf55691ccf137cd`.
- **License:** MIT — code (`chatterbox-tts` 0.1.7, PyPI, github.com/resemble-ai/chatterbox) and weights (model card).
  Attribution: Resemble AI. The MIT notice ships in `THIRD_PARTY_NOTICES.md`.
- **Watermark:** every generated file carries Resemble's **Perth** implicit watermark (`resemble-perth`, applied on the
  CPU inside `ChatterboxTurboTTS.generate`). The app never disables, replaces or strips it — the adapter never touches
  `model.watermarker` — and `Capabilities.watermark == "perth"` is shown to the user. Exports keep it (WAV/FLAC losslessly;
  MP3 encoding may weaken it, which is an upstream property, not something the app does on purpose).
- **Role:** optional secondary English-only engine (separate Python environment `backend/envs/chatterbox`).
- **What is downloaded (12 of 13 files, 2,987,700,116 bytes):**
  `t3_turbo_v1.safetensors` (1.92 GB), `s3gen_meanflow.safetensors` (1.06 GB), `ve.safetensors` (5.7 MB), `conds.pt`
  (built-in default voice, 169 kB), `t3_turbo_v1.yaml`, tokenizer files `vocab.json`, `merges.txt`, `tokenizer_config.json`,
  `added_tokens.json`, `special_tokens_map.json`, `README.md`, `.gitattributes`.
  **Skipped on purpose:** `s3gen.safetensors` (1.06 GB) — the Turbo class loads the mean-flow vocoder only
  (`ignore_patterns: ["s3gen.safetensors"]` in the registry).
- **Files the app actually uses:** `ChatterboxTurboTTS.from_local(<snapshot>)` reads `ve.safetensors`,
  `t3_turbo_v1.safetensors`, `s3gen_meanflow.safetensors`, the tokenizer (`vocab.json` + `merges.txt` +
  `tokenizer_config.json` via `AutoTokenizer`; the repo has **no** `tokenizer.json`), and `conds.pt` when present.
  Verification requires `t3_turbo_v1.safetensors`, `s3gen_meanflow.safetensors`, `ve.safetensors`, `conds.pt`,
  `tokenizer_config.json`, `vocab.json`, `merges.txt`.
- **Runtime:** fp32 (~2.8 GB VRAM after load). Output: 24 kHz mono, Perth-watermarked. Reference clip must be > 5 s.
- **Redistribution notes:** as above — weights never bundled. The Perth watermark detector is part of the
  `resemble-perth` package (MIT); nothing in the app claims outputs are unwatermarked.

## faster-whisper models (`faster-whisper-small.en`, `faster-whisper-base.en`, `faster-whisper-large-v3-turbo`)

- **Repos:** https://huggingface.co/Systran/faster-whisper-small.en, https://huggingface.co/Systran/faster-whisper-base.en,
  https://huggingface.co/deepdml/faster-whisper-large-v3-turbo-ct2.
  These are CTranslate2 conversions of OpenAI's Whisper checkpoints. They are not pinned to a commit in the registry
  (`revision: None` → `refs/main`); the installed commit is recorded in the `models` table and shown in Settings
  (small.en installed here: `d1d751a5f8271d482d14ca55d9e2deeebbae577f`).
- **License:** MIT — the `faster-whisper` library (Systran, 1.2.1), the CTranslate2 conversions, and the original
  Whisper weights (OpenAI, MIT). Attribution to OpenAI and SYSTRAN ships in `THIRD_PARTY_NOTICES.md`.
- **Role:** transcribing reference clips (the transcript Qwen3-TTS needs) — CPU int8 by default, CUDA float16 optional.
- **What is downloaded:** the whole repo (small.en: `model.bin` 484 MB, `config.json`, `tokenizer.json`, `vocabulary.txt`,
  `README.md`, `.gitattributes`; large-v3-turbo additionally `preprocessor_config.json`, `vocabulary.json`).
- **Files the app actually uses:** `WhisperModel(<snapshot>)` reads `model.bin`, `config.json`, `tokenizer.json` and
  `vocabulary.*`. Verification requires `model.bin`, `config.json`, `tokenizer.json` and the repo's `vocabulary.txt` / `vocabulary.json`:
  without `tokenizer.json`, faster-whisper 1.2.1 silently fetches `openai/whisper-*` from the Hub (ignoring `HF_HUB_OFFLINE`), so the
  app refuses to load such a directory (`MODEL_INVALID`).
- **Redistribution notes:** weights never bundled; transcripts produced with these models belong to the user.

---

## Python packages that carry the engines (for completeness)

| package | version | license |
|---------|---------|---------|
| `qwen-tts` | 0.1.1 | Apache-2.0 |
| `chatterbox-tts` | 0.1.7 | MIT |
| `resemble-perth` | git master (PyPI 1.0.1 is broken on setuptools ≥ 81) | MIT |
| `faster-whisper` / `ctranslate2` | 1.2.1 / 4.8.x | MIT |
| `torch` / `torchaudio` (cu128) | 2.11.0 | BSD-3-Clause |
| `transformers` | 4.57.3 (main env), 5.2.0 (chatterbox env) | Apache-2.0 |

Full license texts: `docs/THIRD_PARTY_NOTICES.md`.

## User content

Reference recordings, transcripts, derived reference files, prompt caches, takes and masters are the user's own data.
The app requires the user to confirm they have the rights to clone a voice before a voice can be created
(`voices.create` needs `rights_confirmed: true`). Nothing is uploaded anywhere.
