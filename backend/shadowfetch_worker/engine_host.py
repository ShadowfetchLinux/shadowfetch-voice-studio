"""Engine host process: `python -m shadowfetch_worker.engine_host --engine <id>`.

Loads exactly one adapter and serves engine.* methods over the worker protocol. stdout is reserved for the
protocol; all library logging goes to stderr (captured by the main worker into logs/engine-<id>.log).
"""
from __future__ import annotations

import argparse
import logging
import os
import sys
import time
from pathlib import Path
from typing import Any

from pydantic import BaseModel


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--engine", required=True)
    args = ap.parse_args(argv)

    from .logging_setup import RedactingFormatter, protect_stdout
    real_stdout = protect_stdout()
    h = logging.StreamHandler(sys.stderr)
    h.setFormatter(RedactingFormatter("%(asctime)s %(levelname)s %(name)s: %(message)s", redact=True))
    logging.basicConfig(level=logging.INFO, handlers=[h])
    log = logging.getLogger("engine_host")

    from .engines.registry import load_adapter_class
    from .protocol import GPU_OOM, MODEL_LOAD_FAILED, WorkerError
    from .rpc import Ctx, Server, Transport, method

    adapter = load_adapter_class(args.engine)()

    @method("engine.caps")
    def caps(ctx: Ctx, params: dict[str, Any]) -> dict[str, Any]:
        return adapter.capabilities().model_dump()

    class LoadParams(BaseModel):
        model_dir: str
        device: str = "cuda"
        dtype: str = "bfloat16"
        revision: str | None = None

    @method("engine.load", gpu=True, params=LoadParams)
    def load(ctx: Ctx, p: LoadParams) -> dict[str, Any]:
        t0 = time.time()
        try:
            res = adapter.load(Path(p.model_dir), device=p.device, dtype=p.dtype, progress=lambda m: ctx.progress("engine", m))
        except MemoryError:
            raise WorkerError(GPU_OOM, "Out of memory while loading the model")
        except WorkerError:
            raise
        except Exception as e:  # noqa: BLE001
            log.exception("load failed")
            low = str(e).lower()
            if "out of memory" in low:
                raise WorkerError(GPU_OOM, "The GPU ran out of memory while loading the model.", {"exception": str(e)[:400]})
            raise WorkerError(MODEL_LOAD_FAILED, f"Could not load the model: {str(e)[:400]}", {"exception": str(e)[:800]})
        res = dict(res or {})
        res.setdefault("revision", p.revision)
        res["load_ms"] = int((time.time() - t0) * 1000)
        try:
            import torch
            if torch.cuda.is_available():
                res["vram_bytes"] = int(torch.cuda.memory_allocated())
        except Exception:  # noqa: BLE001
            pass
        return res

    @method("engine.unload")
    def unload(ctx: Ctx, params: dict[str, Any]) -> dict[str, Any]:
        adapter.unload()
        return {"ok": True}

    class PrepareParams(BaseModel):
        reference_path: str
        transcript: str = ""
        language: str = "auto"
        cache_path: str
        settings: dict[str, Any] = {}     # engine controls that shape the prompt (e.g. Chatterbox norm_loudness)

    @method("engine.prepare", gpu=True, params=PrepareParams)
    def prepare(ctx: Ctx, p: PrepareParams) -> dict[str, Any]:
        return adapter.prepare_reference(Path(p.reference_path), p.transcript, p.language, Path(p.cache_path), settings=p.settings)

    class GenParams(BaseModel):
        text: str
        language: str
        reference_path: str | None = None     # at least one of reference_path / prompt_cache_path must be usable
        transcript: str = ""
        out_path: str
        settings: dict[str, Any] = {}
        seed: int | None = None
        prompt_cache_path: str | None = None

    @method("engine.generate", gpu=True, params=GenParams)
    def generate(ctx: Ctx, p: GenParams) -> dict[str, Any]:
        try:
            res = adapter.generate(p.text, p.language, Path(p.reference_path) if p.reference_path else None, p.transcript, Path(p.out_path),
                                   p.settings, p.seed, Path(p.prompt_cache_path) if p.prompt_cache_path else None, cancel_check=ctx.check_cancel)
        except WorkerError:
            raise
        except Exception as e:  # noqa: BLE001
            low = str(e).lower()
            if "out of memory" in low:
                try:
                    import torch
                    torch.cuda.empty_cache()
                except Exception:  # noqa: BLE001
                    pass
                raise WorkerError(GPU_OOM, "The GPU ran out of memory during generation. Try a shorter segment or unload other models.",
                                  {"exception": str(e)[:400]})
            log.exception("generate failed")
            raise
        return res.model_dump() if hasattr(res, "model_dump") else res

    @method("engine.health")
    def health(ctx: Ctx, params: dict[str, Any]) -> dict[str, Any]:
        out = adapter.health()
        try:
            import torch
            if torch.cuda.is_available():
                free, total = torch.cuda.mem_get_info()
                out.update({"vram_free_bytes": free, "vram_total_bytes": total, "vram_allocated_bytes": torch.cuda.memory_allocated()})
        except Exception:  # noqa: BLE001
            pass
        return out

    server = Server(Transport(real_stdout), worker_name=f"engine:{args.engine}", max_workers=4, gpu_slots=1,
                    on_shutdown=lambda: adapter.unload())
    server.serve_forever()
    return 0


if __name__ == "__main__":
    sys.exit(main())
