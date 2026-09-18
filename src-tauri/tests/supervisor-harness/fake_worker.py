#!/usr/bin/env python3
"""A tiny stand-in for `python -m shadowfetch_worker` (stdlib only, docs/PROTOCOL.md envelope).

Methods: system.ping, test.echo {..}, test.sleep {seconds, steps} (progress + cancellable),
test.event {event, data}, test.crash {code}, test.hang (stops answering, keeps running),
test.busy {seconds} (streams progress but ignores pings meanwhile), test.deaf (ignores shutdown).
Env: FAKE_WORKER_EXIT_ON_START=<code> exits before `ready`; FAKE_WORKER_READY_DELAY=<s>.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import threading
import time

ap = argparse.ArgumentParser()
ap.add_argument("--data-dir")
ap.add_argument("--config-dir")
ap.add_argument("--cache-dir")
args, _ = ap.parse_known_args()

code = os.environ.get("FAKE_WORKER_EXIT_ON_START")
if code:
    sys.stderr.write("fake worker exiting on start\n")
    sys.exit(int(code))
time.sleep(float(os.environ.get("FAKE_WORKER_READY_DELAY", "0")))

_lock = threading.Lock()
_cancelled: set[str] = set()
_hang = threading.Event()
_busy = threading.Event()
_deaf = threading.Event()


def send(obj: dict) -> None:
    with _lock:
        sys.stdout.write(json.dumps(obj) + "\n")
        sys.stdout.flush()


def result(rid: str, res: dict) -> None:
    send({"v": 1, "type": "result", "id": rid, "result": res})


def error(rid: str, code: str, message: str, details: dict | None = None, recoverable: bool = True) -> None:
    send({"v": 1, "type": "error", "id": rid,
          "error": {"code": code, "message": message, "details": details or {}, "recoverable": recoverable}})


def handle(req: dict) -> None:
    rid, m, p = req["id"], req.get("method", ""), req.get("params") or {}
    if _hang.is_set():
        return
    if m == "system.ping":
        if _busy.is_set():
            return
        result(rid, {"ok": True, "uptime_s": 0.0, "pid": os.getpid()})
    elif m == "test.busy":
        _busy.set()
        total, steps = float(p.get("seconds", 3.0)), int(p.get("steps", 30))
        for i in range(steps):
            send({"v": 1, "type": "progress", "id": rid, "stage": "busy", "message": f"Busy {i + 1} of {steps}",
                  "current": i + 1, "total": steps})
            time.sleep(total / steps)
        _busy.clear()
        result(rid, {"busy_s": total})
    elif m == "test.deaf":
        _deaf.set()
        result(rid, {"ok": True})
    elif m == "test.echo":
        result(rid, {"params": p, "data_dir": args.data_dir})
    elif m == "test.sleep":
        total, steps = float(p.get("seconds", 1.0)), int(p.get("steps", 10))
        for i in range(steps):
            if rid in _cancelled:
                error(rid, "CANCELLED", "Cancelled", {"done": i})
                return
            send({"v": 1, "type": "progress", "id": rid, "stage": "sleep", "message": f"Step {i + 1} of {steps}",
                  "current": i + 1, "total": steps})
            time.sleep(total / steps)
        result(rid, {"slept": total})
    elif m == "test.event":
        send({"v": 1, "type": "event", "event": p.get("event", "test"), "data": p.get("data", {})})
        result(rid, {"ok": True})
    elif m == "test.crash":
        sys.stderr.write("fake worker crashing on request\n")
        sys.stderr.flush()
        os._exit(int(p.get("code", 3)))
    elif m == "test.hang":
        _hang.set()
        sys.stderr.write("fake worker hanging\n")
        sys.stderr.flush()
    else:
        error(rid, "NOT_FOUND", f"Unknown method {m!r}", recoverable=False)


send({"v": 1, "type": "ready", "worker": "fake", "protocol": 1, "pid": os.getpid()})
sys.stderr.write(f"fake worker ready pid={os.getpid()} data={args.data_dir}\n")
sys.stderr.flush()
for raw in sys.stdin:
    raw = raw.strip()
    if not raw:
        continue
    msg = json.loads(raw)
    t = msg.get("type")
    if t == "request":
        threading.Thread(target=handle, args=(msg,), daemon=True).start()
    elif t == "cancel":
        _cancelled.add(str(msg.get("id")))
    elif t == "shutdown":
        if _deaf.is_set():
            sys.stderr.write("fake worker ignoring shutdown\n")
            continue
        sys.stderr.write("fake worker shutdown\n")
        break
