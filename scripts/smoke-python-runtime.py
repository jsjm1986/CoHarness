#!/usr/bin/env python3
"""Keyless full-turn and snapshot smoke for the Python SDK runtime."""

from __future__ import annotations

import argparse
import difflib
import json
import os
import queue
import re
import subprocess
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import TYPE_CHECKING, Callable

if TYPE_CHECKING:
    from deepseek_harness import RunResult


EXPECTED_TEXT = "runtime smoke ok"
CODE_PROMPT = "Use run_code to compute the packaged worker smoke value."
CODE_WORKER_TEXT = "code worker smoke ok"
WORKFLOW_PROMPT = "Use workflow to compute the packaged worker smoke value without agents."
WORKFLOW_WORKER_TEXT = "workflow worker smoke ok"
MINIMAL_PROMPT = "Exercise the packaged minimal agent's persistent shell and string-replacement editor."
MINIMAL_TEXT = "minimal agent smoke ok"
MINIMAL_EDITOR_PATH_PREFIX = "Editor path: "
FS_SEARCH_PROMPT = "Exercise the packaged filesystem search tools."
FS_SEARCH_TEXT = "filesystem search smoke ok"
FS_SEARCH_MARKER = "PACKAGED_FS_SEARCH_OK"
MCP_PROMPT = "Exercise the packaged MCP client with one external stdio server."
MCP_TEXT = "MCP client smoke ok"
IS_WINDOWS = sys.platform == "win32"
MINIMAL_SHELL_TOOL = "pwsh" if IS_WINDOWS else "bash"
MINIMAL_SHELL_COMMAND = (
    "$global:dshSdkCounter = [int]$global:dshSdkCounter + 1; "
    'Write-Output "COUNT=$global:dshSdkCounter CWD=$((Get-Location).Path)"; '
    "if ($global:dshSdkCounter -eq 1) { Set-Location $env:TEMP }"
    if IS_WINDOWS
    else (
        "counter=$(( ${counter:-0} + 1 )); export counter; "
        "printf 'COUNT=%s CWD=%s\\n' \"$counter\" \"$PWD\"; "
        "if [ \"$counter\" -eq 1 ]; then cd /tmp; fi"
    )
)
MINIMAL_SHELL_SECOND_CWD = str(Path(tempfile.gettempdir()).resolve()) if IS_WINDOWS else "/tmp"
SNAPSHOT_PROMPT = "Run the advanced packaged-runtime snapshot scenario."
SNAPSHOT_SESSION_ID = "advanced-executable"
SNAPSHOT_DIRECT_CHILD_PROMPT = "Reply with exactly DIRECT_CHILD_OK and nothing else."
SNAPSHOT_WORKFLOW_CHILD_PROMPT = "Reply with exactly WORKFLOW_CHILD_OK and nothing else."
SNAPSHOT_FINAL_TEXT = "ADVANCED_EXECUTABLE_OK"
SNAPSHOT_WORKFLOW_SCRIPT = (
    "phase('Delegate')\n"
    f"const reply = await agent('{SNAPSHOT_WORKFLOW_CHILD_PROMPT}', {{ label: 'workflow-child' }})\n"
    "return { reply }"
)
ADVANCED_SNAPSHOT_DIRECTORY = (
    Path(__file__).resolve().parent / "snapshots" / "python-sdk-single-exe" / "advanced"
)
ADVANCED_SNAPSHOT_FILENAMES = ("result.json", "session.jsonl", "session.1.jsonl", "session.2.jsonl")
MINIMAL_SNAPSHOT_DIRECTORY = (
    Path(__file__).resolve().parent / "snapshots" / "python-sdk-single-exe" / "minimal"
)
# The persistent-shell schema, command echo, and working-directory token differ
# between dialects, so Windows keeps its own expected output beside the shared one.
if IS_WINDOWS:
    MINIMAL_SNAPSHOT_DIRECTORY /= "win-x64"
MINIMAL_SNAPSHOT_FILENAMES = ("model-visible.json",)
# The agent loop's dynamic runtime-context snapshot is the one model-visible message this
# expected output cannot carry: the same composition emits it on macOS and not on Linux
# (deepseek-harness#2488), and the file must replay on both. Everything else is compared.
RUNTIME_CONTEXT_PREFIX = "Current runtime context"
MCP_SERVER_SCRIPT = """\
import json
import os
import sys
import time


log_path = os.environ.get("MCP_SMOKE_LOG")


def send(message):
    sys.stdout.write(json.dumps(message, separators=(",", ":")) + "\\n")
    sys.stdout.flush()


for line in sys.stdin:
    request = json.loads(line)
    if log_path is not None:
        with open(log_path, "a", encoding="utf-8") as log:
            log.write(str(request.get("method")) + "\\n")
    request_id = request.get("id")
    if request_id is None:
        continue
    method = request.get("method")
    if method == "initialize":
        send({
            "jsonrpc": "2.0",
            "id": request_id,
            "result": {
                "protocolVersion": request["params"]["protocolVersion"],
                "capabilities": {"tools": {"listChanged": False}},
                "serverInfo": {"name": "python-wheel-fixture", "version": "1.0.0"},
            },
        })
    elif method == "tools/list":
        # Keep discovery pending longer than the old smoke's 100 ms grace
        # period. An SDK runtime that answers initialize too early will make
        # its first model request without this tool and fail deterministically.
        time.sleep(0.25)
        send({
            "jsonrpc": "2.0",
            "id": request_id,
            "result": {
                "tools": [{
                    "name": "add",
                    "description": "Add two numbers.",
                    "inputSchema": {
                        "type": "object",
                        "properties": {"a": {"type": "number"}, "b": {"type": "number"}},
                        "required": ["a", "b"],
                        "additionalProperties": False,
                    },
                }],
            },
        })
    elif method == "tools/call":
        params = request["params"]
        if params.get("name") != "add" or params.get("arguments") != {"a": 19, "b": 23}:
            send({
                "jsonrpc": "2.0",
                "id": request_id,
                "error": {"code": -32602, "message": "unexpected tool call"},
            })
            continue
        send({
            "jsonrpc": "2.0",
            "id": request_id,
            "result": {"content": [{"type": "text", "text": "42"}]},
        })
    else:
        send({
            "jsonrpc": "2.0",
            "id": request_id,
            "error": {"code": -32601, "message": f"unsupported method: {method}"},
        })
"""


LEGACY_CUSTOM_DISABLED_ROWS = (
    "agent-instructions",
    "goal",
    "goal-round-driver",
    "command-goal",
    "plan-mode",
    "skill",
    "skill-filesystem",
    "tool-fs",
    "tool-fs-search",
    "tool-goal",
    "tool-ralph",
    "tool-skill",
    "tool-str-replace-editor",
    "tool-subagent-control",
    "tool-subagent-list-agents",
    "tool-subagent-fork",
    "tool-todo",
    "tool-web",
)


def write_profile_patch(
    root: Path,
    name: str,
    sessions: Path,
    patches: list[dict[str, object]],
) -> Path:
    """Write one JSON-form dsh profile patch with deterministic persistence."""
    path = root / name
    path.write_text(json.dumps([
        {
            "id": "session-persistence-jsonl",
            "config": {"root": str(sessions), "compression": "none"},
        },
        {"id": "session-telemetry-otel", "disabled": True},
        *patches,
    ], indent=2))
    return path


