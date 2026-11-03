"""Native pipe backpressure cannot prevent SDK request deadlines or owned teardown."""
from __future__ import annotations

from pathlib import Path
from contextlib import contextmanager
import sys
import threading

import pytest
from pydantic import BaseModel

from deepseek_harness import HarnessClient, HarnessConfig
from deepseek_harness.errors import TransportClosedError


@pytest.fixture
def blocked_runtime(tmp_path: Path):
    script = tmp_path / "blocked_input.py"
    script.write_text(
        """
import json
import sys
import threading

message = json.loads(sys.stdin.readline())
print(json.dumps({"jsonrpc": "2.0", "id": message["id"], "result": {"serverInfo": {"name": "blocked-input"}}}), flush=True)
threading.Event().wait()
""".strip()
    )
    client = HarnessClient(
        HarnessConfig(request_timeout_seconds=0.1, shutdown_timeout_seconds=0.1),
        _launch_args=(sys.executable, str(script)),
    )
    client.start()
    proc = client._proc
    assert proc is not None and proc.stdin is not None
    try:
        client.initialize(cwd=str(tmp_path), provider="fixture", model="fixture")
        yield client, proc
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait(timeout=10)
        client.close()


def test_blocked_runtime_input_does_not_block_request_timeout_or_close(blocked_runtime, monkeypatch) -> None:
    client, proc = blocked_runtime
    entered = threading.Event()
    closed = threading.Event()
    rescued = threading.Event()
    errors = []
    write = proc.stdin.write

    def observed_write(data):
        if len(data) > 1024 * 1024:
            entered.set()
        return write(data)

    def prompt() -> None:
        try:
            client.session_prompt("blocked-input", [{"type": "text", "text": "x" * (4 * 1024 * 1024)}])
        except BaseException as exc:
            errors.append(exc)

    def rescue() -> None:
        if not closed.wait(timeout=10):
            rescued.set()
            proc.kill()

    writer = threading.Thread(target=prompt)
    watchdog = threading.Thread(target=rescue)
    with monkeypatch.context() as patch:
        patch.setattr(proc.stdin, "write", observed_write)
        writer.start()
        watchdog.start()
        try:
            assert entered.wait(timeout=10)
            with pytest.raises(TransportClosedError, match="output queue"):
                client.notify("overflow", {"text": "y" * (5 * 1024 * 1024)})
            client.close()
            assert not rescued.is_set(), "SDK close required external process termination to escape a blocked pipe write"
        finally:
            closed.set()
            if proc.poll() is None:
                proc.kill()
                proc.wait(timeout=10)
            writer.join(timeout=10)
            watchdog.join(timeout=10)
    assert not writer.is_alive() and not watchdog.is_alive()
    assert len(errors) == 1 and isinstance(errors[0], TimeoutError)
    assert proc.poll() is not None
    client.close()


def test_writer_failure_rejects_pending_work_and_keeps_process_cleanup_owned(blocked_runtime, monkeypatch) -> None:
    client, proc = blocked_runtime

    def denied(_data):
        raise BrokenPipeError("owned runtime input failed")

    with monkeypatch.context() as patch:
        patch.setattr(proc.stdin, "write", denied)
        with pytest.raises(TransportClosedError, match="Failed to write"):
            client.get_working_directory("owner")
        with pytest.raises(TransportClosedError):
            client.notify("new-work")
    assert proc.poll() is None
    client.close()
    assert proc.poll() is not None


def test_writer_join_failure_keeps_the_original_process_for_retry(blocked_runtime, monkeypatch) -> None:
    client, proc = blocked_runtime
    entered = threading.Event()
    release = threading.Event()
    closed = threading.Event()
    rescued = threading.Event()
    errors = []
    write = proc.stdin.write

    def held_write(data):
        if len(data) > 1024 * 1024:
            entered.set()
            if not release.wait(timeout=20):
                raise TimeoutError("owned writer barrier was not released")
        return write(data)

    def prompt() -> None:
        try:
            client.session_prompt("held-writer", [{"type": "text", "text": "x" * (4 * 1024 * 1024)}])
        except BaseException as exc:
            errors.append(exc)

    def rescue() -> None:
        if not closed.wait(timeout=20):
            rescued.set()
            release.set()
            if proc.poll() is None:
                proc.kill()

    caller = threading.Thread(target=prompt)
    watchdog = threading.Thread(target=rescue)
    with monkeypatch.context() as patch:
        patch.setattr(proc.stdin, "write", held_write)
        caller.start()
        watchdog.start()
        try:
            assert entered.wait(timeout=10)
            with pytest.raises(TransportClosedError, match="input writer has not settled"):
                client.close()
            assert proc.poll() is not None
            assert client._proc is proc
            release.set()
            assert client._writer_thread is not None
            client._writer_thread.join(timeout=10)
            client.close()
            assert client._proc is None
            assert not rescued.is_set()
        finally:
            release.set()
            closed.set()
            if proc.poll() is None:
                proc.kill()
                proc.wait(timeout=10)
            caller.join(timeout=10)
            watchdog.join(timeout=10)
    assert not caller.is_alive() and not watchdog.is_alive()
    assert len(errors) == 1 and isinstance(errors[0], TimeoutError)


