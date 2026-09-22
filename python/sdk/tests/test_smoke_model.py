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
        event.get("delta", {}).get("text") == expected
        for event in chunks
        if event.get("type") == "content_block_delta"
    )


def test_mcp_smoke_requests_the_discovered_tool() -> None:
    chunks = SMOKE["completion_chunks"]({
        "messages": [{"role": "user", "content": SMOKE["MCP_PROMPT"]}],
        "tools": [{"name": "mcp__fixture__add", "input_schema": {"type": "object"}}],
    })

    uses = [
        event["content_block"]
        for event in chunks
        if event.get("type") == "content_block_start"
        and isinstance(event.get("content_block"), dict)
        and event["content_block"].get("type") == "tool_use"
    ]
    partials = [
        event["delta"]["partial_json"]
        for event in chunks
        if event.get("type") == "content_block_delta"
        and isinstance(event.get("delta"), dict)
        and isinstance(event["delta"].get("partial_json"), str)
    ]
    assert uses[0]["name"] == "mcp__fixture__add"
    assert partials == ['{"a": 19, "b": 23}']


def test_mcp_smoke_accepts_the_external_server_result() -> None:
    chunks = SMOKE["completion_chunks"]({
        "messages": [
            {"role": "user", "content": SMOKE["MCP_PROMPT"]},
            {
                "role": "assistant",
                "content": [{
                    "type": "tool_use",
                    "id": "mcp-add",
                    "name": "mcp__fixture__add",
                    "input": {},
                }],
            },
            {"role": "user", "content": [{
                "type": "tool_result",
                "tool_use_id": "mcp-add",
                "content": "42",
            }]},
        ],
    })

    assert any(
        event.get("delta", {}).get("text") == SMOKE["MCP_TEXT"]
        for event in chunks
        if event.get("type") == "content_block_delta"
    )