def write_advanced_profile_patch(root: Path, name: str, sessions: Path) -> Path:
    """Write the shared custom, snapshot, and restart profile patch."""
    return write_profile_patch(root, name, sessions, [
        {"id": "tools", "config": {"mode": "both"}},
        {
            "id": "system-prompt",
            "config": {
                "persona": "You are a coding agent powered by the {{model}} model. Your working directory is {{cwd}}.",
            },
        },
        {"id": "session-log-deepseek", "config": {"enabled": True}},
        *({"id": row_id, "disabled": True} for row_id in LEGACY_CUSTOM_DISABLED_ROWS),
        {"id": "tool-bash", "disabled": True},
        {"id": "tool-pwsh", "disabled": True},
        {
            "id": "tool-subagent",
            "config": {
                "provider": "spawn",
                "toolName": "subagent",
                "backgroundMode": "one-shot",
            },
        },
        {"insert": [
            {"id": "cordis-host-runner", "name": "@deepseek-ai/dsh-cordis-host-runner"},
            {"id": "cordis-tool", "name": "@deepseek-ai/dsh-tool-cordis"},
        ]},
    ])


def write_mcp_patch(root: Path, sessions: Path, server_script: Path) -> Path:
    """Write a profile patch that mounts the packaged MCP client."""
    return write_profile_patch(root, "mcp.patch.yml", sessions, [{
        "insert": [{
            "id": "mcp-fixture",
            "name": "@deepseek-ai/dsh-mcp-client",
            "config": {
                "serverName": "fixture",
                "transport": "stdio",
                "command": sys.executable,
                "args": [str(server_script)],
                "env": {"MCP_SMOKE_LOG": str(server_script.with_suffix(".log"))},
                "failOnStartupError": True,
                "reconnect": {"enabled": False},
            },
        }],
    }])


class MockModelHandler(BaseHTTPRequestHandler):
    """Return deterministic text, worker, and orchestration completions."""

    requests: list[dict[str, object]] = []

    def do_POST(self) -> None:
        content_length = int(self.headers.get("content-length", "0"))
        body = json.loads(self.rfile.read(content_length))
        self.requests.append(body)
        self.send_response(200)
        self.send_header("content-type", "text/event-stream")
        self.end_headers()
        for event in completion_chunks(body):
            self.wfile.write(f"event: {event['type']}\ndata: {json.dumps(event)}\n\n".encode())
        self.wfile.flush()

    def log_message(self, _format: str, *_args: object) -> None:
        return


def completion_chunks(body: dict[str, object]) -> list[dict[str, object]]:
    """Choose the next deterministic model response from request history."""
    messages = body.get("messages")
    if not isinstance(messages, list) or not messages:
        raise AssertionError(f"model request has no messages: {body}")
    # A system prompt update may follow the tool result without replacing it.
    latest = next(message for message in reversed(messages) if message.get("role") != "system")
    if not isinstance(latest, dict):
        raise AssertionError(f"model request has an invalid latest message: {body}")

    latest_result = latest_tool_result(latest)
    if latest_result is not None:
        call_id, tool_name = latest_tool_call(messages, latest_result)
        tool_text = tool_result_text(latest_result)
        mcp = mcp_tool_followup(call_id, tool_name, tool_text)
        if mcp is not None:
            return mcp
        fs_search = fs_search_tool_followup(call_id, tool_name, tool_text)
        if fs_search is not None:
            return fs_search
        minimal = minimal_tool_followup(body, call_id, tool_name, tool_text)
        if minimal is not None:
            return minimal
        advanced = advanced_tool_followup(body, call_id, tool_name, tool_text)
        if advanced is not None:
            return advanced
        if "42" not in tool_text:
            raise AssertionError(f"{tool_name} worker returned no expected value: {latest}")
        if tool_name == "run_code":
            return text_chunks(CODE_WORKER_TEXT)
        if tool_name == "workflow":
            return text_chunks(WORKFLOW_WORKER_TEXT)
        raise AssertionError(f"unexpected tool follow-up: {tool_name}")

    # One user message can carry several text blocks (prompt + runtime-context
    # snapshot); match scenario prompts per block, not per joined message.
    user_prompts = [
        block["text"]
        for message in reversed(messages)
        if isinstance(message, dict) and message.get("role") == "user"
        for block in message.get("content", [])
        if isinstance(block, dict) and block.get("type") == "text"
    ]
    minimal_prompt = next(
        (
            prompt
            for prompt in user_prompts
            if prompt.startswith(f"{MINIMAL_PROMPT}\n{MINIMAL_EDITOR_PATH_PREFIX}")
        ),
        None,
    )
    # The minimal composition's assembled system prompt, advertised tool schemas, and
    # model-visible messages are pinned by its snapshot, not asserted here.
    if minimal_prompt is not None:
        return tool_call_chunks(
            "minimal-bash-1",
            MINIMAL_SHELL_TOOL,
            {"command": MINIMAL_SHELL_COMMAND},
        )
    scenario_prompts = {
        SNAPSHOT_DIRECT_CHILD_PROMPT,
        SNAPSHOT_WORKFLOW_CHILD_PROMPT,
        SNAPSHOT_PROMPT,
        CODE_PROMPT,
        WORKFLOW_PROMPT,
        FS_SEARCH_PROMPT,
        MCP_PROMPT,
    }
    prompt = next(
        (candidate for candidate in user_prompts if candidate in scenario_prompts),
        message_text(latest.get("content")),
    )
    if prompt == SNAPSHOT_DIRECT_CHILD_PROMPT:
        return text_chunks("DIRECT_CHILD_OK")
    if prompt == SNAPSHOT_WORKFLOW_CHILD_PROMPT:
        return text_chunks("WORKFLOW_CHILD_OK")
    if prompt == SNAPSHOT_PROMPT:
        assert_read_only_cordis(body)
        assert_advertised_tool(body, "cordis_inspect_list")
        return tool_call_chunks("advanced-inspect", "cordis_inspect_list", {})
    if prompt == CODE_PROMPT:
        assert_advertised_tool(body, "run_code")
        return tool_call_chunks(
            "call-code-worker",
            "run_code",
            {"code": "return 6 * 7", "description": "Compute the smoke value"},
        )
    if prompt == WORKFLOW_PROMPT:
        assert_advertised_tool(body, "workflow")
        return tool_call_chunks(
            "call-workflow-worker",
            "workflow",
            {
                "script": "return 6 * 7",
                "meta": {
                    "name": "pkg-worker-smoke",
                    "description": "exercise the packaged workflow worker",
                },
            },
        )
    if prompt == FS_SEARCH_PROMPT:
        assert_advertised_tool(body, "grep")
        assert_advertised_tool(body, "glob")
        return tool_call_chunks(
            "fs-search-grep",
            "grep",
            {"pattern": FS_SEARCH_MARKER, "path": "."},
        )
    if prompt == MCP_PROMPT:
        assert_advertised_tool(body, "mcp__fixture__add")
        return tool_call_chunks(
            "mcp-add",
            "mcp__fixture__add",
            {"a": 19, "b": 23},
        )
    return text_chunks(EXPECTED_TEXT)


