# MCP — Model Context Protocol

English | [中文](README.zh.md)

Packages bridging the harness to the MCP ecosystem.

| Package | Role |
|---|---|
| [`mcp-client/`](mcp-client/README.md) | MCP client bridge that registers external server tools on `ctx.tools` |

The [MCP subsystem page](../../docs/subsystems/mcp.md) owns the client bridge and on-demand resource contracts.


## Summary

The `mcp/` group lets the model call external Model Context Protocol (MCP) tools and read server resources. Configure only `mcp-client` entries; shipped profiles already mount `mcp-resources` once. MCP tools and prompt text appear only for callers with a configured server in scope. Connections also supply server instructions. Package READMEs own configuration and limitations.
