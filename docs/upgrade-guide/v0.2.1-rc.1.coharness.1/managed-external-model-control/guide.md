---
kind: upgrade-guide
description: "Managed external inference requires per-request parent control and a supported model route."
---

# External subagents in managed runtimes

English | [中文](guide.zh.md)

## Change

Opaque Claude Code and ACP execution return `UNSUPPORTED_CAPABILITY` when parent model authorization or resource admission applies. Local and SSH one-shot Codex and persistent members use a registered initiating-Agent Responses adapter for each native request. Its upstream credentials remain in the parent; native WebSocket inference and internal request retries are disabled. Independent compositions retain native authentication. Malformed request JSON remains `400 INVALID_REQUEST`; unexpected parent failures use `502 SERVER`. A failed required Session flush stops inference before upstream dispatch.

ACP and Claude Code member routes are orchestrations. Unsupported governed turns refuse before model admission; an exhausted model budget cannot delay refusal. Missing required model policy remains `MODEL_POLICY_UNAVAILABLE`.

Codex model requests add required `subagent/codex-model-request` events. Readers that do not know this event refuse the log. Committed Session generations remain immutable; this event does not change the structural format version or provide downgrade support.

## Migration

1. For Codex, configure [`modelProvider` and `model`](../../../../packages/subagent/subagent-codex/README.md#configuration) to name a registered parent `openai-responses` route. Managed runs can inherit the parent’s selected route when it supports this operation. Keep upstream credentials on the parent provider; remove explicit child API keys.
2. For SSH Codex, deploy `remoteCommand` on the Session’s target and permit remote TCP forwarding with the requested loopback binding (`GatewayPorts no` or `clientspecified`). Use that Agent’s standing SSH connection; missing connections or failed forwarding refuse startup. Upgrade SSH and Codex providers together. Custom `PresetMount` records supply their actual standing `environment` fiber.
3. Replace unsupported Claude Code or ACP providers with an in-process or [managed SDK provider](../../../../packages/subagent/subagent-dsh-sdk/README.md). Changing providers does not transfer native conversation history.
4. Run a delegated task with two native model requests. Confirm separate parent permits and usage under the initiating Session, and verify that revocation during the second queue wait prevents its upstream HTTP. Keep required authorization and resource services enabled.
5. Create new persistent members for legacy bindings without a captured model selection. Keep old native histories intact; never assign them a new upstream authority. New members retain the selected upstream across parent setting changes and cold resumes. Their outer orchestration is not an additional model request. Verify nested delegation through the same provider instance: omitted model settings inherit the member’s saved upstream.
6. Subscribe conversation checkpoint, replay and title observers to `llm/orchestration` as well as `llm/stream`. Keep authorization and model metering on physical model requests; an external turn is not an additional inference.
7. Use a reader that knows the new event for Sessions containing managed Codex inference; preserve every committed generation.

8. Set `modelRequestTimeoutMs` for receiving native HTTP bodies. Verify an incomplete authenticated upload returns `504 TIMEOUT`, creates no model request event or permit, and leaves capacity for the next complete request.
