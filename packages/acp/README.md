# acp/ — Agent Client Protocol automation

English | [中文](README.zh.md)

The ACP group exposes harness agents to programmatic clients over the Agent Client Protocol. It is an interoperability transport, not a presentation or human-interaction layer; the matching out-of-process subagent *client* lives in [`subagent/subagent-acp`](../subagent/subagent-acp/README.md) because it implements the subagent provider interface.

| Package | Role |
|---|---|
| [`acp/`](acp/README.md) | Automation-only ACP server. |

The server contract is documented in [`acp/README.md`](acp/README.md).


## Summary

The acp group provides one package: a server that lets programs and automation run persistent DeepSeek Harness agents over the standard Agent Client Protocol. A client can create, list, resume, and close sessions; attach standard MCP servers; select model options; send text and image prompts; receive semantic updates; answer permission prompts; and cancel work without a human in the loop. The matching client for spawning such a server from another harness lives in `subagent/subagent-acp`. This page maps the group; the package README owns the per-package contract.
