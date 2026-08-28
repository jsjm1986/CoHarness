from __future__ import annotations

import json
import math
import os
import queue
import subprocess
import threading
import time
import uuid
from collections import deque
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, TypeAlias, TypeVar

from pydantic import BaseModel

from .errors import JsonRpcError, TransportClosedError
from .models import IncomingRequest, InitializeResponse, JsonObject, JsonValue, Notification

ModelT = TypeVar("ModelT", bound=BaseModel)
NotificationFilter: TypeAlias = Callable[[Notification], bool]
MAX_TIMER_DELAY_SECONDS = 2_147_483_647.0
MAX_STDOUT_READ_CHARS = 4096
MAX_STDERR_LINE_BYTES = 64 * 1024


class _TextLineBuffer:
    """Collect decoded line fragments without rebuilding the retained prefix."""

    def __init__(self, max_bytes: int, *, truncate: bool = False) -> None:
        self._max_bytes = max_bytes
        self._truncate = truncate
        self._parts: list[str] = []
        self._bytes = 0

    def append(self, chunk: str) -> list[str]:
        lines: list[str] = []
        offset = 0
        while offset < len(chunk):
            newline = chunk.find("\n", offset)
            if newline < 0:
                self._append_fragment(chunk[offset:])
                break
            self._append_fragment(chunk[offset:newline])
            lines.append("".join(self._parts))
            self._parts.clear()
            self._bytes = 0
            offset = newline + 1
        return lines

    def remainder(self) -> str:
        return "".join(self._parts)

    def _append_fragment(self, fragment: str) -> None:
        if not fragment:
            return
        encoded = fragment.encode("utf-8")
        remaining = self._max_bytes - self._bytes
        if len(encoded) <= remaining:
            self._parts.append(fragment)
            self._bytes += len(encoded)
            return
        if not self._truncate:
            raise ValueError("line exceeds configured byte limit")
        if remaining > 0:
            self._parts.append(encoded[:remaining].decode("utf-8", "replace"))
            self._bytes = self._max_bytes


def _validate_timeout(value: float | None, name: str) -> None:
    if value is None:
        return
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value <= 0:
        raise ValueError(f"{name} must be a positive finite number")
    if value > MAX_TIMER_DELAY_SECONDS:
        raise ValueError(f"{name} must be no greater than {MAX_TIMER_DELAY_SECONDS:g}")


@dataclass(slots=True)
class HarnessConfig:
    """Configuration for launching the local DeepSeek Harness SDK runtime."""

    runtime_bin: str | None = None
    bridge_bin: str | None = None
    launch_args_override: tuple[str, ...] | None = None
    cwd: str | None = None
    env: dict[str, str] | None = None
    request_timeout_seconds: float | None = None
    shutdown_timeout_seconds: float | None = 1.0
    max_line_bytes: int = 1 * 1024 * 1024
    max_pending_requests: int = 1_000
    max_notification_queue: int = 10_000
    max_incoming_requests: int = 100
    max_output_bytes: int = 8 * 1024 * 1024


