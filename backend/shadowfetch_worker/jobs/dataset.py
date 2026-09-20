"""dataset.* — advanced: export a voice's recordings + corrected transcripts as a Qwen3-TTS fine-tuning dataset.

Format verified against QwenLM/Qwen3-TTS `finetuning/` (dataset.py / prepare_data.py / sft_12hz.py):
one JSON object per line with `audio` (24 kHz mono WAV of the target utterance), `text` (its transcript) and
`ref_audio` (the SAME 24 kHz mono reference WAV for every sample — the official collate concatenates reference mels).
This is data preparation only. Training itself is NOT run by the app (see docs/FINETUNING.md and the preflight).
"""
from __future__ import annotations

import json
import os
import time
from pathlib import Path
from typing import Any

from pydantic import BaseModel, Field

from ..paths import safe_filename
from ..protocol import INVALID_PARAMS, NOT_FOUND, WorkerError
from ..rpc import Ctx, method
from ..store import repo
from ..store.db import loads
from ..system.diagnostics import gpu_info, mem_info


class DatasetExport(BaseModel):
    voice_id: str
    out_dir: str                                  # user-picked directory (native dialog)
    reference_id: str | None = None               # default: the voice's selected reference
    include_project_takes: bool = False           # also add generated takes? No — only real recordings by default
    min_seconds: float = Field(default=1.0, ge=0.2)
    max_seconds: float = Field(default=30.0, ge=1.0)


def _out_dir(raw: str) -> Path:
    p = Path(raw).expanduser()
    if not p.is_absolute():
        raise WorkerError(INVALID_PARAMS, "out_dir must be an absolute path chosen with the folder dialog")
    p.mkdir(parents=True, exist_ok=True)
    return p


@method("dataset.export", params=DatasetExport)
def export_dataset(ctx: Ctx, p: DatasetExport) -> dict[str, Any]:
    """Write <out_dir>/<voice>/{train_raw.jsonl, wavs/*.wav, ref.wav, README.txt}."""
    from ..audio import edit
    st = ctx.server.state
    db = st["db"]
    voice = db.require("voices", p.voice_id)
    refs = db.all("SELECT * FROM voice_references WHERE voice_id = ? ORDER BY created_at, id", (p.voice_id,))
    if not refs:
        raise WorkerError(NOT_FOUND, "This voice has no references/recordings to export.")
    ref_id = p.reference_id or voice["selected_reference_id"] or refs[0]["id"]
    ref_row = next((r for r in refs if r["id"] == ref_id), None)
    if ref_row is None:
        raise WorkerError(NOT_FOUND, f"Reference {ref_id} not found on this voice.")
    root = _out_dir(p.out_dir) / safe_filename(voice["name"] or p.voice_id)
    wavs = root / "wavs"
    wavs.mkdir(parents=True, exist_ok=True)

    def asset_source(asset_id: str) -> Path | None:
        a = db.one("SELECT original_path, working_path FROM assets WHERE id = ?", (asset_id,))
        if not a:
            return None
        src = a["working_path"] or a["original_path"]
        return Path(src) if src and Path(src).exists() else None

    # the shared reference: the selected reference excerpt at 24 kHz mono
    ref_src = asset_source(ref_row["asset_id"])
    if ref_src is None:
        raise WorkerError(NOT_FOUND, "The selected reference's audio file is missing on disk.")
    ref_out = root / "ref.wav"
    ctx.progress("dataset", "Preparing the shared reference clip")
    edit.prepare_reference(ref_src, ref_out, 24000, channels=1, start_s=ref_row["start_s"], end_s=ref_row["end_s"])

    rows: list[dict[str, Any]] = []
    skipped: list[dict[str, Any]] = []
    total = len(refs)
    for i, r in enumerate(refs, 1):
        ctx.check_cancel()
        ctx.progress("dataset", f"Exporting utterance {i} of {total}", i, total)
        text = (r["transcript"] or "").strip()
        dur = float(r["end_s"]) - float(r["start_s"])
        if not text or not r["transcript_confirmed"]:
            skipped.append({"reference_id": r["id"], "reason": "transcript missing or not reviewed"})
            continue
        if dur < p.min_seconds or dur > p.max_seconds:
            skipped.append({"reference_id": r["id"], "reason": f"duration {dur:.1f}s outside {p.min_seconds}-{p.max_seconds}s"})
            continue
        src = asset_source(r["asset_id"])
        if src is None:
            skipped.append({"reference_id": r["id"], "reason": "audio missing on disk"})
            continue
        out = wavs / f"{safe_filename(r['id'])}.wav"
        edit.prepare_reference(src, out, 24000, channels=1, start_s=r["start_s"], end_s=r["end_s"])
        rows.append({"audio": str(out), "text": text, "ref_audio": str(ref_out), "language": voice["language"] or "Auto",
                     "duration_s": round(dur, 3), "reference_id": r["id"], "processing": loads(r["processing_json"], [])})
    jsonl = root / "train_raw.jsonl"
    with open(jsonl, "w", encoding="utf-8") as fh:
        for row in rows:
            fh.write(json.dumps({k: row[k] for k in ("audio", "text", "ref_audio", "language")}, ensure_ascii=False) + "\n")
    (root / "manifest.json").write_text(json.dumps({"voice": repo.voice_dict(db, voice, with_references=False), "reference_id": ref_id,
                                                     "rows": rows, "skipped": skipped, "exported_at": time.strftime("%Y-%m-%dT%H:%M:%S")},
                                                    indent=2, ensure_ascii=False, default=str))
    (root / "README.txt").write_text(
        "Shadowfetch Voice Studio — fine-tuning dataset export\n\n"
        "train_raw.jsonl follows QwenLM/Qwen3-TTS finetuning/: {audio, text, ref_audio} per line; every sample uses the same\n"
        "24 kHz mono ref.wav as the official collate requires. Next steps (outside this app; see docs/FINETUNING.md):\n"
        "  1. python finetuning/prepare_data.py --device cuda:0 --tokenizer_model_path Qwen/Qwen3-TTS-Tokenizer-12Hz \\\n"
        "       --input_jsonl train_raw.jsonl --output_jsonl train_with_codes.jsonl\n"
        "  2. python finetuning/sft_12hz.py --init_model_path <LOCAL Qwen3-TTS-12Hz-1.7B-Base dir> --output_model_path out \\\n"
        "       --train_jsonl train_with_codes.jsonl --batch_size 1 --lr 2e-5 --num_epochs 3 --speaker_name <name>\n"
        "Run scripts/finetune_preflight.py first: full-parameter fine-tuning of the 1.7B model does not fit in 16 GB.\n")
    os.chmod(root, 0o700)
    return {"path": str(root), "jsonl": str(jsonl), "samples": len(rows), "skipped": skipped, "reference": str(ref_out),
            "total_seconds": round(sum(r["duration_s"] for r in rows), 1)}