def mcp_tool_followup(
    call_id: str,
    tool_name: str,
    tool_text: str,
) -> list[dict[str, object]] | None:
    """Verify one tool call through the packaged MCP client."""
    if call_id != "mcp-add":
        return None
    if tool_name != "mcp__fixture__add" or "42" not in tool_text:
        raise AssertionError(f"packaged MCP call returned an unexpected result: {tool_name}: {tool_text}")
    return text_chunks(MCP_TEXT)


def fs_search_tool_followup(
    call_id: str,
    tool_name: str,
    tool_text: str,
) -> list[dict[str, object]] | None:
    """Exercise both ripgrep-backed tools through the packaged executable."""
    if not call_id.startswith("fs-search-"):
        return None
    if call_id == "fs-search-grep" and tool_name == "grep":
        if "needle.txt" not in tool_text or FS_SEARCH_MARKER not in tool_text:
            raise AssertionError(f"packaged grep returned no marker: {tool_text}")
        return tool_call_chunks(
            "fs-search-glob",
            "glob",
            {"pattern": "**/*.txt"},
        )
    if call_id == "fs-search-glob" and tool_name == "glob":
        if "needle.txt" not in tool_text:
            raise AssertionError(f"packaged glob returned no fixture path: {tool_text}")
        return text_chunks(FS_SEARCH_TEXT)
    raise AssertionError(f"unexpected filesystem-search follow-up: {call_id} {tool_name}: {tool_text}")


def minimal_tool_followup(
    body: dict[str, object],
    call_id: str,
    tool_name: str,
    tool_text: str,
) -> list[dict[str, object]] | None:
    """Verify the checked-in minimal composition's PTY and editor."""
    if not call_id.startswith("minimal-"):
        return None
    if call_id == "minimal-bash-1" and tool_name == MINIMAL_SHELL_TOOL:
        if "COUNT=1" not in tool_text:
            raise AssertionError(f"first persistent shell call lost its output: {tool_text}")
        return tool_call_chunks(
            "minimal-bash-2",
            MINIMAL_SHELL_TOOL,
            {"command": MINIMAL_SHELL_COMMAND},
        )
    if call_id == "minimal-bash-2" and tool_name == MINIMAL_SHELL_TOOL:
        expected = f"COUNT=2 CWD={MINIMAL_SHELL_SECOND_CWD}"
        if expected not in tool_text:
            raise AssertionError(f"persistent shell did not retain state: {tool_text}")
        messages = body.get("messages")
        if not isinstance(messages, list):
            raise AssertionError("persistent editor smoke request has no messages")
        editor_path = next(
            (
                text.split(MINIMAL_EDITOR_PATH_PREFIX, 1)[1].strip()
                for message in messages
                if isinstance(message, dict) and message.get("role") == "user"
                for text in [message_text(message.get("content"))]
                if MINIMAL_EDITOR_PATH_PREFIX in text
            ),
            None,
        )
        if editor_path is None:
            raise AssertionError("persistent editor smoke prompt has no editor path")
        return tool_call_chunks(
            "minimal-editor",
            "str_replace_editor",
            {
                "command": "create",
                "path": editor_path,
                "file_text": "created by packaged editor\n",
            },
        )
    if call_id == "minimal-editor" and tool_name == "str_replace_editor":
        if "New file created successfully" not in tool_text:
            raise AssertionError(f"packaged editor did not create its file: {tool_text}")
        return text_chunks(MINIMAL_TEXT)
    raise AssertionError(f"unexpected minimal-agent follow-up: {call_id} {tool_name}: {tool_text}")


def assert_read_only_cordis(body: dict[str, object]) -> None:
    """Reject a packaged runtime that advertises retired dynamic execution tools."""
    retired = {"cordis_define", "cordis_run", "cordis_stop", "cordis_undefine"}
    exposed = retired.intersection(advertised_tool_names(body))
    if exposed:
        raise AssertionError(f"retired Cordis tools remain callable: {sorted(exposed)}")


def advanced_tool_followup(
    body: dict[str, object],
    call_id: str,
    tool_name: str,
    tool_text: str,
) -> list[dict[str, object]] | None:
    """Advance the executable snapshot's deterministic parent tool chain."""
    if not call_id.startswith("advanced-"):
        return None
    assert_read_only_cordis(body)
    if call_id == "advanced-inspect" and tool_name == "cordis_inspect_list":
        providers = json.loads(tool_text).get("providers", [])
        if not any(provider.get("id") == "Tool" for provider in providers):
            raise AssertionError(f"Cordis inspection returned no Tool provider: {tool_text}")
        assert_advertised_tool(body, "run_code")
        return tool_call_chunks(
            "advanced-code",
            "run_code",
            {
                "code": "const result = await tools.cordis_inspect_query({ platform: 'host', provider: 'Tool', method: 'listTools' }); return { value: 21 * 2, tools: result.data.tools.map(tool => tool.name) }",
                "description": "Inspect callable tools through the packaged PTC runtime",
            },
        )
    if call_id == "advanced-code" and tool_name == "run_code":
        if "42" not in tool_text or "cordis_inspect_query" not in tool_text:
            raise AssertionError(f"run_code returned no inspection result: {tool_text}")
        assert_advertised_tool(body, "subagent")
        return tool_call_chunks(
            "advanced-direct-child",
            "subagent",
            {
                "description": "Check direct child",
                "prompt": SNAPSHOT_DIRECT_CHILD_PROMPT,
                "run_in_background": False,
            },
        )
    if call_id == "advanced-direct-child" and tool_name == "subagent":
        if "DIRECT_CHILD_OK" not in tool_text:
            raise AssertionError(f"subagent returned no expected child value: {tool_text}")
        assert_advertised_tool(body, "workflow")
        return tool_call_chunks(
            "advanced-workflow",
            "workflow",
            {
                "script": SNAPSHOT_WORKFLOW_SCRIPT,
                "meta": {
                    "name": "advanced-exe-snapshot",
                    "description": "exercise one packaged workflow child",
                },
            },
        )
    if call_id == "advanced-workflow" and tool_name == "workflow":
        if "WORKFLOW_CHILD_OK" not in tool_text:
            raise AssertionError(f"workflow returned no expected child value: {tool_text}")
        return text_chunks(SNAPSHOT_FINAL_TEXT)
    raise AssertionError(f"unexpected advanced tool follow-up: {call_id} {tool_name}: {tool_text}")


def text_chunks(text: str) -> list[dict[str, object]]:
    """Build a complete Messages-protocol streaming text response."""
    return [
        {"type": "message_start", "message": {"id": "smoke", "model": "smoke-model", "usage": {"input_tokens": 3, "output_tokens": 0}}},
        {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}},
        {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": text}},
        {"type": "content_block_stop", "index": 0},
        {"type": "message_delta", "delta": {"stop_reason": "end_turn"}, "usage": {"output_tokens": 3}},
        {"type": "message_stop"},
    ]


def tool_call_chunks(call_id: str, name: str, arguments: dict[str, object]) -> list[dict[str, object]]:
    """Build a complete Messages-protocol streaming tool_use response."""
    return [
        {"type": "message_start", "message": {"id": "smoke", "model": "smoke-model", "usage": {"input_tokens": 3, "output_tokens": 0}}},
        {"type": "content_block_start", "index": 0, "content_block": {"type": "tool_use", "id": call_id, "name": name, "input": {}}},
        {"type": "content_block_delta", "index": 0, "delta": {"type": "input_json_delta", "partial_json": json.dumps(arguments)}},
        {"type": "content_block_stop", "index": 0},
        {"type": "message_delta", "delta": {"stop_reason": "tool_use"}, "usage": {"output_tokens": 3}},
        {"type": "message_stop"},
    ]