class HarnessClient:
    """Synchronous JSON-RPC client for the DeepSeek Harness SDK runtime over stdio."""

    def __init__(self, config: HarnessConfig | None = None) -> None:
        self.config = config or HarnessConfig()
        for name in (
            "max_line_bytes",
            "max_pending_requests",
            "max_notification_queue",
            "max_incoming_requests",
            "max_output_bytes",
        ):
            value = getattr(self.config, name)
            if not isinstance(value, int) or isinstance(value, bool) or value < 1:
                raise ValueError(f"{name} must be a positive integer")
        _validate_timeout(self.config.request_timeout_seconds, "request_timeout_seconds")
        _validate_timeout(self.config.shutdown_timeout_seconds, "shutdown_timeout_seconds")
        self._proc: subprocess.Popen[str] | None = None
        self._lock = threading.Lock()
        self._write_lock = threading.Lock()
        self._responses: dict[str, queue.Queue[JsonValue | BaseException]] = {}
        self._notifications: queue.Queue[Notification | BaseException] = queue.Queue(
            maxsize=self.config.max_notification_queue
        )
        self._notification_subscribers: dict[
            str, tuple[queue.Queue[Notification | BaseException], NotificationFilter | None]
        ] = {}
        self._session_parents: dict[str, str] = {}
        self._requests: queue.Queue[IncomingRequest | BaseException] = queue.Queue(
            maxsize=self.config.max_incoming_requests
        )
        self._stderr_lines: deque[str] = deque(maxlen=400)
        self._reader_thread: threading.Thread | None = None
        self._stderr_thread: threading.Thread | None = None
        self._closed = False
        self._runtime_dead = False

    def __enter__(self) -> "HarnessClient":
        self.start()
        return self

    def __exit__(self, _exc_type, _exc, _tb) -> None:
        self.close()

    def start(self) -> None:
        with self._lock:
            if self._closed:
                raise TransportClosedError("DeepSeek Harness runtime client is closed")
            if self._proc is not None:
                return
            self._runtime_dead = False
            self._session_parents.clear()
            args = list(self.config.launch_args_override or self._default_launch_args())
            env = os.environ.copy()
            if self.config.env:
                env.update(self.config.env)
            self._inject_bundled_default_config(env)
            self._proc = subprocess.Popen(
                args,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                encoding="utf-8",
                cwd=None if self.config.cwd is None else str(Path(self.config.cwd).resolve()),
                env=env,
                bufsize=1,
            )
            self._start_reader_thread()
            self._start_stderr_thread()

    def close(self) -> None:
        with self._lock:
            if self._closed:
                return
            self._closed = True
            proc = self._proc
        if proc is None:
            self._fail_waiters(self._runtime_closed_error("DeepSeek Harness runtime closed"))
            return
        try:
            if not self._runtime_dead:
                self.request("shutdown", None, response_model=_ShutdownResponse, timeout_seconds=self.config.shutdown_timeout_seconds)
        except Exception as exc:
            self._stderr_lines.append(f"shutdown request failed: {exc}")
        if proc.stdin:
            try:
                proc.stdin.close()
            except Exception as exc:
                self._stderr_lines.append(f"stdin close failed: {exc}")
        if proc.poll() is None:
            try:
                proc.terminate()
            except ProcessLookupError:
                pass
        try:
            proc.wait(timeout=self.config.shutdown_timeout_seconds)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait()
        self._proc = None
        self._runtime_dead = True
        with self._lock:
            self._session_parents.clear()
        self._fail_waiters(self._runtime_closed_error("DeepSeek Harness runtime closed"))
        if self._reader_thread and self._reader_thread.is_alive():
            self._reader_thread.join(timeout=0.5)
        if self._stderr_thread and self._stderr_thread.is_alive():
            self._stderr_thread.join(timeout=0.5)

    def initialize(
        self,
        *,
        cwd: str,
        provider: str,
        model: str,
        max_tokens: int | None = None,
    ) -> InitializeResponse:
        payload: JsonObject = {
            "cwd": str(Path(cwd).resolve()),
            "provider": provider,
            "model": model,
        }
        if max_tokens is not None:
            payload["maxTokens"] = max_tokens
        try:
            return self.request("initialize", payload, response_model=InitializeResponse)
        except BaseException:
            self.close()
            raise

    def session_prompt(
        self,
        session_id: str,
        content_blocks: list[JsonObject],
        *,
        on_notification: Callable[[Notification], None] | None = None,
        notification_subscription: "NotificationSubscription | None" = None,
    ) -> str:
        payload: JsonObject = {"sessionId": session_id, "contentBlocks": content_blocks}
        response = self.request(
            "session/prompt",
            payload,
            response_model=_SessionPromptResponse,
            on_notification=on_notification,
            notification_filter=self._notification_belongs_to_session_tree(session_id),
            notification_subscription=notification_subscription,
        )
        return response.messageId

    def request(
        self,
        method: str,
        params: JsonObject | None,
        *,
        response_model: type[ModelT],
        timeout_seconds: float | None = None,
        on_notification: Callable[[Notification], None] | None = None,
        notification_filter: NotificationFilter | None = None,
        notification_subscription: "NotificationSubscription | None" = None,
    ) -> ModelT:
        result = self._request_raw(
            method,
            params,
            timeout_seconds=timeout_seconds,
            on_notification=on_notification,
            notification_filter=notification_filter,
            notification_subscription=notification_subscription,
        )
        if not isinstance(result, dict):
            raise TypeError(f"{method} response must be a JSON object")
        return response_model.model_validate(result)

    def notify(self, method: str, params: JsonObject | None = None) -> None:
        message: JsonObject = {"jsonrpc": "2.0", "method": method}
        if params is not None:
            message["params"] = params
        self._write_message(message)

    def next_notification(self) -> Notification:
        item = self._notifications.get()
        if isinstance(item, BaseException):
            raise item
        return item

    def subscribe_notifications(
        self,
        notification_filter: NotificationFilter | None = None,
    ) -> "NotificationSubscription":
        subscription_id = str(uuid.uuid4())
        notifications: queue.Queue[Notification | BaseException] = queue.Queue(
            maxsize=self.config.max_notification_queue
        )
        with self._lock:
            if self._closed or self._runtime_dead:
                subscription = NotificationSubscription(self, subscription_id, notifications)
                self._put_terminal(notifications, self._runtime_closed_error("DeepSeek Harness runtime closed"))
                return subscription
            self._notification_subscribers[subscription_id] = (notifications, notification_filter)
        return NotificationSubscription(self, subscription_id, notifications)

    def subscribe_session_notifications(self, session_id: str) -> "NotificationSubscription":
        """Subscribe to a session and descendants discovered from subagent lifecycle edges."""
        return self.subscribe_notifications(self._notification_belongs_to_session_tree(session_id))

    def next_request(self) -> IncomingRequest:
        item = self._requests.get()
        if isinstance(item, BaseException):
            raise item
        return item

    def respond(self, request_id: str | int, result: JsonValue) -> None:
        self._write_message({"jsonrpc": "2.0", "id": request_id, "result": result})

    def respond_error(
        self,
        request_id: str | int,
        *,
        code: int,
        message: str,
        data: JsonValue | None = None,
    ) -> None:
        error: JsonObject = {"code": code, "message": message}
        if data is not None:
            error["data"] = data
        self._write_message({"jsonrpc": "2.0", "id": request_id, "error": error})

    def _request_raw(
        self,
        method: str,
        params: JsonObject | None = None,
        *,
        timeout_seconds: float | None = None,
        on_notification: Callable[[Notification], None] | None = None,
        notification_filter: NotificationFilter | None = None,
        notification_subscription: "NotificationSubscription | None" = None,
    ) -> JsonValue:
        request_id = str(uuid.uuid4())
        waiter: queue.Queue[JsonValue | BaseException] = queue.Queue(maxsize=1)
        temp_subscription: NotificationSubscription | None = None
        subscription = notification_subscription
        with self._lock:
            if len(self._responses) >= self.config.max_pending_requests:
                raise TransportClosedError("JSON-RPC pending request limit exceeded")
            self._responses[request_id] = waiter
        if on_notification is not None and subscription is None:
            temp_subscription = self.subscribe_notifications(notification_filter)
            subscription = temp_subscription
        try:
            message: JsonObject = {"jsonrpc": "2.0", "id": request_id, "method": method}
            if params is not None:
                message["params"] = params
            self._write_message(message)
        except BaseException:
            with self._lock:
                self._responses.pop(request_id, None)
            if temp_subscription is not None:
                temp_subscription.close()
            raise
        timeout = self.config.request_timeout_seconds if timeout_seconds is None else timeout_seconds
        _validate_timeout(timeout, "timeout_seconds")
        deadline = None if timeout is None else time.monotonic() + timeout
        try:
            while True:
                if on_notification is not None and subscription is not None:
                    subscription.drain(on_notification)
                wait_timeout = None
                if on_notification is not None:
                    wait_timeout = 0.05
                if deadline is not None:
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        with self._lock:
                            self._responses.pop(request_id, None)
                        diagnostics = self._runtime_diagnostics()
                        suffix = f"\n{diagnostics}" if diagnostics else ""
                        raise TimeoutError(
                            f"{method} timed out waiting for DeepSeek Harness runtime{suffix}"
                        )
                    wait_timeout = remaining if wait_timeout is None else min(wait_timeout, remaining)
                try:
                    item = waiter.get(timeout=wait_timeout)
                    if on_notification is not None and subscription is not None:
                        subscription.drain(on_notification)
                    break
                except queue.Empty:
                    continue
        except BaseException:
            with self._lock:
                self._responses.pop(request_id, None)
            if temp_subscription is not None:
                temp_subscription.close()
            raise
        finally:
            if temp_subscription is not None:
                temp_subscription.close()
        if isinstance(item, BaseException):
            raise item
        return item

    def _write_message(self, message: JsonObject) -> None:
        proc = self._proc
        if proc is None or proc.stdin is None:
            raise TransportClosedError("DeepSeek Harness runtime is not running")
        try:
            payload = json.dumps(message, separators=(",", ":")) + "\n"
            if len(payload.encode("utf-8")) > self.config.max_output_bytes:
                raise TransportClosedError("JSON-RPC output frame exceeds configured limit")
            with self._write_lock:
                proc.stdin.write(payload)
                proc.stdin.flush()
        except Exception as exc:
            raise self._runtime_closed_error("Failed to write to DeepSeek Harness runtime") from exc

    def _start_reader_thread(self) -> None:
        self._reader_thread = threading.Thread(target=self._reader_loop, name="dsh-runtime-reader", daemon=True)
        self._reader_thread.start()

    def _start_stderr_thread(self) -> None:
        self._stderr_thread = threading.Thread(target=self._stderr_loop, name="dsh-runtime-stderr", daemon=True)
        self._stderr_thread.start()

    def _reader_loop(self) -> None:
        proc = self._proc
        if proc is None or proc.stdout is None:
            return
        buffer = _TextLineBuffer(self.config.max_line_bytes)
        try:
            while True:
                chunk = proc.stdout.read(MAX_STDOUT_READ_CHARS)
                if chunk == "":
                    break
                try:
                    lines = buffer.append(chunk)
                except ValueError:
                    self._fail_waiters(
                        TransportClosedError("JSON-RPC input line exceeds configured limit")
                    )
                    return
                for line in lines:
                    self._handle_line(line)
                    if self._runtime_dead:
                        return
            # Preserve the text-wrapper iterator's EOF behavior for a final
            # unterminated frame, while keeping its retained bytes bounded.
            remainder = buffer.remainder()
            if remainder != "":
                self._handle_line(remainder)
        except BaseException as exc:
            self._fail_waiters(exc)
        finally:
            self._fail_waiters(self._runtime_closed_error("DeepSeek Harness runtime stdout closed"))

    def _handle_line(self, line: str) -> None:
        if len(line.encode("utf-8")) > self.config.max_line_bytes:
            self._fail_waiters(TransportClosedError("JSON-RPC input line exceeds configured limit"))
            return
        if not line.strip():
            return
        try:
            message = json.loads(line)
        except json.JSONDecodeError:
            return
        self._handle_message(message)

    def _stderr_loop(self) -> None:
        proc = self._proc
        if proc is None or proc.stderr is None:
            return
        buffer = _TextLineBuffer(MAX_STDERR_LINE_BYTES, truncate=True)
        for chunk in iter(lambda: proc.stderr.read(MAX_STDOUT_READ_CHARS), ""):
            for line in buffer.append(chunk):
                self._stderr_lines.append(line)
        remainder = buffer.remainder()
        if remainder:
            self._stderr_lines.append(remainder)

    def _handle_message(self, message: object) -> None:
        if self._runtime_dead:
            return
        if not isinstance(message, dict):
            return
        msg_id = message.get("id")
        method = message.get("method")
        if isinstance(msg_id, (str, int)) and isinstance(method, str):
            params = message.get("params")
            try:
                self._requests.put_nowait(
                    IncomingRequest(id=msg_id, method=method, payload=params if isinstance(params, dict) else {})
                )
            except queue.Full:
                self._fail_waiters(TransportClosedError("JSON-RPC incoming request queue limit exceeded"))
            return
        if isinstance(msg_id, (str, int)):
            with self._lock:
                waiter = self._responses.pop(str(msg_id), None)
            if waiter is None:
                return
            if isinstance(message.get("error"), dict):
                err = message["error"]
                waiter.put(JsonRpcError(_int_or_none(err.get("code")), str(err.get("message", "JSON-RPC error")), err.get("data")))
            else:
                waiter.put(message.get("result"))
            return
        if isinstance(method, str):
            params = message.get("params")
            notification = Notification(method=method, payload=params if isinstance(params, dict) else {})
            with self._lock:
                self._record_session_relationship_locked(notification)
                subscribers = list(self._notification_subscribers.items())
            delivered = False
            for subscription_id, (subscriber, predicate) in subscribers:
                try:
                    matches = predicate is None or predicate(notification)
                except BaseException as exc:
                    with self._lock:
                        current = self._notification_subscribers.get(subscription_id)
                        if current is not None and current[0] is subscriber:
                            self._notification_subscribers.pop(subscription_id, None)
                    subscriber.put(exc)
                    continue
                if matches:
                    try:
                        subscriber.put_nowait(notification)
                    except queue.Full:
                        with self._lock:
                            current = self._notification_subscribers.get(subscription_id)
                            if current is not None and current[0] is subscriber:
                                self._notification_subscribers.pop(subscription_id, None)
                        self._put_terminal(subscriber, TransportClosedError("notification subscription queue limit exceeded"))
                        continue
                    delivered = True
            with self._lock:
                self._forget_session_relationship_locked(notification)
            if not delivered:
                try:
                    self._notifications.put_nowait(notification)
                except queue.Full:
                    self._fail_waiters(TransportClosedError("notification queue limit exceeded"))

    def _fail_waiters(self, exc: BaseException) -> None:
        self._runtime_dead = True
        with self._lock:
            waiters = list(self._responses.values())
            self._responses.clear()
            subscribers = list(self._notification_subscribers.values())
            self._notification_subscribers.clear()
        for waiter in waiters:
            self._put_terminal(waiter, exc)
        for subscriber, _predicate in subscribers:
            self._put_terminal(subscriber, exc)
        self._put_terminal(self._notifications, exc)
        self._put_terminal(self._requests, exc)

    @staticmethod
    def _put_terminal(target: queue.Queue[object], value: object) -> None:
        try:
            target.put_nowait(value)
        except queue.Full:
            try:
                target.get_nowait()
            except queue.Empty:
                return
            try:
                target.put_nowait(value)
            except queue.Full:
                return

    def _runtime_closed_error(self, reason: str) -> TransportClosedError:
        diagnostics = self._runtime_diagnostics()
        return TransportClosedError(f"{reason}\n{diagnostics}" if diagnostics else reason)

    def _runtime_diagnostics(self) -> str:
        """Return available subprocess state for transport failures and timeouts."""
        proc = self._proc
        if (
            proc is not None
            and proc.poll() is not None
            and self._stderr_thread is not None
            and self._stderr_thread.is_alive()
            and threading.current_thread() is not self._stderr_thread
        ):
            self._stderr_thread.join(timeout=0.1)

        parts: list[str] = []
        if proc is not None:
            exit_code = proc.poll()
            if exit_code is not None:
                parts.append(f"exit code: {exit_code}")
        if self._stderr_lines:
            parts.append("stderr tail:\n" + "\n".join(self._stderr_lines))
        return "\n".join(parts)

    def _default_launch_args(self) -> tuple[str, ...]:
        if self.config.runtime_bin is not None:
            return (self.config.runtime_bin,)
        if self.config.bridge_bin is not None:
            return (self.config.bridge_bin,)
        try:
            from deepseek_harness_runtime import resolve_bundled_launch_args
        except ImportError as exc:
            raise FileNotFoundError(
                "Unable to locate the bundled DeepSeek Harness SDK runtime. "
                "Install deepseek-harness-runtime-bin or set HarnessConfig.runtime_bin."
            ) from exc
        return resolve_bundled_launch_args()

    def _inject_bundled_default_config(self, env: dict[str, str]) -> None:
        """Inject the default config for a bundled launch with no non-empty config.

        Both bundled carriers require an explicit config. Explicit runtime,
        launch-argument, and config channels remain untouched.
        """
        uses_bundled_runtime = (
            self.config.launch_args_override is None
            and self.config.runtime_bin is None
            and self.config.bridge_bin is None
        )
        if not uses_bundled_runtime or env.get("DSH_CORDIS_CONFIG"):
            return
        # _default_launch_args already imported the package or raised its install error.
        from deepseek_harness_runtime import bundled_default_config_path

        env["DSH_CORDIS_CONFIG"] = str(bundled_default_config_path())

    def _unsubscribe_notifications(self, subscription_id: str) -> None:
        with self._lock:
            self._notification_subscribers.pop(subscription_id, None)

    def _record_session_relationship_locked(self, notification: Notification) -> None:
        if notification.method != "subagent.started":
            return
        parent_id = notification.payload.get("parentSessionId")
        child_id = notification.payload.get("childSessionId")
        if (
            isinstance(parent_id, str)
            and parent_id
            and isinstance(child_id, str)
            and child_id
            and parent_id != child_id
        ):
            if child_id not in self._session_parents and len(self._session_parents) >= self.config.max_notification_queue:
                oldest = next(iter(self._session_parents), None)
                if oldest is not None:
                    self._session_parents.pop(oldest, None)
            self._session_parents[child_id] = parent_id

    def _forget_session_relationship_locked(self, notification: Notification) -> None:
        if notification.method != "subagent.finished":
            return
        child_id = notification.payload.get("childSessionId")
        if isinstance(child_id, str) and child_id:
            self._session_parents.pop(child_id, None)

    def _notification_belongs_to_session_tree(self, session_id: str) -> NotificationFilter:
        def belongs(notification: Notification) -> bool:
            payload = notification.payload
            if notification.method in {"subagent.started", "subagent.finished"}:
                parent_id = payload.get("parentSessionId")
                if (
                    isinstance(parent_id, str)
                    and self._session_is_descendant_of(parent_id, session_id)
                ):
                    return True
                return payload.get("childSessionId") == session_id
            related_id = payload.get("sessionId")
            return (
                isinstance(related_id, str)
                and self._session_is_descendant_of(related_id, session_id)
            )

        return belongs

    def _session_is_descendant_of(self, session_id: str, root_session_id: str) -> bool:
        current = session_id
        visited: set[str] = set()
        while current not in visited:
            if current == root_session_id:
                return True
            visited.add(current)
            parent = self._session_parents.get(current)
            if parent is None:
                return False
            current = parent
        return False


