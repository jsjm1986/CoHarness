---
description: "Managed real-file document provider with captured execution authority and streaming Gateway transport"
kind: "package-reference"
---

# @deepseek-ai/dsh-userdoc-gateway

English | [中文](README.zh.md)

## Summary

`userdoc-gateway` provides `ctx.userDocs` through the authenticated Gateway transport. Document references retain ordinary absolute paths below the configured public root, so filesystem and shell tools can edit files directly. The server owns upload sessions, storage limits and metadata; the runtime receives no private storage path.

## Table of Contents

- [Authority and transport](#authority-and-transport)
- [Configuration](#configuration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="authority-and-transport"></a>
## Authority and transport

Each operation captures its current execution before awaiting transport. A captured execution sends only its session and scope references; it never forwards a later browser principal. Outside execution, a live interactive principal is required. Restricted purposes are refused except `document-admin` for trash, restore and purge. The server must independently authorize every reference and current participant. Upload owner arguments assert the authenticated owner; they cannot select another owner or root.

The private POST endpoint `/internal/runtime/documents/store` carries a bounded length-prefixed JSON envelope followed by raw file bytes. Uploads and reads stream without fitting file bytes into the metadata budget. Directory and trash pages are computed on the server. Strict parsers reject unknown operations, fields and error codes; returned paths must match the runtime's independently configured root.

Pending admission remains held through response consumption or explicit `openRead` handoff. Disposal refuses new calls, aborts accepted RPCs and waits for their cleanup. Handed-off read streams belong to their consumer. Failed cancellation retains its cause, closes further admission and makes disposal fail. `read` remains owned until its bytes settle.

<a id="configuration"></a>
## Configuration

| Key | Default | Meaning |
|---|---|---|
| `documentRoot` | `~/documents` | Independently expected absolute public root after home expansion |
| `maxMetadataBytes` | `4194304` | Maximum encoded envelope bytes, excluding the four-byte prefix and file bytes |
| `requestTimeoutMs` | `60000` | Deadline through metadata completion or streaming-read handoff |
| `maxPendingRequests` | `64` | Maximum accepted requests before consumption or handoff |

The server adapter exported by `/server` requires runtime authentication before reading the request, a lifetime signal, and an authorization owner covering backend selection through response delivery. Its `finish` callback settles required catalog or durable delivery effects before acknowledgement. It does not authenticate a runtime token itself. After a refusal response settles, it closes an unfinished request rather than waiting for the sender to reach EOF. Backend and response-source cleanup failures remain separately observable. The managed Gateway subscribes content reads, one-shot saves and chunk bodies to live account, project and captured-participant revocations. It keeps that subscription through input cancellation and source/response cleanup; bytes already delivered remain delivered. A missing access monitor refuses backend assembly, and monitor loss prevents new admission and cancels active transfers.

<a id="model-experience"></a>
## Model Experience

### Document references

#### What the model sees

The existing document consumers render each file's absolute `path` and the server's limits. The provider adds no tools or prompt sections.

#### Token effect

None directly; each consuming tool or prompt section owns its rendered content.

#### KV Cache effect

None; the provider adds no model-visible request prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Managed Web runtimes select this provider from their immutable inherited Gateway credential-channel markers before plugins mount. They wait for `gatewayRuntime` and `executionAuthority` without activating local storage. Standalone compositions use their local provider; project and user environment files cannot select managed storage. Production process isolation requires Linux runtime accounts and the deployment mount policy. Local-launcher deployments share their host account and cannot establish process isolation between users or projects.

<a id="dev-note"></a>
### Dev Note

The [incarnation and storage design](../../../.agents/notes/proposed/architecture/2026-10-25-document-incarnations-and-trash-actions.md) records identity, recovery and deployment-isolation requirements.
