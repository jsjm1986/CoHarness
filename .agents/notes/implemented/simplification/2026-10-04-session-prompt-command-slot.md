# Agent Note: Remove the unproduced command slot from session.prompt

Status: implemented

English | [中文](2026-10-04-session-prompt-command-slot.zh.md)

## Problem

The published `session.prompt` contract described slash-command dispatch the handler never performs: an orphaned JSDoc block promised registry execution for leading-`/` prompts, the response type and `sessionPromptValueSchema` carried an optional `command` slot, and `command-error`/`unknown-command` sat in the RPC error catalog. No code emits the slot or those codes; the web UI routes commands through `remote.commands.execute` and never reads the slot. The stale surface misleads other API consumers and generated catalogs.

## Decision

Delete the dead surface: the orphaned doc block, the `command` member from the `prompt` response type and its schema, and both error codes from `RpcErrorMap`/`rpcErrorSchema` along with their spec assertions. Slash-command behavior stays where it is implemented — the commands Remote and its `command/run`/`command/done` events; a composer line that matches no command submits as an ordinary user message.

## Files

- `packages/host/apiproxy/src/api/sessions.ts` — orphaned slash-command doc block removed; `prompt` returns `{ accepted: true }`.
- `packages/host/apiproxy/src/api/sessions.schema.ts` — `sessionPromptValueSchema` drops the `command` member.
- `packages/host/apiproxy/src/api/rpc.ts` / `rpc.schema.ts` — `command-error` and `unknown-command` removed from the error catalog.
- `packages/host/apiproxy/tests/rpc-schemas.spec.ts` — domain-catalog assertions for the removed codes dropped.

## Consequences

The wire contract now states only what the handler produces. Error codes that re-enter this domain must name a live producer in the same change; schema members must have an emitter.