def latest_tool_result(message: dict[str, object]) -> dict[str, object] | None:
    """Return the tool_result block when the latest message is a tool reply."""
    content = message.get("content")
    if message.get("role") != "user" or not isinstance(content, list):
        return None
    results = [
        block for block in content
        if isinstance(block, dict) and block.get("type") == "tool_result"
    ]
    if not results:
        return None
    # Parallel tool calls deliver several tool_result blocks in one message;
    # the mock chain only ever awaits the last issued call.
    return results[-1]


def latest_tool_call(messages: list[object], result: dict[str, object]) -> tuple[str, str]:
    """Find the assistant tool_use id and name paired with the latest result."""
    wanted = result.get("tool_use_id")
    for message in reversed(messages[:-1]):
        if not isinstance(message, dict) or message.get("role") != "assistant":
            continue
        content = message.get("content")
        if not isinstance(content, list):
            continue
        for block in reversed(content):
            if not isinstance(block, dict) or block.get("type") != "tool_use":
                continue
            call_id = block.get("id")
            name = block.get("name")
            if isinstance(call_id, str) and isinstance(name, str) and call_id == wanted:
                return call_id, name
    raise AssertionError(f"tool result has no preceding assistant tool call: {messages}")


def message_text(content: object) -> str:
    """Read Messages-protocol text blocks from one message's content."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "".join(
            block["text"]
            for block in content
            if isinstance(block, dict) and block.get("type") == "text" and isinstance(block.get("text"), str)
        )
    return ""


def tool_result_text(result: dict[str, object]) -> str:
    """Read the text inside one tool_result block's content."""
    return message_text(result.get("content"))


def advertised_tool_names(body: dict[str, object]) -> set[str]:
    """Return the model-facing tool names advertised on one request."""
    tools = body.get("tools")
    if not isinstance(tools, list):
        raise AssertionError(f"model request advertised no tools: {body}")
    names: set[str] = set()
    for tool in tools:
        if isinstance(tool, dict) and isinstance(tool.get("name"), str):
            names.add(tool["name"])
    return names


def assert_advertised_tool(body: dict[str, object], expected: str) -> None:
    """Require the packaged deployment to expose the requested tool."""
    names = advertised_tool_names(body)
    if expected not in names:
        raise AssertionError(f"model request did not advertise {expected}: {names}")


class MockModel:
    def __enter__(self) -> "MockModel":
        MockModelHandler.requests.clear()
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), MockModelHandler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        host, port = self.server.server_address
        self.url = f"http://{host}:{port}"
        return self

    def __exit__(self, _exc_type: object, _exc: object, _tb: object) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--scenario",
        choices=("all", "sdk-default", "sdk-custom", "sdk-minimal", "sdk-fs-search", "sdk-mcp", "sdk-snapshot", "direct"),
        default="all",
    )
    parser.add_argument("--exe", type=Path)
    parser.add_argument("--update-snapshots", action="store_true")
    args = parser.parse_args()
    if args.scenario in {"all", "sdk-custom", "sdk-minimal", "sdk-fs-search", "sdk-snapshot", "direct"} and args.exe is None:
        parser.error("--exe is required for custom, minimal, snapshot, and direct scenarios")
    if args.update_snapshots and args.scenario not in {"all", "sdk-minimal", "sdk-snapshot"}:
        parser.error("--update-snapshots requires --scenario sdk-minimal, sdk-snapshot, or all")
    if args.exe is not None and not args.exe.is_file():
        parser.error(f"runtime executable does not exist: {args.exe}")

    with MockModel() as model:
        if args.scenario in {"all", "sdk-default"}:
            smoke_sdk_default(model.url)
        if args.scenario in {"all", "sdk-custom"}:
            assert args.exe is not None
            smoke_sdk_custom(model.url, args.exe.resolve())
        if args.scenario in {"all", "sdk-minimal"}:
            assert args.exe is not None
            smoke_sdk_minimal(model.url, args.exe.resolve(), args.update_snapshots)
        if args.scenario in {"all", "sdk-fs-search"}:
            assert args.exe is not None
            smoke_sdk_fs_search(model.url, args.exe.resolve())
        if args.scenario in {"all", "sdk-mcp"}:
            smoke_sdk_mcp(model.url, None if args.exe is None else args.exe.resolve())
        if args.scenario in {"all", "sdk-snapshot"}:
            assert args.exe is not None
            smoke_sdk_snapshot(model.url, args.exe.resolve(), args.update_snapshots)
        if args.scenario in {"all", "direct"}:
            assert args.exe is not None
            smoke_direct(model.url, args.exe.resolve())
        if not MockModelHandler.requests:
            raise AssertionError("mock model endpoint received no requests")
    print(f"smoke-python-runtime: {args.scenario} passed")


def smoke_sdk_default(base_url: str) -> None:
    from deepseek_harness import DeepSeekHarness

    with tempfile.TemporaryDirectory(prefix="dsh-sdk-default-") as temporary:
        root = Path(temporary).resolve()
        dsh_home = root / "home"
        sessions = dsh_home / "sessions"
        with DeepSeekHarness(
            provider="deepseek-official",
            model="smoke-model",
            cwd=str(root),
            dsh_home=str(dsh_home),
            env={"DSH_PERMISSION_MODE": "danger-full-access", "DSH_TELEMETRY_DISABLED": "1"},
            api_key="sk-keyless-smoke",
            base_url=base_url,
            request_timeout_seconds=60,
        ) as harness:
            result = harness.run("reply with the smoke text", session_id="default-smoke")
        assert result.final_response == EXPECTED_TEXT, (
            f"final_response={result.final_response!r}; "
            f"events={json.dumps(result.events[-8:])}; "
            f"notifications={json.dumps([n.payload for n in result.notifications[-8:]], default=str)}"
        )
        assert_zstd_session_log(sessions)


def smoke_sdk_custom(base_url: str, executable: Path) -> None:
    from deepseek_harness import DeepSeekHarness

    with tempfile.TemporaryDirectory(prefix="dsh-sdk-custom-") as temporary:
        root = Path(temporary).resolve()
        dsh_home = root / "home"
        sessions = dsh_home / "sessions"
        patch = write_advanced_profile_patch(root, "custom.patch.yml", sessions)
        with DeepSeekHarness(
            provider="deepseek-official",
            model="smoke-model",
            cwd=str(root),
            dsh_home=str(dsh_home),
            env={"DSH_PERMISSION_MODE": "danger-full-access", "DSH_TELEMETRY_DISABLED": "1"},
            patches=(str(patch),),
            dsh_bin=str(executable),
            api_key="sk-keyless-smoke",
            base_url=base_url,
            request_timeout_seconds=60,
        ) as harness:
            text_result = harness.run("reply with the smoke text", session_id="custom-smoke")
            code_result = harness.run(CODE_PROMPT, session_id="custom-smoke")
            workflow_result = harness.run(WORKFLOW_PROMPT, session_id="custom-smoke")
        assert text_result.final_response == EXPECTED_TEXT, (
            f"final_response={text_result.final_response!r}; "
            f"events={json.dumps(text_result.events[-8:])}; "
            f"notifications={json.dumps([n.payload for n in text_result.notifications[-8:]], default=str)}; "
            f"requests={json.dumps(MockModelHandler.requests[-2:], default=str)[:4000]}"
        )
        assert code_result.final_response == CODE_WORKER_TEXT, (
            f"final_response={code_result.final_response!r}; "
            f"events={json.dumps(code_result.events[-8:])}; "
            f"notifications={json.dumps([n.payload for n in code_result.notifications[-8:]], default=str)}"
        )
        assert workflow_result.final_response == WORKFLOW_WORKER_TEXT, (
            f"final_response={workflow_result.final_response!r}; "
            f"events={json.dumps(workflow_result.events[-8:])}; "
            f"notifications={json.dumps([n.payload for n in workflow_result.notifications[-8:]], default=str)}"
        )
        assert_session_log(sessions, root, EXPECTED_TEXT, CODE_WORKER_TEXT, WORKFLOW_WORKER_TEXT)


