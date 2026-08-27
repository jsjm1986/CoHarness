from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from pathlib import Path
import threading
from typing import Callable

from .client import HarnessClient, HarnessConfig
from .errors import SdkProtocolError
from .models import JsonObject, Notification


@dataclass(slots=True)
class DeepSeekHarnessConfig:
    """Configuration for launching the local DeepSeek Harness SDK runtime.

    The runtime inherits the caller's environment by default, so existing
    DEEPSEEK_API_KEY and DEEPSEEK_BASE_URL settings keep working. Use ``env`` to
    intentionally override or inject variables for a subprocess.
    """

    provider: str = "deepseek-official"
    model: str = "deepseek-v4-flash"
    max_tokens: int | None = None
    cwd: str | None = None
    runtime_cwd: str | None = None
    session_root: str | None = None
    cordis: str | None = None
    env: dict[str, str] = field(default_factory=dict)
    runtime_bin: str | None = None
    launch_args_override: tuple[str, ...] | None = None
    request_timeout_seconds: float | None = None
    shutdown_timeout_seconds: float | None = 1.0
    max_line_bytes: int = 1 * 1024 * 1024
    max_pending_requests: int = 1_000
    max_notification_queue: int = 10_000
    max_incoming_requests: int = 100
    max_output_bytes: int = 8 * 1024 * 1024
    base_url: str | None = None
    api_key: str | None = None


@dataclass(slots=True)
class RunResult:
    session_id: str
    final_response: str
    finish_reason: str | None
    events: list[JsonObject]
    notifications: list[Notification]
    session_root: str | None = None


class DeepSeekHarness:
    """Reusable synchronous SDK for running DeepSeek Harness agent turns.

    The runtime subprocess starts lazily and remains owned by this instance
    across calls to :meth:`run`. Use the instance as a context manager, or call
    :meth:`close` explicitly when finished, so the subprocess is always reaped.
    """

    def __init__(self, config: DeepSeekHarnessConfig | None = None, **kwargs: object) -> None:
        if config is not None and kwargs:
            raise TypeError("pass either DeepSeekHarnessConfig or keyword options, not both")
        self.config = config or DeepSeekHarnessConfig(**kwargs)
        cwd = str(Path(self.config.cwd or Path.cwd()).resolve())
        runtime_cwd = str(Path(self.config.runtime_cwd).resolve()) if self.config.runtime_cwd is not None else cwd
        self._cwd = cwd
        env = dict(self.config.env)
        if self.config.session_root is not None:
            env["DSH_SESSION_ROOT"] = self.config.session_root
        if self.config.cordis is not None:
            env["DSH_CORDIS_CONFIG"] = self.config.cordis
        env["DSH_CWD"] = cwd
        if self.config.base_url is not None:
            env["DEEPSEEK_BASE_URL"] = self.config.base_url
        if self.config.api_key is not None:
            env["DEEPSEEK_API_KEY"] = self.config.api_key

        self._client = HarnessClient(
            HarnessConfig(
                runtime_bin=self.config.runtime_bin,
                launch_args_override=self.config.launch_args_override,
                cwd=runtime_cwd,
                env=env,
                request_timeout_seconds=self.config.request_timeout_seconds,
                shutdown_timeout_seconds=self.config.shutdown_timeout_seconds,
                max_line_bytes=self.config.max_line_bytes,
                max_pending_requests=self.config.max_pending_requests,
                max_notification_queue=self.config.max_notification_queue,
                max_incoming_requests=self.config.max_incoming_requests,
                max_output_bytes=self.config.max_output_bytes,
            )
        )
        self._initialized = False
        self._lifecycle_lock = threading.Lock()
        # Each entry keeps a reference count so a queued waiter and a newly
        # arriving run cannot observe different locks while cleanup removes an
        # idle session key.
        self._session_locks: dict[str, tuple[threading.Lock, int]] = {}
        self._session_locks_guard = threading.Lock()

    def __enter__(self) -> "DeepSeekHarness":
        self.start()
        return self

    def __exit__(self, _exc_type, _exc, _tb) -> None:
        self.close()

    @property
    def client(self) -> HarnessClient:
        return self._client

    def start(self) -> None:
        with self._lifecycle_lock:
            if self._initialized:
                return
            self._client.start()
            try:
                self._client.initialize(
                    cwd=self._cwd,
                    provider=self.config.provider,
                    model=self.config.model,
                    max_tokens=self.config.max_tokens,
                )
            except BaseException:
                self._initialized = False
                raise
            self._initialized = True

    def close(self) -> None:
        with self._lifecycle_lock:
            self._client.close()
            self._initialized = False

    def start_session(self, session_id: str | None = None) -> "Session":
        self.start()
        return Session(self, session_id or f"session-{uuid.uuid4().hex}")

    def run(
        self,
        input: str | list[JsonObject],
        *,
        session_id: str | None = None,
        on_notification: Callable[[Notification], None] | None = None,
    ) -> RunResult:
        return self.start_session(session_id).run(input, on_notification=on_notification)

    def _serialize_session(self, session_id: str, operation: Callable[[], RunResult]) -> RunResult:
        with self._session_locks_guard:
            state = self._session_locks.get(session_id)
            if state is None:
                state = (threading.Lock(), 0)
            lock, users = state
            self._session_locks[session_id] = (lock, users + 1)
        try:
            with lock:
                return operation()
        finally:
            with self._session_locks_guard:
                current = self._session_locks.get(session_id)
                if current is not None and current[0] is lock:
                    remaining = current[1] - 1
                    if remaining <= 0:
                        self._session_locks.pop(session_id, None)
                    else:
                        self._session_locks[session_id] = (lock, remaining)


