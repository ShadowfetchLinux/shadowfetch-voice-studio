"""Actual hardware / software detection. Nothing here is hardcoded to a particular machine."""
from __future__ import annotations

import os
import platform
import re
import shutil
import subprocess
from pathlib import Path
from typing import Any

from ..paths import AppPaths, free_bytes


def _run(cmd: list[str], timeout: float = 10) -> str:
    try:
        return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout).stdout
    except (OSError, subprocess.SubprocessError):
        return ""


def os_info() -> dict[str, Any]:
    info = {"system": platform.system(), "release": platform.release(), "machine": platform.machine(), "pretty": ""}
    try:
        for ln in Path("/etc/os-release").read_text().splitlines():
            if ln.startswith("PRETTY_NAME="):
                info["pretty"] = ln.split("=", 1)[1].strip().strip('"')
    except OSError:
        pass
    info["session"] = os.environ.get("XDG_SESSION_TYPE", "")
    info["desktop"] = os.environ.get("XDG_CURRENT_DESKTOP", "")
    return info


def cpu_info() -> dict[str, Any]:
    name = ""
    try:
        for ln in Path("/proc/cpuinfo").read_text().splitlines():
            if ln.startswith("model name"):
                name = ln.split(":", 1)[1].strip()
                break
    except OSError:
        pass
    return {"name": name, "threads": os.cpu_count() or 0}


def mem_info() -> dict[str, int]:
    out = {"total_bytes": 0, "available_bytes": 0}
    try:
        for ln in Path("/proc/meminfo").read_text().splitlines():
            if ln.startswith("MemTotal:"):
                out["total_bytes"] = int(ln.split()[1]) * 1024
            elif ln.startswith("MemAvailable:"):
                out["available_bytes"] = int(ln.split()[1]) * 1024
    except OSError:
        pass
    return out


def gpu_info() -> list[dict[str, Any]]:
    if not shutil.which("nvidia-smi"):
        return []
    out = _run(["nvidia-smi", "--query-gpu=index,name,driver_version,memory.total,memory.used,utilization.gpu,compute_cap,temperature.gpu",
                "--format=csv,noheader,nounits"])
    gpus = []
    for ln in out.splitlines():
        parts = [p.strip() for p in ln.split(",")]
        if len(parts) < 6:
            continue
        try:
            gpus.append({
                "index": int(parts[0]), "name": parts[1], "driver": parts[2],
                "vram_total_bytes": int(float(parts[3])) * 1024 * 1024, "vram_used_bytes": int(float(parts[4])) * 1024 * 1024,
                "utilization_pct": int(float(parts[5])) if parts[5] not in ("[N/A]", "") else None,
                "compute_cap": parts[6] if len(parts) > 6 else None,
                "temperature_c": int(float(parts[7])) if len(parts) > 7 and parts[7] not in ("[N/A]", "") else None,
            })
        except ValueError:
            continue
    return gpus


def tool_version(name: str) -> dict[str, Any] | None:
    path = shutil.which(name)
    if not path:
        return None
    out = _run([path, "-version"])
    m = re.search(r"version\s+(\S+)", out)
    return {"path": path, "version": m.group(1) if m else ""}


def audio_devices() -> dict[str, Any]:
    try:
        import sounddevice as sd
    except Exception as e:  # noqa: BLE001
        return {"inputs": [], "outputs": [], "error": f"sounddevice unavailable: {e}"}
    try:
        devs = sd.query_devices()
        apis = sd.query_hostapis()
    except Exception as e:  # noqa: BLE001
        return {"inputs": [], "outputs": [], "error": str(e)}
    inputs, outputs = [], []
    for i, d in enumerate(devs):
        api = apis[d["hostapi"]]["name"] if 0 <= d["hostapi"] < len(apis) else ""
        entry = {"index": i, "name": d["name"], "hostapi": api, "max_input_channels": d["max_input_channels"],
                 "max_output_channels": d["max_output_channels"], "default_samplerate": d["default_samplerate"]}
        if d["max_input_channels"] > 0:
            inputs.append(entry)
        if d["max_output_channels"] > 0:
            outputs.append(entry)
    try:
        din, dout = sd.default.device
    except Exception:  # noqa: BLE001
        din, dout = None, None
    return {"inputs": inputs, "outputs": outputs, "default_input": din if din is not None and din >= 0 else None,
            "default_output": dout if dout is not None and dout >= 0 else None,
            "hostapis": [a["name"] for a in apis]}


def disk_info(path: Path) -> dict[str, Any]:
    st = os.statvfs(path)
    return {"path": str(path), "free_bytes": st.f_bavail * st.f_frsize, "total_bytes": st.f_blocks * st.f_frsize}


def diagnostics(paths: AppPaths, runtime, offline: bool) -> dict[str, Any]:
    ffmpeg = tool_version("ffmpeg")
    ffprobe = tool_version("ffprobe")
    return {
        "os": os_info(), "cpu": cpu_info(), "ram": mem_info(), "gpus": gpu_info(),
        "disk": disk_info(paths.data),
        "models_disk": disk_info(paths.models),
        "ffmpeg": ffmpeg, "ffprobe": ffprobe,
        "python": {"main": {"version": platform.python_version(), "path": os.sys.executable}, "engines": runtime.env_summary()},
        "audio": audio_devices(),
        "offline": offline,
        "data_dir": str(paths.data), "models_dir": str(paths.models), "config_dir": str(paths.config), "cache_dir": str(paths.cache),
        "warnings": [w for w in (
            None if ffmpeg else "FFmpeg was not found on PATH (sudo apt install ffmpeg).",
            None if gpu_info() else "No NVIDIA GPU detected by nvidia-smi; engines will run on CPU (slow).",
            None if free_bytes(paths.data) > 5_000_000_000 else "Less than 5 GB free in the data directory.",
        ) if w],
    }
