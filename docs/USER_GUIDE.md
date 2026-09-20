# User guide

## First run

Home shows **three steps**: New voice → Create speech → Library. You can start a voice immediately.
Setup (FFmpeg, NVIDIA GPU, Python engine runtime, audio devices, storage, model weights) is still
available from Home if something is missing — come back when recording or generation asks for it.

Each model shows its source repository, pinned revision, license and download size *before* you
download it. Chatterbox-Turbo is optional. Nothing is downloaded without your click, and a partial
download is never reported as installed (use **Verify** if in doubt). You can also point the app at an
existing model folder. The engine runtime is a standalone copy under the app data folder, not the
source tree.

## New voice (Voices)

The **New voice** button (or `n`) opens the wizard on the right. Nothing is stored until you save.

1. **Source** — record with the microphone (pick the device, watch the level meter; clipping is flagged) or
   import WAV/MP3/FLAC (dialog or drag-and-drop). Three guided reading scripts are provided; 30–60 s of natural
   speech is a good session. Input monitoring is off by default (speakers + a live mic make a
   feedback loop). Turn it on under Settings → Audio devices if you wear headphones.
2. **Review & trim** — pick a clean 8–15 s excerpt with the trim handles (**Undo trim** / Ctrl+Z restores the
   previous range); the app shows the engine's own limits (Qwen: more than 3 s; Chatterbox: more than 5 s,
   first 10–15 s used). Measurements (peak, silence, clipping) are labelled as heuristics. Optional processing
   (peak normalise, trim silence, high-pass) is off by default, previewable and applied to a copy — the original
   is never modified. The saved profile lists that processing history on the derived copy.
3. **Transcript** — transcribe the excerpt locally (faster-whisper on CPU by default) and *correct it*; you must
   tick "I reviewed this transcript". Changing the selection marks the transcript stale.
4. **Save** — name, tags, language, and the rights confirmation. Saving a profile stores audio + transcript
   (the source of truth); engine prompts are caches rebuilt automatically when anything changes. After save you
   can retrim a reference (the transcript is marked unreviewed) or open **Dataset workspace** to correct
   recordings and export a Qwen3-TTS fine-tuning JSONL. There is no Train button — full-parameter 1.7B SFT
   does not fit in 16 GB of VRAM (see `docs/FINETUNING.md`).

## Create

Write or import a script (large editor with autosave), choose a voice/reference and engine, and generate a
preview (first segment) or the full script. Long scripts are split at sentence boundaries into segments that fit
the engine; numbers can be spelled out and pronunciation substitutions applied — every substitution is listed
per segment. Progress is measured ("Generating segment 3 of 12"). Regenerate a single segment without losing the
others; every generation is a **take** you can compare and select. **Assemble** joins the selected takes with
configurable sentence/paragraph pauses (silence trimmed conservatively, short fades, no overlaps).

Only controls the selected engine actually supports are shown (Qwen: sampling controls; Chatterbox: sampling
controls, reference loudness normalisation and its nine paralinguistic tags). There are no universal
"stability" or "emotion" sliders because the engines do not have them. Seeds are saved with takes; the same seed
reproduces a take on one machine but is not guaranteed across environments.

## Library

Search, tags, favourites, folders, duplicate, archive, delete (confirmed; references and originals are never
cascade-deleted). Export the master as WAV (16/24-bit or float), FLAC or MP3 (bitrate/VBR); keep the engine's
native 24 kHz or make a 48 kHz copy (upsampling adds no detail). Optional loudness normalisation to a *named*
target (Podcast −16 LUFS, Streaming −14, EBU R128 −23) is measured after export. Exports can carry
"AI-generated speech" metadata; Chatterbox output additionally keeps Resemble's Perth watermark. Backups are
portable zips (metadata JSON + audio) with size and path-traversal protection on restore.

## Settings

Audio devices (including optional input monitoring — headphones only), engines & models (download / verify /
use existing folder / remove / load / unload, idle unload), storage (usage, clear regenerable caches —
recordings and masters are never touched), privacy (offline mode blocks every network request; logs are
redacted; local storage is not encrypted), and advanced options. A fine-tuned Qwen folder whose `config.json`
says `tts_model_type: custom_voice` is loaded as a speaker-driven checkpoint rather than a reference clone.

## Keyboard

`n` New voice · `1`–`5` switch pages · `Ctrl+Enter` generate full · `Ctrl+Shift+Enter` preview · `Esc` cancel ·
arrows nudge trim handles (Shift for larger steps) · `Ctrl+Z` undoes the last trim change · `Space` toggles
master playback when the editor is not focused · `?` shortcut list.
