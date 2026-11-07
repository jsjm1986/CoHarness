"""Bound blocked stdin and teardown through the full SDK model composition."""
from __future__ import annotations

import json
from pathlib import Path
import threading
import time

import pytest
from pydantic import BaseModel

from deepseek_harness import DeepSeekHarness
from deepseek_harness.errors import TransportClosedError

ROOT = Path(__file__).resolve().parents[3]
CLI = ROOT / "apps/cli/lib/bin.js"


@pytest.mark.skipif(not CLI.exists(), reason="requires the built dsh CLI")
def test_full_runtime_blocked_input_deadlines(tmp_path: Path) -> None:
    class PromptReceipt(BaseModel):
        messageId: str

    marker = tmp_path / "runtime-input-blocked"
    patch = tmp_path / "runtime.patch.yml"
    plugin = Path(__file__).with_name("fixtures") / "backpressure-runtime.mjs"
    patch.write_text(json.dumps([
        {"id": "llm-deepseek", "disabled": True}, {"id": "agent-instructions", "disabled": True},
        {"id": "skill-filesystem", "config": {"includeDefaultRoots": False}},
        {"insert": [{"id": "backpressure-runtime", "name": plugin.as_uri(), "config": {
            "marker": str(marker), "llmEntry": (ROOT / "packages/llm/llm/lib/index.js").as_uri(),
        }}]},
    ]))
    harness = DeepSeekHarness(
        dsh_bin=str(CLI), profile="sdk", patches=(str(patch),), dsh_home=str(tmp_path / "home"), cwd=str(tmp_path),
        provider="backpressure-fixture", model="fixture", shutdown_timeout_seconds=1,
        env={"DSH_TELEMETRY_DISABLED": "1", "DSH_AGENTS_HOME": str(tmp_path / ".agents"), "NODE_OPTIONS": "", "NODE_PATH": ""},
    )
    proc = None
    done = threading.Event()
    rescued = threading.Event()
    watchdog = None
    try:
        result = harness.run("Complete the first turn.", session_id="pipe-owner")
        assert result.final_response == "Backpressure runtime ready."
        proc = harness.client._proc
        assert proc is not None
        try:
            harness.client.request("session/prompt", {"sessionId": "pipe-owner", "contentBlocks": [{"type": "text", "text": "Block the event loop."}]},
                                   response_model=PromptReceipt, timeout_seconds=0.2)
        except TimeoutError:
            # The accepted freeze request may block the loop before its acknowledgement is flushed.
            pass
        deadline = time.monotonic() + 30
        while not marker.exists():
            if time.monotonic() >= deadline:
                raise TimeoutError("complete SDK runtime did not enter its input barrier")
            time.sleep(0.01)
        assert marker.read_text() == "runtime-input-blocked"

        def rescue() -> None:
            if not done.wait(timeout=20):
                rescued.set()
                proc.kill()

        watchdog = threading.Thread(target=rescue)
        watchdog.start()
        with pytest.raises(TimeoutError):
            harness.client.request("session/prompt", {"sessionId": "pipe-owner", "contentBlocks": [{"type": "text", "text": "x" * (768 * 1024)}]},
                                   response_model=PromptReceipt, timeout_seconds=0.2)
        harness.close()
        assert not rescued.is_set()
        assert proc.poll() is not None
        with pytest.raises(TransportClosedError, match="closed"):
            harness.start()
        records = [
            {"phase": "ready", "finalResponse": result.final_response},
            {"phase": "blocked-input", "requestTimedOut": True, "shutdownCompleted": True, "originalProcessExited": True, "newWorkRefused": True},
        ]
        expected = Path(__file__).with_name("expected") / "write-deadlines.jsonl"
        assert records == [json.loads(line) for line in expected.read_text().splitlines()]
    finally:
        done.set()
        if proc is not None and proc.poll() is None:
            proc.kill()
            proc.wait(timeout=10)
        if watchdog is not None:
            watchdog.join(timeout=10)
        harness.close()