def smoke_sdk_minimal(base_url: str, executable: Path, update_snapshots: bool) -> None:
    """Exercise the checked-in minimal composition through the packaged executable."""
    from deepseek_harness import DeepSeekHarness

    # One mock model serves every scenario of a run, so the snapshot takes this turn's slice.
    first_request = len(MockModelHandler.requests)
    with tempfile.TemporaryDirectory(prefix="dsh-sdk-minimal-") as temporary:
        root = Path(temporary).resolve()
        editor_path = root / "created.txt"
        prompt = f"{MINIMAL_PROMPT}\n{MINIMAL_EDITOR_PATH_PREFIX}{editor_path}"
        dsh_home = root / "home"
        sessions = dsh_home / "sessions"
        patch = root / "editor.patch.yml"
        patch.write_text(json.dumps([{"insert": [
            {"id": "fs-local", "name": "@deepseek-ai/dsh-fs-local", "config": {"cwd": str(root)}},
            {"id": "str-replace-editor", "name": "@deepseek-ai/dsh-tool-str-replace-editor", "config": {"maxOutputChars": 16000}},
        ]}]))
        with DeepSeekHarness(
            provider="deepseek-official",
            model="smoke-model",
            cwd=str(root),
            dsh_home=str(dsh_home),
            env={"DSH_PERMISSION_MODE": "danger-full-access", "DSH_TELEMETRY_DISABLED": "1"},
            profile="sdk-minimal",
            patches=(str(patch),),
            dsh_bin=str(executable),
            api_key="sk-keyless-smoke",
            base_url=base_url,
            request_timeout_seconds=60,
        ) as harness:
            result = harness.run(prompt, session_id="minimal-agent-smoke")

        event_text = json.dumps(result.events)
        if MINIMAL_TEXT not in event_text:
            raise AssertionError(f"minimal agent run emitted no final response: {result.events}")
        if editor_path.read_text() != "created by packaged editor\n":
            raise AssertionError(f"packaged editor wrote unexpected content: {editor_path.read_text()!r}")
        assert_session_log(sessions, root, MINIMAL_TEXT, "COUNT=1", "COUNT=2")

        files = build_minimal_snapshot_files(MockModelHandler.requests[first_request:], root)
        compare_snapshot_files(
            files, update_snapshots, MINIMAL_SNAPSHOT_DIRECTORY, MINIMAL_SNAPSHOT_FILENAMES,
        )


def smoke_sdk_fs_search(base_url: str, executable: Path) -> None:
    """Exercise real grep and glob spawns through the packaged executable."""
    from deepseek_harness import DeepSeekHarness

    with tempfile.TemporaryDirectory(prefix="dsh-sdk-fs-search-") as temporary:
        root = Path(temporary).resolve()
        (root / "needle.txt").write_text(f"{FS_SEARCH_MARKER}\n")
        dsh_home = root / "home"
        sessions = dsh_home / "sessions"
        patch = write_profile_patch(root, "fs-search.patch.yml", sessions, [
            {"id": "tool-fs-search", "config": {"sampleOverCapGlobResults": False}},
        ])
        with DeepSeekHarness(
            provider="deepseek-official",
            model="smoke-model",
            cwd=str(root),
            dsh_home=str(dsh_home),
            env={"DSH_PERMISSION_MODE": "danger-full-access", "DSH_TELEMETRY_DISABLED": "1"},
            patches=(str(patch),),
            dsh_bin=str(executable),
            api_key="sk-keyless-smoke",
            base_url=base_url,
            request_timeout_seconds=60,
        ) as harness:
            result = harness.run(FS_SEARCH_PROMPT, session_id="fs-search-smoke")

        assert result.final_response == FS_SEARCH_TEXT, result.final_response
        assert_session_log(sessions, root, FS_SEARCH_TEXT, FS_SEARCH_MARKER, "needle.txt")


def smoke_sdk_mcp(base_url: str, executable: Path | None) -> None:
    """Discover and call an external stdio MCP tool through the packaged client."""
    from deepseek_harness import DeepSeekHarness

    with tempfile.TemporaryDirectory(prefix="dsh-sdk-mcp-") as temporary:
        root = Path(temporary).resolve()
        dsh_home = root / "home"
        sessions = dsh_home / "sessions"
        server_script = root / "mcp_server.py"
        server_script.write_text(MCP_SERVER_SCRIPT)
        patch = write_mcp_patch(root, sessions, server_script)
        discovery_log = server_script.with_suffix(".log")
        with DeepSeekHarness(
            provider="deepseek-official",
            model="smoke-model",
            cwd=str(root),
            dsh_home=str(dsh_home),
            env={"DSH_PERMISSION_MODE": "danger-full-access", "DSH_TELEMETRY_DISABLED": "1"},
            patches=(str(patch),),
            dsh_bin=None if executable is None else str(executable),
            api_key="sk-keyless-smoke",
            base_url=base_url,
            request_timeout_seconds=60,
        ) as harness:
            result = harness.run(MCP_PROMPT, session_id="mcp-smoke")

        assert result.final_response == MCP_TEXT, result.final_response
        assert discovery_log.read_text().splitlines() == [
            "server/discover",
            "initialize",
            "notifications/initialized",
            "tools/list",
            "tools/call",
        ]
        assert_session_log(sessions, root, MCP_TEXT, "mcp__fixture__add", "42")


