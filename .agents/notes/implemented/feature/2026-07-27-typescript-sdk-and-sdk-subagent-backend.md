# Agent Note: TypeScript SDK client and the SDK subagent backend

Status: implemented

English | [中文](2026-07-27-typescript-sdk-and-sdk-subagent-backend.zh.md)

## Problem

The stdio JSON-RPC runtime needs clients in both Python and TypeScript. A subagent backend that launches a complete Harness runtime needs the same framing, request pairing, notification scoping and process cleanup as an ordinary SDK client. Keeping those operations inside the server plugin would make every client depend on an application-serving package.

## Decision

`dsh-sdk-protocol` owns named request/result and notification types plus the line transport. Server and client code share those types; protocol errors retain their wire code and data. Its package root exposes the supported protocol API without source-module imports.

`dsh-sdk-client` owns the TypeScript client layers: `HarnessClient` for protocol operations and `DeepSeekHarness`/`HarnessSession` for owned Session activity. It resolves the same-version `dsh` dependency and launches a named profile with ordered patches and an optional isolated home. Environment objects replace inherited values so callers can enforce credential policy. Client libraries remain independent of Cordis contexts.

`dsh-subagent-dsh-sdk` is a separate Service Provider because its child is a complete Harness runtime, with its own profile, persistence and tools. It reuses the SDK client instead of duplicating that wire. The subagent service resolves the child's effective directory; the parent header remains its origin. Supported route overrides feed initialization, while unsupported parent-enforced composition features remain explicit refusals. The provider's [process owner](../architecture/2026-10-24-sdk-subagent-process-ownership.md) supplies managed admission and joined cleanup without changing the SDK wire.

The subagent seam owns shared out-of-process result settlement and publication. Protocol-specific drivers own their transport, answer extraction and safe diagnostics. An out-of-process child's streamed transcript supplies its result without merging that transcript into the parent conversation.

## Testing

Required evidence covers actual stdio exchanges, owned activity scoping, safe failure facts, cancellation and confirmed process cleanup. Runnable profile compositions verify configured child routes and working directories across a second complete runtime. Keyless SDK scenarios verify notification projection and persisted Session behavior; provider API tests remain separate.

## Alternatives considered

**Import wire types from the server plugin.** Clients would acquire the server's application dependencies despite never serving that application. A protocol library has actual server and client Consumers.

**Implement raw JSON-RPC in each subagent driver.** This duplicates request pairing, subscription scoping, timeout ownership and cleanup.

**Combine SDK and ACP backends with a transport setting.** Their child interfaces, initialization and answer extraction differ; only their result and ownership vocabulary belongs in the shared subagent service.

**Expose internal source modules and notification producers.** Callers need owned client operations, not implementation-specific mutation of subscriptions. Public package roots enumerate supported interfaces.

## Consequences

Both SDK languages project the same runtime protocol while retaining their own host and distribution integrations. The TypeScript subagent Consumer adds no second protocol implementation. Each child still boots a complete plugin tree; a process reservation does not represent all model requests that tree can issue. Runtime policy and resource ownership therefore remain explicit concerns of the composition.
