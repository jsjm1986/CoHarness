---
description: "Verified execution participants for managed input, delegation, restoration, and privileged operations. Read this when adding a transport or consumer that must retain human authorization."
kind: "package-reference"
---

# @deepseek-ai/dsh-execution-authority

English | [中文](README.zh.md)

## Summary

Carry verified human input identities through a Session and its delegated work, then check current permissions before execution. Input references preserve who contributed to the work; they do not grant permission. Consumers use the same service for live input, restored work, and privileged operations, without depending on Gateway transport details.

## Table of Contents

- [Use this package](#use-this-package)
- [Runtime contract](#runtime-contract)
- [Invariants](#invariants)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>
## Use this package

Import the Service Definition in input and execution consumers; compose [Gateway Execution](../gateway-execution/README.md) as its managed provider. The definition has no configuration and does not supply authorization by itself. Independent local profiles do not compose the Gateway provider.

`executionAuthorityOf(ctx)` returns the available provider. When the owning application declares `executionAuthorityRequired`, absence throws `execution/forbidden`; consumers cannot interpret a missing managed provider as local access.

<a id="runtime-contract"></a>
## Runtime contract

Input transports use `stamp` for an exact human message and `answer` for a claimed pending-question answer. Display participant fields and browser-supplied roles cannot establish execution identity. A provider retains earlier editors when an input is replaced.

Delegation captures the actual initiating Agent before asynchronous creation. `captureSession` reads a live or cold source's complete authority for an explicit fork, independently of the selected transcript prefix. `inherit` records restrictions in the child's own log; `relay` retains the sender's restrictions through an adjacent delivery and its retries. The transport still owns Session access checks and question identity validation.

`authorize` checks the executing Agent and current permissions for the requested capability. `authorizeSelection` checks an explicit privileged preset selection before commit. A captured scope, persisted event, or ordinary tool approval never substitutes for either check. Cancellation remains owned by the operation and is passed to asynchronous authorization and delivery.

The required-on-read `gateway/execution` event preserves accepted participant facts and delegation restrictions. Readers that do not understand it must reject the log rather than omit its restrictions. Generation metadata can carry the verified input references and one primary billing actor; [Auto review attribution](../../../.agents/notes/implemented/bug-fix/2026-09-22-auto-review-execution-attribution.md) owns their billing use.

<a id="invariants"></a>
## Invariants

No invariant companion is published because this package defines the service and durable types but owns no independently changing state. Providers own current authorization and validate persisted input references.

<a id="further-exploration"></a>
## Further Exploration

- [Verified execution participants](../../../.agents/notes/implemented/architecture/2026-09-22-verified-execution-participants.md) — identity, delegation, and permission-intersection decisions.
- [Gateway Runtime](../gateway-runtime/README.md) — signed request identity and private transport.
- [Agent initiator scope](../../../.agents/notes/implemented/architecture/2026-07-15-agent-initiator-scope.md) — recovering the actual Agent at an orchestration entry.

<a id="model-experience"></a>
## Model Experience

None, as the Service Definition adds no prompt, tool schema, or model-visible result.

#### KV Cache effect

None; identity references and service calls do not alter model request content.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Consumers must use the real operation owner and the explicit service methods; importing the types does not authenticate a caller or delegate permissions.
- Captured inheritance is restrictive input to provider verification, not a transferable credential or permission grant.
- The interface does not confine Host code at the operating-system level. Deployment isolation remains independently required.