def smoke_sdk_snapshot(base_url: str, executable: Path, update_snapshots: bool) -> None:
    """Drive and compare the advanced SDK/executable behavioral snapshot."""
    from deepseek_harness import DeepSeekHarness

    with tempfile.TemporaryDirectory(prefix="dsh-sdk-snapshot-") as temporary:
        root = Path(temporary).resolve()
        dsh_home = root / "home"
        sessions = dsh_home / "sessions"
        patch = write_advanced_profile_patch(root, "custom.patch.yml", sessions)
        with DeepSeekHarness(
            provider="deepseek-official",
            model="smoke-model",
            cwd=str(root),
            dsh_home=str(dsh_home),
            env={"DSH_PERMISSION_MODE": "danger-full-access", "DSH_TELEMETRY_DISABLED": "1"},
            patches=(str(patch),),
            dsh_bin=str(executable),
            api_key="sk-keyless-smoke",
            base_url=base_url,
            request_timeout_seconds=60,
        ) as harness:
            result = harness.run(SNAPSHOT_PROMPT, session_id=SNAPSHOT_SESSION_ID)

        assert result.final_response == SNAPSHOT_FINAL_TEXT, (
            f"final_response={result.final_response!r}; "
            f"events={json.dumps(result.events[-8:])}; "
            f"requests={json.dumps(MockModelHandler.requests[-3:], default=str)[:4000]}"
        )
        methods = [notification.method for notification in result.notifications]
        if methods.count("subagent.started") != 2 or methods.count("subagent.finished") != 2:
            raise AssertionError(f"advanced snapshot emitted unexpected subagent lifecycle: {methods}")
        if not any(event.get("type") == "tool/ptc-dispatch" for event in result.events):
            raise AssertionError("advanced snapshot emitted no tool/ptc-dispatch event")

        logs = read_session_logs(sessions)
        child_ids = snapshot_child_ids(result)
        expected_ids = {SNAPSHOT_SESSION_ID, *child_ids}
        if set(logs) != expected_ids:
            raise AssertionError(f"advanced snapshot expected parent plus two child logs: {sorted(logs)}")
        if "DIRECT_CHILD_OK" not in render_jsonl(logs[child_ids[0]]):
            raise AssertionError("first advanced child log has no direct-subagent result")
        if "WORKFLOW_CHILD_OK" not in render_jsonl(logs[child_ids[1]]):
            raise AssertionError("second advanced child log has no workflow-subagent result")

        files = build_snapshot_files(result, logs, child_ids, root)
        compare_snapshot_files(
            files, update_snapshots, ADVANCED_SNAPSHOT_DIRECTORY, ADVANCED_SNAPSHOT_FILENAMES,
        )


def smoke_direct(base_url: str, executable: Path) -> None:
    with tempfile.TemporaryDirectory(prefix="dsh-direct-") as temporary:
        root = Path(temporary).resolve()
        dsh_home = root / "home"
        sessions = dsh_home / "sessions"
        patch = write_advanced_profile_patch(root, "custom.patch.yml", sessions)
        environment = {
            **os.environ,
            "DSH_HOME": str(dsh_home),
            "DSH_PERMISSION_MODE": "danger-full-access",
            "DSH_TELEMETRY_DISABLED": "1",
            "DSH_CWD": str(root),
            "DEEPSEEK_API_KEY": "sk-keyless-smoke",
            "DEEPSEEK_BASE_URL": base_url,
        }
        peer = RuntimePeer([str(executable), "--profile", "sdk", "--patch", str(patch)], root, environment)
        try:
            peer.send({"jsonrpc": "2.0", "id": "initialize", "method": "initialize", "params": {"cwd": str(root), "provider": "deepseek-official", "model": "smoke-model"}})
            peer.read_until(lambda message: message.get("id") == "initialize")
            peer.send({
                "jsonrpc": "2.0",
                "id": "prompt",
                "method": "session/prompt",
                "params": {"sessionId": "direct-smoke", "contentBlocks": [{"type": "text", "text": "reply with the smoke text"}]},
            })
            messages = peer.read_until(lambda message: message.get("id") == "prompt")
            if not any(is_idle_notification(message) for message in messages):
                messages.extend(peer.read_until(is_idle_notification))
            event_text = json.dumps(messages)
            if EXPECTED_TEXT not in event_text:
                raise AssertionError(f"direct runtime emitted no final response: {messages}")
            peer.send({"jsonrpc": "2.0", "id": "shutdown", "method": "shutdown"})
            peer.read_until(lambda message: message.get("id") == "shutdown")
        finally:
            peer.close()
        assert_session_log(sessions, root, EXPECTED_TEXT)


def is_idle_notification(message: dict[str, object]) -> bool:
    """Return whether a JSON-RPC notification marks a session idle."""
    params = message.get("params")
    return (
        message.get("method") == "session.status"
        and isinstance(params, dict)
        and params.get("status") == "idle"
    )


class RuntimePeer:
    def __init__(self, argv: list[str], cwd: Path, environment: dict[str, str]) -> None:
        self.process = subprocess.Popen(
            argv,
            cwd=cwd,
            env=environment,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            bufsize=1,
        )
        self.stdout: queue.Queue[str | None] = queue.Queue()
        self.stderr: list[str] = []
        threading.Thread(target=self._read_stdout, daemon=True).start()
        threading.Thread(target=self._read_stderr, daemon=True).start()

    def send(self, message: dict[str, object]) -> None:
        if self.process.stdin is None:
            raise RuntimeError("runtime stdin is unavailable")
        self.process.stdin.write(json.dumps(message) + "\n")
        self.process.stdin.flush()

    def read_until(self, predicate: Callable[[dict[str, object]], bool]) -> list[dict[str, object]]:
        deadline = time.monotonic() + 60
        messages: list[dict[str, object]] = []
        while time.monotonic() < deadline:
            try:
                line = self.stdout.get(timeout=min(0.25, deadline - time.monotonic()))
            except queue.Empty:
                continue
            if line is None:
                raise RuntimeError(f"runtime exited before expected message; stderr: {''.join(self.stderr)}")
            try:
                message = json.loads(line)
            except json.JSONDecodeError:
                continue
            messages.append(message)
            if predicate(message):
                return messages
        raise TimeoutError(f"runtime timed out; messages={messages}; stderr={''.join(self.stderr)}")

    def close(self) -> None:
        if self.process.stdin is not None and not self.process.stdin.closed:
            self.process.stdin.close()
        try:
            self.process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait()
        if self.process.returncode not in {0, -15}:
            raise RuntimeError(f"runtime exited {self.process.returncode}; stderr: {''.join(self.stderr)}")

    def _read_stdout(self) -> None:
        assert self.process.stdout is not None
        for line in self.process.stdout:
            self.stdout.put(line)
        self.stdout.put(None)

    def _read_stderr(self) -> None:
        assert self.process.stderr is not None
        self.stderr.extend(self.process.stderr)


def assert_session_log(sessions: Path, cwd: Path, *expected_texts: str) -> None:
    logs = list(sessions.rglob("*.jsonl"))
    if len(logs) != 1:
        raise AssertionError(f"expected one JSONL session log under {sessions}, found {logs}")
    lines = logs[0].read_text().splitlines()
    header = json.loads(lines[0])
    if header.get("cwd") != str(cwd):
        raise AssertionError(f"session header cwd is not absolute/canonical: {header}")
    rendered = "\n".join(lines)
    for expected in expected_texts:
        if expected not in rendered:
            raise AssertionError(f"session log has no {expected!r} response: {logs[0]}")


def assert_zstd_session_log(sessions: Path) -> None:
    logs = list(sessions.rglob("*.jsonl.zstd"))
    if len(logs) != 1:
        raise AssertionError(f"expected one Zstandard JSONL session log under {sessions}, found {logs}")
    if not logs[0].read_bytes().startswith(bytes.fromhex("28b52ffd")):
        raise AssertionError(f"session log has no Zstandard magic: {logs[0]}")