class Session:
    def __init__(self, harness: DeepSeekHarness, session_id: str) -> None:
        self.harness = harness
        self.id = session_id

    def run(
        self,
        input: str | list[JsonObject],
        *,
        on_notification: Callable[[Notification], None] | None = None,
    ) -> RunResult:
        return self.harness._serialize_session(
            self.id,
            lambda: self._run_once(input, on_notification=on_notification),
        )

    def _run_once(
        self,
        input: str | list[JsonObject],
        *,
        on_notification: Callable[[Notification], None] | None = None,
    ) -> RunResult:
        content_blocks = normalize_input(input)
        notifications: list[Notification] = []
        events: list[JsonObject] = []

        def collect(notification: Notification) -> None:
            notifications.append(notification)
            if on_notification is not None:
                on_notification(notification)
            if (
                notification.method == "session.event"
                and notification.payload.get("sessionId") == self.id
            ):
                event = notification.payload.get("event")
                if isinstance(event, dict):
                    events.append(event)

        with self.harness.client.subscribe_session_notifications(self.id) as subscription:
            message_id = self.harness.client.session_prompt(
                self.id,
                content_blocks,
                notification_subscription=subscription,
            )

            received = False
            while True:
                notification = subscription.next()
                if not received:
                    if not _is_inbox_receipt(notification, self.id, message_id):
                        continue
                    received = True
                collect(notification)
                if (
                    notification.method == "session.status"
                    and notification.payload.get("sessionId") == self.id
                    and notification.payload.get("status") == "idle"
                ):
                    break

        return RunResult(
            session_id=self.id,
            final_response=final_response(events),
            finish_reason=finish_reason(events),
            events=events,
            notifications=notifications,
            session_root=self.harness.config.session_root,
        )


def _is_inbox_receipt(notification: Notification, session_id: str, message_id: str) -> bool:
    if notification.method != "session.event" or notification.payload.get("sessionId") != session_id:
        return False
    event = notification.payload.get("event")
    if not isinstance(event, dict) or event.get("type") != "agent/inbox/spliced":
        return False
    data = event.get("data")
    inserted = data.get("inserted") if isinstance(data, dict) else None
    return isinstance(inserted, list) and any(
        isinstance(message, dict) and message.get("id") == message_id for message in inserted
    )


def normalize_input(input: str | list[JsonObject]) -> list[JsonObject]:
    if isinstance(input, str):
        return [{"type": "text", "text": input}]
    return input


def final_response(events: list[JsonObject]) -> str:
    for event in reversed(events):
        if event.get("type") != "assistant/message":
            continue
        data = event.get("data")
        if not isinstance(data, dict):
            continue
        message = data.get("message")
        content_owner = message if isinstance(message, dict) else data
        content = content_owner.get("content")
        if not isinstance(content, list):
            continue
        parts: list[str] = []
        for block in content:
            if isinstance(block, dict) and block.get("type") == "text":
                parts.append(str(block.get("text") or ""))
        return "".join(parts)
    return ""


def finish_reason(events: list[JsonObject]) -> str | None:
    """Return the last turn-ending kind.

    The input must contain root-session events from one owned run interval.

    Raises:
        SdkProtocolError: The last ``turn/end`` has no string reason kind.
    """
    for event in reversed(events):
        if event.get("type") != "turn/end":
            continue
        data = event.get("data")
        reason = data.get("reason") if isinstance(data, dict) else None
        kind = reason.get("kind") if isinstance(reason, dict) else None
        if not isinstance(kind, str):
            raise SdkProtocolError("turn/end event requires a string data.reason.kind")
        return kind
    return None
