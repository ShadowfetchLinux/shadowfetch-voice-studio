"""dataset.export + dataset.preflight (no training)."""
from __future__ import annotations

from pathlib import Path

import pytest

import shadowfetch_worker.jobs.dataset  # noqa: F401
from shadowfetch_worker.jobs.dataset import estimate_finetune_bytes
from shadowfetch_worker.protocol import WorkerError

try:
    from tests.test_store import call, install_fake_audio, make_server, make_voice
except ImportError:  # pragma: no cover
    from test_store import call, install_fake_audio, make_server, make_voice


@pytest.fixture
def server(tmp_path, monkeypatch):
    install_fake_audio(monkeypatch)
    return make_server(tmp_path)


def test_estimate_1_7b_exceeds_16gb():
    need = estimate_finetune_bytes(1.7e9)["total"]
    assert need > 16e9


def test_preflight_reports_verdict(server):
    r = call(server, "dataset.preflight", {})
    assert "verdict" in r and "estimate_gb" in r
    assert r["estimate_gb"]["total"] > 16


def test_export_skips_unreviewed_and_writes_jsonl(server, tmp_path):
    v = make_voice(server)
    out = tmp_path / "ds"
    with pytest.raises(WorkerError):
        call(server, "dataset.export", {"voice_id": v["id"], "out_dir": "relative"})
    res = call(server, "dataset.export", {"voice_id": v["id"], "out_dir": str(out)})
    assert res["samples"] == 1
    jsonl = Path(res["jsonl"])
    assert jsonl.is_file()
    line = jsonl.read_text().strip()
    assert '"audio"' in line and '"text"' in line and '"ref_audio"' in line
    assert Path(res["reference"]).is_file()
