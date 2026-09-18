#!/usr/bin/env python3
"""Memory preflight for the official Qwen3-TTS fine-tuning script (finetuning/sft_12hz.py).

Run with the main environment:  backend/.venv/bin/python scripts/finetune_preflight.py [--params 1.7e9] [--batch 1]
It measures free VRAM/host RAM and ESTIMATES what full-parameter bf16 AdamW training needs. It does not train.
"""
from __future__ import annotations

import argparse
import json
import shutil


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--params", type=float, default=1.7e9, help="talker parameters (Qwen3-TTS 1.7B Base ≈ 1.7e9)")
    ap.add_argument("--batch", type=int, default=1)
    ap.add_argument("--seq", type=int, default=1024, help="approx. text+codec tokens per sample")
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args()
    try:
        import torch
        cuda = torch.cuda.is_available()
        free, total = torch.cuda.mem_get_info() if cuda else (0, 0)
        name = torch.cuda.get_device_name(0) if cuda else "none"
    except Exception as e:  # noqa: BLE001
        cuda, free, total, name = False, 0, 0, f"torch unavailable: {e}"
    def estimate(params: float) -> dict:
        """Full fine-tuning as sft_12hz.py does it: Accelerator bf16 mixed precision + fp32 AdamW, no LoRA/8-bit."""
        weights = params * 2                 # bf16 weights
        grads = params * 2
        adam = params * 4 * 2                # exp_avg + exp_avg_sq (fp32)
        fp32_master = params * 4             # fp32 master params kept by mixed precision
        activations = a.batch * a.seq * 2048 * 28 * 2 * 8   # rough: hidden 2048, 28 layers, bf16, ~8 saved tensors/layer
        total_need = weights + grads + adam + fp32_master + activations
        return {"weights_bf16": weights, "grads": grads, "adam_states": adam, "fp32_master": fp32_master,
                "activations": activations, "total": total_need}

    est = estimate(a.params)
    small = estimate(0.6e9)["total"]
    need = est["total"]
    host_ram_peak = a.params * 2 * 2       # issue #365: checkpoint save peaks at ~2x model size in host RAM
    out = {"gpu": name, "vram_total_gb": round(total / 1e9, 1), "vram_free_gb": round(free / 1e9, 1),
           "estimate_gb": {k: round(v / 1e9, 1) for k, v in est.items()},
           "host_ram_peak_gb": round(host_ram_peak / 1e9, 1), "host_ram_free_gb": None,
           "fits": bool(cuda and need < total * 0.9)}
    try:
        with open("/proc/meminfo") as fh:
            for ln in fh:
                if ln.startswith("MemAvailable:"):
                    out["host_ram_free_gb"] = round(int(ln.split()[1]) * 1024 / 1e9, 1)
    except OSError:
        pass
    out["verdict"] = ("Full-parameter fine-tuning is estimated to need %.0f GB of VRAM; this GPU has %.0f GB — it will NOT fit. "
                      "The official script offers no LoRA/8-bit path; use a bigger GPU, or the 0.6B Base model (≈ %.0f GB, still tight)."
                      % (need / 1e9, total / 1e9, small / 1e9)
                      if not out["fits"] else "Estimated to fit (tight); expect OOM on longer samples — start with batch 1.")
    print(json.dumps(out, indent=2) if a.json else out["verdict"])
    return 0 if out["fits"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