def read_session_logs(sessions: Path) -> dict[str, list[dict[str, object]]]:
    """Parse every persisted JSONL session into a map keyed by header id."""
    logs: dict[str, list[dict[str, object]]] = {}
    for path in sorted(sessions.rglob("*.jsonl")):
        records = [
            json.loads(line)
            for line in path.read_text(encoding="utf-8").splitlines()
            if line
        ]
        if not records or records[0].get("type") != "session":
            raise AssertionError(f"session log has no header: {path}")
        session_id = records[0].get("id")
        if not isinstance(session_id, str):
            raise AssertionError(f"session log header has no string id: {path}")
        if session_id in logs:
            raise AssertionError(f"duplicate persisted session id: {session_id}")
        logs[session_id] = records
    return logs


def snapshot_child_ids(result: "RunResult") -> list[str]:
    """Return the two child session ids in their SDK notification order."""
    child_ids: list[str] = []
    for notification in result.notifications:
        if notification.method != "subagent.started":
            continue
        payload = notification.payload
        if payload.get("parentSessionId") != SNAPSHOT_SESSION_ID:
            continue
        child_id = payload.get("childSessionId")
        if isinstance(child_id, str) and child_id not in child_ids:
            child_ids.append(child_id)
    if len(child_ids) != 2:
        raise AssertionError(f"advanced snapshot expected two child session ids: {child_ids}")
    return child_ids


def build_minimal_snapshot_files(
    requests: list[dict[str, object]],
    cwd: Path,
) -> dict[str, str]:
    """Render the minimal composition's model-visible surface as expected output.

    Every assembled system prompt, advertised tool schema, and system or user message is
    kept verbatim: they carry what the deployment actually shows the model, so a plugin
    that contributes an unintended system section or user message cannot pass unnoticed.
    Assistant and tool payloads keep only their call identity, and the dynamic
    runtime-context snapshot is dropped, because their text differs across the platforms
    this expected output must replay on.
    """
    snapshot = []
    for body in requests:
        messages = body.get("messages")
        if not isinstance(messages, list):
            raise AssertionError(f"minimal model request has no messages: {body}")
        rows = []
        system = body.get("system")
        if isinstance(system, str) and system:
            rows.append({"role": "system", "text": minimal_snapshot_text(system, cwd)})
        rows.extend(
            minimal_snapshot_message(message, cwd)
            for message in messages
            if not is_runtime_context_message(message)
        )
        snapshot.append({"tools": minimal_snapshot_tools(body.get("tools"), cwd), "messages": rows})
    return {"model-visible.json": json.dumps(snapshot, indent=2, ensure_ascii=False) + "\n"}


def is_runtime_context_message(message: object) -> bool:
    """Identify the agent loop's dynamic runtime-context snapshot, current or cleared."""
    return (
        isinstance(message, dict)
        and message.get("role") == "user"
        and message_text(message.get("content")).startswith(RUNTIME_CONTEXT_PREFIX)
    )


def minimal_snapshot_tools(tools: object, cwd: Path) -> object:
    """Project advertised tool schemas to their protocol-independent surface."""
    if not isinstance(tools, list):
        return minimal_snapshot_text(tools, cwd)
    return minimal_snapshot_text(
        [
            {
                "name": tool.get("name"),
                "description": tool.get("description"),
                "parameters": tool.get("input_schema"),
            }
            for tool in tools
            if isinstance(tool, dict)
        ],
        cwd,
    )


def minimal_snapshot_message(message: object, cwd: Path) -> dict[str, object]:
    """Reduce one model-visible message to its stable, behavior-carrying parts."""
    if not isinstance(message, dict):
        raise AssertionError(f"minimal model request has an invalid message: {message}")
    role = message.get("role")
    if role == "system":
        return {"role": role, "text": minimal_snapshot_text(message_text(message.get("content")), cwd)}
    if role == "assistant":
        content = message.get("content")
        if not isinstance(content, list):
            raise AssertionError(f"minimal assistant message has no content blocks: {message}")
        return {
            "role": role,
            "toolCalls": [
                {"id": block.get("id"), "name": block.get("name")}
                for block in content
                if isinstance(block, dict) and block.get("type") == "tool_use"
            ],
        }
    if role != "user":
        raise AssertionError(f"minimal model request has an unexpected message role: {message}")
    results = latest_tool_result(message)
    if results is not None:
        return {"role": "tool", "toolCallId": results.get("tool_use_id"), "text": "{{tool-result}}"}
    return {"role": role, "text": minimal_snapshot_text(message_text(message.get("content")), cwd)}


def minimal_snapshot_text(value: object, cwd: Path) -> object:
    """Replace the scenario's temporary working directory everywhere it appears."""
    if isinstance(value, str):
        return value.replace(str(cwd), "{{cwd}}")
    if isinstance(value, list):
        return [minimal_snapshot_text(item, cwd) for item in value]
    if isinstance(value, dict):
        return {key: minimal_snapshot_text(item, cwd) for key, item in value.items()}
    return value


def build_snapshot_files(
    result: "RunResult",
    logs: dict[str, list[dict[str, object]]],
    child_ids: list[str],
    cwd: Path,
) -> dict[str, str]:
    """Render the SDK result and three persisted logs into stable expected outputs."""
    replacements = [(str(cwd), "{{cwd}}"), (SNAPSHOT_SESSION_ID, "{{parent}}")]
    replacements.append((snapshot_workflow_run_id(result), "{{workflow-run}}"))
    for index, child_id in enumerate(child_ids, start=1):
        replacements.append((child_id, f"{{{{child-{index}}}}}"))
        agent_id = snapshot_agent_id(result, child_id)
        replacements.append((agent_id, f"{{{{agent-{index}}}}}"))
    replacements.sort(key=lambda pair: len(pair[0]), reverse=True)

    result_value = {
        "session_id": result.session_id,
        "final_response": result.final_response,
        "events": result.events,
        "notifications": [
            {"method": notification.method, "payload": notification.payload}
            for notification in result.notifications
        ],
    }
    normalized = normalize_snapshot_value({"result": result_value, "logs": logs}, replacements)
    assert isinstance(normalized, dict)
    notifications = normalized["result"]["notifications"]
    assert isinstance(notifications, list)
    # session.event notifications merge every session's stream; each session
    # emits in seq order but sessions interleave by arrival. Canonically sort
    # them back into their own positions so the race cannot flake the snapshot.
    event_rows = [row for row in notifications if isinstance(row, dict) and row.get("method") == "session.event"]
    event_positions = [
        index for index, row in enumerate(notifications)
        if isinstance(row, dict) and row.get("method") == "session.event"
    ]

    def event_key(row: dict[str, object]) -> tuple[object, object]:
        payload = row.get("payload")
        assert isinstance(payload, dict)
        event = payload.get("event")
        assert isinstance(event, dict)
        return payload.get("sessionId"), event.get("seq")

    for position, row in zip(event_positions, sorted(event_rows, key=event_key)):
        notifications[position] = row
    normalized_logs = normalized["logs"]
    assert isinstance(normalized_logs, dict)
    files = {"result.json": json.dumps(normalized["result"], indent=2, ensure_ascii=False) + "\n"}
    for index, session_id in enumerate([SNAPSHOT_SESSION_ID, *child_ids]):
        name = "session.jsonl" if index == 0 else f"session.{index}.jsonl"
        files[name] = render_jsonl(project_session_snapshot(normalized_logs[session_id]))
    return files


