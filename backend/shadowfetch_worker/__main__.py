"""Entry point: `python -m shadowfetch_worker --data-dir ... --config-dir ... --cache-dir ...`"""
from __future__ import annotations

import argparse
import logging
import os
import sys


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="shadowfetch_worker")
    ap.add_argument("--data-dir")
    ap.add_argument("--config-dir")
    ap.add_argument("--cache-dir")
    ap.add_argument("--models-dir")
    ap.add_argument("--worker-name", default="main")
    ap.add_argument("--gpu-slots", type=int, default=None)
    ap.add_argument("--log-level", default="INFO")
    args = ap.parse_args(argv)

    from .logging_setup import protect_stdout, setup_logging
    real_stdout = protect_stdout()
    from .paths import AppPaths
    from .rpc import Server, Transport
    from .runtime import Runtime
    from .settings import SettingsStore
    from .store.db import Database

    paths = AppPaths.build(args.data_dir, args.config_dir, args.cache_dir, args.models_dir)
    settings = SettingsStore(paths.settings_file)
    if settings.value.models_dir:
        paths = AppPaths.build(args.data_dir, args.config_dir, args.cache_dir, settings.value.models_dir)
    setup_logging(paths.logs, "worker", redact=settings.value.redact_logs, level=getattr(logging, args.log_level.upper(), logging.INFO))
    log = logging.getLogger("main")
    log.info("starting worker pid=%s data=%s", os.getpid(), paths.data)

    # Offline mode must be in force before any HF/transformers import happens in this or child processes
    if settings.value.offline:
        for k in ("HF_HUB_OFFLINE", "TRANSFORMERS_OFFLINE", "HF_DATASETS_OFFLINE"):
            os.environ[k] = "1"
    os.environ.setdefault("HF_HUB_CACHE", str(paths.hf_cache))
    os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
    os.environ.setdefault("DO_NOT_TRACK", "1")
    os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")

    transport = Transport(real_stdout)
    server = Server(transport, worker_name=args.worker_name, gpu_slots=args.gpu_slots or settings.value.gpu_jobs)
    server.state.update({"paths": paths, "settings": settings, "runtime": Runtime(paths), "db": Database(paths.db_file)})

    from . import jobs  # noqa: F401  (registers methods)
    try:
        from .engines.manager import EngineManager
        server.state["engines"] = EngineManager(server)
        server.on_shutdown = server.state["engines"].shutdown_all
    except ImportError as e:
        log.warning("engine manager unavailable: %s", e)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        server.shutdown()
    return 0


if __name__ == "__main__":
    sys.exit(main())