@contextmanager
def request_runtime(tmp_path: Path):
    script = tmp_path / "request_runtime.py"
    script.write_text(
        """
import json
import sys

cwd = "/untouched"
for line in sys.stdin:
    message = json.loads(line)
    method = message.get("method")
    if method == "trigger-close":
        print(json.dumps({"jsonrpc": "2.0", "method": "close-client", "params": {}}), flush=True)
        continue
    if method == "session/working-directory/set":
        cwd = message["params"]["path"]
    result = {"serverInfo": {"name": "request-runtime"}} if method == "initialize" else {"cwd": cwd}
    print(json.dumps({"jsonrpc": "2.0", "id": message["id"], "result": result}), flush=True)
    if method == "shutdown":
        break
""".strip()
    )
    client = HarnessClient(HarnessConfig(request_timeout_seconds=5, shutdown_timeout_seconds=0.1),
                           _launch_args=(sys.executable, str(script)))
    client.start()
    proc = client._proc
    assert proc is not None
    try:
        client.initialize(cwd=str(tmp_path), provider="fixture", model="fixture")
        yield client, proc
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait(timeout=10)
        client.close()


def test_invalid_request_timeout_does_not_send_a_mutation(tmp_path: Path) -> None:
    class DirectoryResult(BaseModel):
        cwd: str

    with request_runtime(tmp_path) as (client, _proc):
        with pytest.raises(ValueError, match="timeout_seconds"):
            client.request("session/working-directory/set", {"sessionId": "owner", "path": "/forbidden"},
                           response_model=DirectoryResult, timeout_seconds=0)
        assert client.get_working_directory("owner") == "/untouched"


def test_notification_filter_can_close_its_client_without_joining_itself(tmp_path: Path) -> None:
    with request_runtime(tmp_path) as (client, proc):
        finished = threading.Event()
        errors = []

        def close_filter(_notification):
            try:
                client.close()
            except BaseException as exc:
                errors.append(exc)
            finally:
                finished.set()
            return False

        subscription = client.subscribe_notifications(close_filter)
        try:
            client.notify("trigger-close")
            assert finished.wait(timeout=10)
            assert errors == []
            assert proc.poll() is not None
        finally:
            subscription.close()


def test_output_refuses_frames_before_the_runtime_is_started() -> None:
    client = HarnessClient(HarnessConfig(), _launch_args=(sys.executable, "-c", "pass"))
    try:
        with pytest.raises(TransportClosedError, match="not running"):
            client.notify("unstarted")
    finally:
        client.close()


def test_oversized_output_admission_preserves_the_running_transport(tmp_path: Path, monkeypatch) -> None:
    with request_runtime(tmp_path) as (client, _proc):
        with monkeypatch.context() as limits:
            limits.setattr(client.config, "max_output_bytes", 32)
            with pytest.raises(TransportClosedError, match="output frame exceeds"):
                client.notify("oversized", {"text": "x" * 64})
        assert client.get_working_directory("owner") == "/untouched"


def test_close_contains_a_notification_filter_that_finishes_after_teardown(tmp_path: Path) -> None:
    with request_runtime(tmp_path) as (client, proc):
        entered = threading.Event()
        release = threading.Event()

        def held_filter(_notification):
            entered.set()
            if not release.wait(timeout=10):
                raise TimeoutError("notification filter barrier was not released")
            return True

        subscription = client.subscribe_notifications(held_filter)
        try:
            client.notify("trigger-close")
            assert entered.wait(timeout=10)
            client.close()
            assert proc.poll() is not None
            with pytest.raises(TransportClosedError):
                subscription.next()
        finally:
            release.set()
            if client._reader_thread is not None:
                client._reader_thread.join(timeout=10)
            subscription.close()