class NotificationSubscription:
    def __init__(
        self,
        client: HarnessClient,
        subscription_id: str,
        notifications: queue.Queue[Notification | BaseException],
    ) -> None:
        self._client = client
        self._subscription_id = subscription_id
        self._notifications = notifications
        self._closed = False
        self._state_lock = threading.Lock()
        self._waiters = 0

    def __enter__(self) -> "NotificationSubscription":
        return self

    def __exit__(self, _exc_type, _exc, _tb) -> None:
        self.close()

    def close(self) -> None:
        with self._state_lock:
            if self._closed:
                return
            self._closed = True
            waiters = self._waiters
        self._client._unsubscribe_notifications(self._subscription_id)
        # Wake every caller already blocked in next(). A subsequent caller
        # observes _closed before waiting and fails synchronously.
        for _ in range(waiters):
            self._client._put_terminal(self._notifications, TransportClosedError("notification subscription closed"))

    def next(self) -> Notification:
        with self._state_lock:
            if self._closed:
                raise TransportClosedError("notification subscription closed")
            self._waiters += 1
        try:
            item = self._notifications.get()
        finally:
            with self._state_lock:
                self._waiters = max(0, self._waiters - 1)
        if isinstance(item, BaseException):
            raise item
        return item

    def drain(self, on_notification: Callable[[Notification], None]) -> None:
        while True:
            try:
                item = self._notifications.get_nowait()
            except queue.Empty:
                return
            if isinstance(item, BaseException):
                raise item
            on_notification(item)


class _SessionPromptResponse(BaseModel):
    messageId: str


class _ShutdownResponse(BaseModel):
    pass


def _int_or_none(value: object) -> int | None:
    return value if isinstance(value, int) else None
