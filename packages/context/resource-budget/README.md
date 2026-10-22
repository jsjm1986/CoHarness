---
description: "Execution resource admission and quiescent-release obligations for model requests and managed processes."
kind: "package-reference"
---

# @deepseek-ai/dsh-resource-budget

English | [中文](README.zh.md)

## Summary

Use this definition when an execution consumer must reserve model or process capacity before starting work. A concrete provider supplies admission and scheduling; this package supplies no scheduler or deployment quotas. Consumers keep a reservation until execution has stopped, including when cancellation or transport failure leaves cleanup uncertain.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Consumers import the Service Definition from the package root and request types from `@deepseek-ai/dsh-resource-budget/types`. A composition needs a concrete `ResourceBudget` provider; mounting this abstract definition does not implement admission. The definition has no configuration fields.

Reserve capacity before starting the resource. Successful cancellation alone does not prove that a process, model request, or its cleanup has stopped. Release only after proving quiescence; report uncertain cleanup while the reservation remains occupied. Provider acknowledgement owns the final accounting decision.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

[`src/index.ts`](src/index.ts) declares `ctx.resourceBudget`; [`src/types.ts`](src/types.ts) declares caller metadata and release obligations. Verified actor and project attribution belongs to the concrete provider, rather than caller-supplied identity fields. The [subsystem reference](../../../docs/subsystems/resource-budget.md) owns the types and generated service API.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Resource admission reference](../../../docs/subsystems/resource-budget.md) — resource kinds and reservation lifetime.
- [Execution Authority](../execution-authority/README.md) — verified execution identities and permissions.
- [Gateway](../../../gateway/README.md) — managed deployment and node configuration.

-----

<a id="model-experience"></a>
## Model Experience

None, as the definition contributes no prompt, tool schema, or model-visible result.

#### KV Cache effect

None; resource admission does not construct model request content.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- A concrete provider and execution consumers must implement scheduling and reservation ownership; importing this package does not enforce capacity limits.
- The declared resource kinds cover models and processes. Worker threads have no separate resource kind.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
