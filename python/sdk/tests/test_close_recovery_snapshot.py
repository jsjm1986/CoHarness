"""Project retried SDK teardown through a complete model-owning runtime."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from deepseek_harness import DeepSeekHarness
from deepseek_harness.errors import TransportClosedError

ROOT = Path(__file__).resolve().parents[3]
CLI = ROOT / "apps/cli/lib/bin.js"
PLUGIN = ROOT / "packages/sdk/client/tests/fixtures/close-recovery-runtime.mjs"


@pytest.mark.skipif(not CLI.exists(), reason="requires the built dsh CLI")
def test_full_runtime_close_recovery(tmp_path: Path, monkeypatch) -> None:
    marker = tmp_path / "cleanup-entered"
    patch = tmp_path / "runtime.patch.yml"
    patch.write_text(json.dumps([
        {"id": "llm-deepseek", "disabled": True},
        {"id": "agent-instructions", "disabled": True},
        {"id": "skill-filesystem", "config": {"includeDefaultRoots": False}},
        {"insert": [{"id": "close-recovery-runtime", "name": PLUGIN.as_uri(), "config": {"marker": str(marker)}}]},
    ]))
    harness = DeepSeekHarness(
        dsh_bin=str(CLI), profile="sdk", patches=(str(patch),),
        dsh_home=str(tmp_path / "home"), cwd=str(tmp_path),
        provider="close-fixture", model="fixture", shutdown_timeout_seconds=1,
        env={"DSH_TELEMETRY_DISABLED": "1", "DSH_AGENTS_HOME": str(tmp_path / ".agents"), "NODE_OPTIONS": "", "NODE_PATH": ""},
    )
    proc = None
    try:
        result = harness.run("Confirm runtime cleanup recovery.")
        assert result.final_response == "Runtime cleanup recovery verified."
        proc = harness.client._proc
        assert proc is not None

        def denied() -> None:
            raise PermissionError("owned runtime termination refused")

        with monkeypatch.context() as control:
            control.setattr(proc, "terminate", lambda: None)
            control.setattr(proc, "kill", denied)
            with pytest.raises(PermissionError, match="termination refused"):
                harness.close()
            assert marker.read_text() == "cleanup-entered"
            assert proc.poll() is None
            with pytest.raises(TransportClosedError, match="closed"):
                harness.start()
            with pytest.raises(TransportClosedError, match="closed"):
                harness.client.get_working_directory("new-work")
        records = [{"phase": "unconfirmed-close", "finalResponse": result.final_response,
                    "cleanupEntered": True, "processAlive": True, "signalsRefused": True, "newWorkRefused": True}]
        harness.close()
        assert proc.poll() is not None
        assert harness.client._proc is None
        with pytest.raises(TransportClosedError, match="closed"):
            harness.start()
        records.append({"phase": "confirmed-close", "originalProcessExited": True, "replacementStarted": False, "newWorkRefused": True})
        expected = Path(__file__).with_name("expected") / "close-recovery.jsonl"
        assert records == [json.loads(line) for line in expected.read_text().splitlines()]
    finally:
        if proc is not None and proc.poll() is None:
            proc.kill()
            proc.wait(timeout=10)
        harness.close()
