---
description: "Resource permit obligations for node-wide execution admission providers and consumers."
kind: "package-reference"
---

# @deepseek-ai/dsh-resource-budget

English | [中文](README.zh.md)

## Summary

Request a permit before starting a model request or process, and retain its accounting until execution has stopped. This package declares the service interface; a composed provider must supply admission. The managed Gateway composition supplies the provider; LLM adapter dispatch, registered native Messages search and subprocess allocation consume its permits.

## Table of Contents

- [Permit ownership](#permit-ownership)
- [Remote coordination](#remote-coordination)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="permit-ownership"></a>
## Permit ownership

The abstract `ResourceBudget` service exposes `acquire(request)`. A request identifies `model` or `process`, with optional cancellation and an executing Session id. Providers resolve the verified actor and project rather than accepting those identities from consumers.

Compositions mount a concrete provider; mounting this abstract definition fails during construction.

Providers allocate a separate `ResourceOperationId` for each operation and retain it across retries. An ordered registration sequence alone cannot distinguish a retry from a different operation after provider replacement.

A consumer awaits admission, observes the lease cancellation `signal`, and awaits `release()` after proven quiescence or `uncertain()` after unconfirmed cleanup. Uncertainty retains accounting and the lease’s caller/provider cancellation links, allowing a later exact completion. Requests select captured execution, a signed interactive caller, or Runtime infrastructure through `origin`; this metadata never enters model input. Deployment limits and scheduling belong to the provider.

<a id="remote-coordination"></a>
## Remote coordination

The `./wire` entry validates operation references, origins, resource states, completion reports, and the committed node policy. UUIDs are canonicalized before comparison. Requests contain a Session/scope reference, a signed principal, or an explicit Runtime infrastructure origin; actor and project numbers are forbidden. Polls contain at most 512 exact operation references, and HTTP messages fit 64 KiB.

The Gateway implements authenticated registration, request, status-batch, and completion endpoints under `/internal/runtime/resources/`. Registration returns the committed policy without clearing earlier work. Only the exact completion endpoint accepts the current bearer after account revocation or while its Runtime stops; other endpoints retain ordinary Runtime authentication. A supervisor-confirmed process-range stop reclaims only the handle's captured generation, even when the instance row has advanced. Status reads recheck the stored origin against current permissions before queued dispatch; scoped Sessions cannot omit their execution scope. The [Gateway provider](../gateway-runtime/README.md#resource-admission) owns Runtime registration and transport.

<a id="model-experience"></a>
## Model Experience

### Resource permits

#### What the model sees

None. The `ResourceBudget` interface declares no prompt section, tool schema, or model-visible result.

#### Token effect

None. Permit requests contain execution metadata rather than model input.

#### KV Cache effect

None. Service calls do not alter model request content.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Admission covers actual LLM dispatch and the subprocess service. Direct worker or process allocation outside those services requires its own consumer; importing this definition cannot govern it.
- Managed Runtime process limits are a separate implemented mechanism; see [Runtime admission](../../../gateway/README.md#performance-and-runtime-admission).

<a id="dev-note"></a>
### Dev Note

None.
