# Fine-tuning (advanced, outside the app)

Shadowfetch Voice Studio clones voices by **reference conditioning** — saving a voice profile is not training.
For users who want to go further, the app can export a dataset in the format of the official Qwen3-TTS
fine-tuning workflow (`finetuning/` in https://github.com/QwenLM/Qwen3-TTS, verified 2026-09-17). The app
does **not** run training and has no Train button, because full-parameter fine-tuning of the 1.7B model does not
fit in 16 GB of VRAM (see the preflight).

## 1. Export a dataset
Voices → select a voice → **Dataset workspace** (review transcripts, run `dataset.preflight`, then `dataset.export`). It writes:

```
<folder>/<voice name>/
  train_raw.jsonl     one line per reviewed recording: {"audio": "...wav", "text": "...", "ref_audio": ".../ref.wav", "language": "en"}
  wavs/*.wav          each utterance as 24 kHz mono WAV (what dataset.py asserts)
  ref.wav             the voice's selected reference — the SAME file for every sample (the official collate concatenates
                      reference mels, so mixed references would fail)
  manifest.json       what was included/skipped and why (unreviewed transcripts and clips outside 1–30 s are skipped)
```
Add more reviewed recordings to the voice (Voices → Add reference) to grow the dataset. Single-speaker only —
that is all the official script supports.

## 2. Preflight
```bash
backend/.venv/bin/python scripts/finetune_preflight.py
```
Estimates VRAM for `sft_12hz.py` (bf16 weights + grads + fp32 AdamW states + fp32 master copy + activations).
On this machine (RTX 5060 Ti 16 GB) the answer is **does not fit** (~28 GB for 1.7B; ~11 GB for the 0.6B Base
which may fit at batch 1). Exit code 2 = does not fit.

## 3. Official entry points (run in a git checkout of Qwen3-TTS with the main env)
```bash
git clone https://github.com/QwenLM/Qwen3-TTS && cd Qwen3-TTS
# prepare: adds audio_codes using the separate 12 Hz tokenizer repo (≈0.7 GB download)
../backend/.venv/bin/python finetuning/prepare_data.py --device cuda:0 --tokenizer_model_path Qwen/Qwen3-TTS-Tokenizer-12Hz \
    --input_jsonl <export>/train_raw.jsonl --output_jsonl train_with_codes.jsonl
# train: --init_model_path must be a LOCAL directory (e.g. the app's snapshot under
#   ~/.local/share/com.shadowfetch.voicestudio/models/hf/models--Qwen--Qwen3-TTS-12Hz-1.7B-Base/snapshots/<sha>/)
../backend/.venv/bin/python finetuning/sft_12hz.py --init_model_path <local model dir> --output_model_path out \
    --train_jsonl train_with_codes.jsonl --batch_size 1 --lr 2e-5 --num_epochs 3 --speaker_name myvoice
```
Known caveats from the upstream repository: `sft_12hz.py` hard-codes `attn_implementation="flash_attention_2"` —
edit it to `"sdpa"` on this GPU (no flash-attn build for sm_120); checkpoint saving peaks at ~2× model size in
host RAM and is not atomic; reports of progressively faster speech per epoch and lower similarity than zero-shot
cloning exist.

## 4. Load the checkpoint in the app
A fine-tuned `output_model_path` is a `custom_voice` checkpoint. In Settings → Engines & models, choose
**Use existing folder** for the Qwen model and point it at that directory. After **Load**, the adapter reads
`tts_model_type` from `config.json`. Generation then calls `generate_custom_voice` with the trained speaker
name (shown as an engine control) instead of reference-audio cloning. A leftover reference on the project is
ignored for that generation.
