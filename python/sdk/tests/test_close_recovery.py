"""SDK process ownership and admission survive refused or unconfirmed teardown."""
from __future__ import annotations

from pathlib import Path
import subprocess
import sys
import threading

import pytest

from deepseek_harness import DeepSeekHarness
from deepseek_harness.errors import TransportClosedError


@pytest.fixture
def runtime(tmp_path: Path):
    script = tmp_path / "owned_runtime.py"
    script.write_text(
        """
import json
import sys
import threading

for line in sys.stdin:
    message = json.loads(line)
    method = message.get("method")
    result = {"serverInfo": {"name": "owned-runtime"}} if method == "initialize" else {}
    if method == "session/working-directory/get":
        result = {"cwd": "/owned-workspace"}
    if "id" in message:
        print(json.dumps({"jsonrpc": "2.0", "id": message["id"], "result": result}), flush=True)
threading.Event().wait()
""".strip()
    )
    harness = DeepSeekHarness(
        shutdown_timeout_seconds=0.1, request_timeout_seconds=1,
        _launch_args=(sys.executable, str(script)),
    )
    harness.start()
    client = harness.client
    proc = client._proc
    assert proc is not None
    try:
        yield harness, client, proc
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait(timeout=10)
        client.close()


@pytest.mark.parametrize("owner", ["client", "harness"])
def test_close_retries_the_original_runtime_after_termination_is_refused(runtime, monkeypatch, owner) -> None:
    harness, client, proc = runtime
    close = client.close if owner == "client" else harness.close

    def denied() -> None:
        raise PermissionError("owned runtime termination refused")

    with monkeypatch.context() as patch:
        patch.setattr(proc, "terminate", lambda: None)
        patch.setattr(proc, "kill", denied)
        with pytest.raises(PermissionError, match="termination refused"):
            close()
        assert proc.poll() is None
        if owner == "harness":
            with pytest.raises(TransportClosedError, match="closed"):
                harness.start()
        with pytest.raises(PermissionError, match="termination refused"):
            close()
    close()
    assert proc.poll() is not None
    assert client._proc is None
    harness.close()


def test_close_bounds_forced_exit_confirmation_and_keeps_the_original_owner(runtime, monkeypatch) -> None:
    _harness, client, proc = runtime
    waits = []

    def unconfirmed(*, timeout=None):
        waits.append(timeout)
        if timeout is None:
            raise RuntimeError("forced exit confirmation was unbounded")
        raise subprocess.TimeoutExpired(proc.args, timeout)

    with monkeypatch.context() as patch:
        patch.setattr(proc, "wait", unconfirmed)
        patch.setattr(proc, "terminate", lambda: None)
        patch.setattr(proc, "kill", lambda: None)
        with pytest.raises(subprocess.TimeoutExpired):
            client.close()
        assert waits == [0.1, 0.1, 0.1]
        assert client._proc is proc
        assert proc.poll() is None
    client.close()
    assert proc.poll() is not None


@pytest.mark.parametrize("rung", ["terminate", "kill"])
def test_close_confirms_exit_when_the_process_disappears_during_a_signal(runtime, monkeypatch, rung) -> None:
    _harness, client, proc = runtime
    kill = proc.kill

    def disappeared() -> None:
        kill()
        raise ProcessLookupError("owned process exited during termination")

    with monkeypatch.context() as patch:
        if rung == "kill":
            patch.setattr(proc, "terminate", lambda: None)
        patch.setattr(proc, rung, disappeared)
        client.close()
    assert proc.poll() is not None
    assert client._proc is None


def test_close_still_reaps_the_owned_process_when_stdin_cannot_be_closed(runtime, monkeypatch) -> None:
    _harness, client, proc = runtime
    assert proc.stdin is not None

    def denied() -> None:
        raise OSError("owned stdin close failed")

    with monkeypatch.context() as patch:
        patch.setattr(proc.stdin, "close", denied)
        client.close()
    assert proc.poll() is not None
    assert client._proc is None


def test_close_refuses_new_requests_while_the_shutdown_acknowledgement_is_pending(runtime, monkeypatch) -> None:
    _harness, client, _proc = runtime
    entered = threading.Event()
    release = threading.Event()
    failures = []
    write_message = client._write_message

    def blocked_shutdown(message):
        if message.get("method") == "shutdown":
            entered.set()
            if not release.wait(timeout=10):
                raise TimeoutError("shutdown barrier was not released")
        write_message(message)

    def close() -> None:
        try:
            client.close()
        except BaseException as exc:
            failures.append(exc)

    with monkeypatch.context() as patch:
        patch.setattr(client, "_write_message", blocked_shutdown)
        closer = threading.Thread(target=close)
        closer.start()
        try:
            assert entered.wait(timeout=10)
            with pytest.raises(TransportClosedError, match="closed"):
                client.get_working_directory("new-work")
            with pytest.raises(TransportClosedError, match="closed"):
                client.notify("new-work")
        finally:
            release.set()
            closer.join(timeout=10)
        assert not closer.is_alive()
        assert failures == []