# ---------------------------------------------------------------- memory preflight (no training)

def estimate_finetune_bytes(params: float, batch: int = 1, seq: int = 1024) -> dict[str, float]:
    """VRAM estimate for official sft_12hz.py (bf16 + fp32 AdamW, no LoRA). Same formula as scripts/finetune_preflight.py."""
    weights = params * 2
    grads = params * 2
    adam = params * 4 * 2
    fp32_master = params * 4
    activations = batch * seq * 2048 * 28 * 2 * 8
    total = weights + grads + adam + fp32_master + activations
    return {"weights_bf16": weights, "grads": grads, "adam_states": adam, "fp32_master": fp32_master,
            "activations": activations, "total": total}


class DatasetPreflight(BaseModel):
    params: float = Field(default=1.7e9, gt=1e6)
    batch: int = Field(default=1, ge=1)
    seq: int = Field(default=1024, ge=64)


@method("dataset.preflight", params=DatasetPreflight)
def preflight(_ctx: Ctx, p: DatasetPreflight) -> dict[str, Any]:
    """Estimate whether official full-parameter Qwen fine-tuning fits this GPU. Does not train."""
    gpus = gpu_info()
    gpu = gpus[0] if gpus else {}
    total = int(gpu.get("vram_total_bytes") or 0)
    used = int(gpu.get("vram_used_bytes") or 0)
    free = max(total - used, 0)
    name = str(gpu.get("name") or "none")
    est = estimate_finetune_bytes(p.params, p.batch, p.seq)
    small = estimate_finetune_bytes(0.6e9, p.batch, p.seq)["total"]
    need = est["total"]
    mem = mem_info()
    fits = bool(total and need < total * 0.9)
    host_peak = p.params * 2 * 2
    if not fits:
        verdict = (f"Full-parameter fine-tuning is estimated to need {need / 1e9:.0f} GB of VRAM; "
                   f"this GPU has {total / 1e9:.0f} GB — it will NOT fit. The official script offers no LoRA/8-bit path; "
                   f"use a bigger GPU, or the 0.6B Base model (≈ {small / 1e9:.0f} GB, still tight).")
    else:
        verdict = "Estimated to fit (tight); expect OOM on longer samples — start with batch 1."
    return {
        "gpu": name,
        "vram_total_gb": round(total / 1e9, 1),
        "vram_free_gb": round(free / 1e9, 1),
        "estimate_gb": {k: round(v / 1e9, 1) for k, v in est.items()},
        "host_ram_peak_gb": round(host_peak / 1e9, 1),
        "host_ram_free_gb": round(mem.get("available_bytes", 0) / 1e9, 1) if mem.get("available_bytes") else None,
        "fits": fits,
        "verdict": verdict,
    }
