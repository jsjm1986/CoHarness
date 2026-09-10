from __future__ import annotations

import runpy
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[3]
SMOKE = runpy.run_path(ROOT / "scripts" / "smoke-python-runtime.py")


def test_session_v3_snapshot_retains_messages_and_compact_payloads() -> None:
    records = [
        {"type": "system/message", "data": {"message": {
            "role": "system", "id": "system-uuid", "content": [{"type": "text", "text": "prompt"}],
        }}},
        {"type": "assistant/message", "data": {"stream": [
            {"type": "text-chunks", "time0": 42, "dt": [5], "index": 0, "texts": ["a", "b"]},
            {"type": "chunk", "time": 47, "chunk": {"type": "finish", "reason": {"kind": "stop"}}},
        ]}},
    ]
    normalized = SMOKE["normalize_snapshot_value"](records, [])
    assert normalized[0]["data"]["message"] == {
        "role": "system", "id": "{{messageId}}", "content": [{"type": "text", "text": "{{system}}"}],
    }
    assert normalized[1]["data"]["stream"] == [
        {"type": "text-chunks", "time0": 0, "dt": [0], "index": 0, "texts": ["a", "b"]},
        {"type": "chunk", "time": 0, "chunk": {"type": "finish", "reason": {"kind": "stop"}}},
    ]


@pytest.mark.parametrize(
    ("prompt_name", "expected"),
    [
        ("SNAPSHOT_DIRECT_CHILD_PROMPT", "DIRECT_CHILD_OK"),
        ("SNAPSHOT_WORKFLOW_CHILD_PROMPT", "WORKFLOW_CHILD_OK"),
    ],
)
def test_child_prompt_precedes_runtime_context(prompt_name: str, expected: str) -> None:
    chunks = SMOKE["completion_chunks"]({
        "messages": [
            {"role": "user", "content": SMOKE[prompt_name]},
            {"role": "user", "content": "Current runtime context"},
        ],
    })

    assert any(
        choice.get("delta", {}).get("content") == expected
        for chunk in chunks
        for choice in chunk.get("choices", [])
    )


def test_mcp_smoke_requests_the_discovered_tool() -> None:
    chunks = SMOKE["completion_chunks"]({
        "messages": [{"role": "user", "content": SMOKE["MCP_PROMPT"]}],
        "tools": [{"type": "function", "function": {"name": "mcp__fixture__add"}}],
    })

    calls = [
        call
        for chunk in chunks
        for choice in chunk.get("choices", [])
        for call in choice.get("delta", {}).get("tool_calls", [])
    ]
    assert calls[0]["function"] == {
        "name": "mcp__fixture__add",
        "arguments": '{"a": 19, "b": 23}',
    }


def test_mcp_smoke_accepts_the_external_server_result() -> None:
    chunks = SMOKE["completion_chunks"]({
        "messages": [
            {"role": "user", "content": SMOKE["MCP_PROMPT"]},
            {
                "role": "assistant",
                "tool_calls": [{
                    "id": "mcp-add",
                    "type": "function",
                    "function": {"name": "mcp__fixture__add", "arguments": '{}'},
                }],
            },
            {"role": "tool", "tool_call_id": "mcp-add", "content": "42"},
        ],
    })

    assert any(
        choice.get("delta", {}).get("content") == SMOKE["MCP_TEXT"]
        for chunk in chunks
        for choice in chunk.get("choices", [])
    )