def snapshot_workflow_run_id(result: "RunResult") -> str:
    """Return the one workflow run id emitted by the advanced scenario."""
    run_ids: set[str] = set()
    for event in result.events:
        event_type = event.get("type")
        data = event.get("data")
        if not isinstance(event_type, str) or not event_type.startswith("tool-workflow/"):
            continue
        if isinstance(data, dict) and isinstance(data.get("runId"), str):
            run_ids.add(data["runId"])
    if len(run_ids) != 1:
        raise AssertionError(f"advanced snapshot expected one workflow run id: {sorted(run_ids)}")
    return next(iter(run_ids))


def snapshot_agent_id(result: "RunResult", child_id: str) -> str:
    """Find the successful subagent id paired with one child session."""
    for notification in result.notifications:
        if notification.method != "subagent.finished":
            continue
        payload = notification.payload
        if payload.get("childSessionId") != child_id:
            continue
        if payload.get("provider") != "spawn" or payload.get("status") != "ok":
            raise AssertionError(f"advanced child did not finish successfully: {payload}")
        agent_id = payload.get("agentId")
        if isinstance(agent_id, str):
            return agent_id
    raise AssertionError(f"advanced snapshot has no finished agent for child {child_id}")


def normalize_snapshot_value(
    value: object,
    replacements: list[tuple[str, str]],
) -> object:
    """Normalize owned identities and event clocks while keeping prompts and schemas exact."""
    tokens = dict(replacements)
    next_by_kind: dict[str, int] = {}
    uuid = re.compile(r"^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$", re.I)
    canonical = re.compile(r"^\{\{([a-z]+):([1-9][0-9]*)\}\}$")
    fields = {
        "sessionId": "session", "parentSessionId": "session", "rootSessionId": "session",
        "messageId": "message", "participantId": "principal", "principalId": "principal",
        "projectId": "project", "runtimeId": "runtime", "executionTargetId": "target",
        "resourceId": "resource", "commandId": "command", "rpcId": "rpc",
        "retryId": "retry", "runId": "workflow",
    }

    def reserve(item: object) -> None:
        if isinstance(item, str):
            match = canonical.fullmatch(item)
            if match:
                kind, ordinal = match.groups()
                next_by_kind[kind] = max(next_by_kind.get(kind, 0), int(ordinal))
        elif isinstance(item, list):
            for child in item:
                reserve(child)
        elif isinstance(item, dict):
            for child in item.values():
                reserve(child)

    def claim(item: object, kind: str, always: bool = False) -> None:
        if not isinstance(item, str) or not item or item in tokens:
            return
        if canonical.fullmatch(item):
            tokens[item] = item
        elif always or uuid.fullmatch(item) or item in ("{{messageId}}", "{{sessionId}}"):
            ordinal = next_by_kind.get(kind, 0) + 1
            next_by_kind[kind] = ordinal
            tokens[item] = "{{" + kind + ":" + str(ordinal) + "}}"

    def collect(item: object, event_type: object = None) -> None:
        if isinstance(item, list):
            for child in item:
                collect(child, event_type)
        elif isinstance(item, dict):
            event_type = item.get("type", event_type)
            if item.get("type") == "session":
                claim(item.get("id"), "session", True)
            if isinstance(item.get("role"), str) and isinstance(item.get("content"), list) and isinstance(item.get("source"), dict):
                claim(item.get("id"), "message")
            if item.get("type") == "feedback/message-put":
                data = item.get("data")
                feedback = data.get("item") if isinstance(data, dict) else None
                if isinstance(feedback, dict):
                    claim(feedback.get("version"), "id")
            if item.get("type") in ("compaction/start", "compaction/summary", "compaction/end"):
                data = item.get("data")
                if isinstance(data, dict):
                    claim(data.get("compactionId"), "compaction")
            for key, child in item.items():
                if key in {"content", "args", "arguments", "parameters", "schema", "inputSchema", "input_schema"}:
                    continue
                if key == "id" and event_type in ("approval/asked", "approval/decided"):
                    claim(child, "approval")
                elif key in fields:
                    claim(child, fields[key], key in ("commandId", "rpcId"))
                collect(child, event_type)

    reserve(value)
    collect(value)
    pattern = re.compile(r"(?<![\w-])(?:" + "|".join(re.escape(source) for source in sorted(tokens, key=len, reverse=True)) + r")(?![\w-])") if tokens else None

    def normalize(item: object) -> object:
        if isinstance(item, str):
            if item in tokens:
                return tokens[item]
            return pattern.sub(lambda match: tokens[match.group()], item) if pattern else item
        if isinstance(item, list):
            return [normalize(child) for child in item]
        if not isinstance(item, dict):
            return item
        result = {key: normalize(child) for key, child in item.items()}
        if result.get("type") == "session" and "createdAt" in result:
            result["createdAt"] = 0
        data = result.get("data")
        if isinstance(result.get("type"), str) and isinstance(data, dict):
            if "seq" in result and "time" in result:
                result["time"] = 0
            if result["type"] == "subagent/catalog" and "childCreatedAt" in data:
                data["childCreatedAt"] = 0
            if result["type"] in ("assistant/message", "assistant/attempt"):
                stream = data.get("stream")
                if isinstance(stream, list):
                    for row in stream:
                        if not isinstance(row, dict):
                            continue
                        for key in ("time", "time0"):
                            if key in row:
                                row[key] = 0
                        if isinstance(row.get("dt"), list):
                            row["dt"] = [0] * len(row["dt"])
        return result

    return normalize(value)


def render_jsonl(records: list[object]) -> str:
    """Render parsed JSON values as compact, newline-terminated JSONL."""
    return "".join(
        json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n"
        for record in records
    )


def project_session_snapshot(records: list[dict[str, object]]) -> list[dict[str, object]]:
    """Omit storage sequence/time envelopes from snapshot body records."""
    projected = [dict(record) for record in records]
    for record in projected[1:]:
        for key in ("seq", "time", "seq0", "time0"):
            record.pop(key, None)
    return projected


def compare_snapshot_files(
    files: dict[str, str],
    update: bool,
    directory: Path,
    filenames: tuple[str, ...],
) -> None:
    """Write or exactly compare one scenario's expected snapshot files."""
    scenario = directory.name
    if tuple(files) != filenames:
        raise AssertionError(f"{scenario} snapshot builder produced {tuple(files)}, expected {filenames}")
    if update:
        directory.mkdir(parents=True, exist_ok=True)
        for name, content in files.items():
            (directory / name).write_text(content, encoding="utf-8")
        print(f"smoke-python-runtime: updated snapshots in {directory}")

    existing = {
        path.name
        for path in directory.iterdir()
        if path.is_file()
    } if directory.is_dir() else set()
    expected = set(filenames)
    if existing != expected:
        raise AssertionError(
            f"{scenario} snapshot files differ: "
            f"missing={sorted(expected - existing)}, unexpected={sorted(existing - expected)}"
        )
    for name, actual in files.items():
        expected_text = (directory / name).read_text(encoding="utf-8")
        if actual == expected_text:
            continue
        diff = "".join(difflib.unified_diff(
            expected_text.splitlines(keepends=True),
            actual.splitlines(keepends=True),
            fromfile=f"expected/{name}",
            tofile=f"actual/{name}",
        ))
        raise AssertionError(
            f"{scenario} executable snapshot mismatch in {name}; "
            "rerun with --update-snapshots after reviewing the behavior\n"
            f"{diff}"
        )


if __name__ == "__main__":
    main()
