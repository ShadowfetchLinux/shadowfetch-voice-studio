"""Where the Python environments live (dev checkout vs. managed runtime) and how engine ids map to them."""
from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

from .paths import AppPaths

BACKEND_DIR = Path(__file__).resolve().parent.parent          # .../backend
ENGINE_ENV = {"qwen3-tts-base": "main", "chatterbox-turbo": "chatterbox"}
ENV_IDS = ("main", "chatterbox")


class Runtime:
    def __init__(self, paths: AppPaths):
        self.paths = paths
        self.root = Path(os.environ.get("SFVS_RUNTIME_DIR") or (paths.data / "runtime"))
        self.root.mkdir(parents=True, exist_ok=True)

    def env_python(self, env_id: str) -> Path | None:
        if env_id == "main":
            return Path(sys.executable)
        override = os.environ.get(f"SFVS_ENV_{env_id.upper()}_PYTHON")
        cands = [Path(override)] if override else []
        cands += [self.root / "envs" / env_id / "bin" / "python", BACKEND_DIR / "envs" / env_id / "bin" / "python"]
        for c in cands:
            if c.exists():
                return c
        return None

    def env_for_engine(self, engine_id: str) -> str:
        return ENGINE_ENV.get(engine_id, "main")

    def python_for_engine(self, engine_id: str) -> Path | None:
        return self.env_python(self.env_for_engine(engine_id))

    # ---- cached environment probe (torch/cuda) so diagnostics stay cheap
    def probe_env(self, env_id: str, force: bool = False, timeout: float = 90) -> dict[str, Any]:
        py = self.env_python(env_id)
        cache = self.paths.cache / f"envprobe-{env_id}.json"
        if py is None:
            return {"installed": False, "error": "environment not installed"}
        if not force and cache.exists():
            try:
                data = json.loads(cache.read_text())
                if data.get("python_path") == str(py) and time.time() - data.get("ts", 0) < 6 * 3600:
                    return data
            except ValueError:
                pass
        code = (
            "import json,sys\n"
            "out={'installed':True,'python':sys.version.split()[0],'python_path':sys.executable}\n"
            "try:\n"
            "  import torch\n"
            "  out['torch']=torch.__version__; out['cuda_available']=torch.cuda.is_available()\n"
            "  out['cuda_version']=getattr(torch.version,'cuda',None)\n"
            "  if torch.cuda.is_available():\n"
            "    out['cuda_device']=torch.cuda.get_device_name(0); out['capability']=list(torch.cuda.get_device_capability(0))\n"
            "    out['arch_list']=torch.cuda.get_arch_list()\n"
            "except Exception as e: out['torch_error']=str(e)[:300]\n"
            "for m in ('qwen_tts','chatterbox','faster_whisper','sounddevice','soundfile'):\n"
            "  try:\n"
            "    mod=__import__(m); out['pkg_'+m]=getattr(mod,'__version__','ok')\n"
            "  except Exception as e: out['pkg_'+m]=None\n"
            "print(json.dumps(out))\n"
        )
        try:
            r = subprocess.run([str(py), "-c", code], capture_output=True, text=True, timeout=timeout,
                               env={**os.environ, "PYTHONIOENCODING": "utf-8"})
            line = [ln for ln in r.stdout.splitlines() if ln.startswith("{")]
            data = json.loads(line[-1]) if line else {"installed": True, "error": (r.stderr or "no output")[-400:]}
        except (OSError, subprocess.SubprocessError, ValueError) as e:
            data = {"installed": True, "error": str(e)[:300]}
        data["ts"] = time.time()
        data["python_path"] = str(py)
        try:
            cache.write_text(json.dumps(data))
        except OSError:
            pass
        return data

    def env_summary(self) -> dict[str, Any]:
        return {env: self.probe_env(env) for env in ENV_IDS}
