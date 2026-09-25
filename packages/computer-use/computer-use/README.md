---
description: "Computer-use provider registration for deployments that enable one desktop driver at a time."
kind: "package-reference"
---

# @deepseek-ai/dsh-computer-use

English | [中文](README.zh.md)

## Summary

A deployment can enable one computer-use provider at a time. Loading another provider fails with the registered provider name. Each provider supplies its own tools and desktop operations. This package adds no model-visible tools and does not coordinate concurrent Sessions.

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

Mount the service once beside the chosen provider in a Cordis composition:

```yaml
- name: '@deepseek-ai/dsh-computer-use'
```

The service has no configuration. Provider plugins inject `computerUse` and call `ctx.computerUse.register(ComputerUseProviderName(name))`; the brand is exported from `@deepseek-ai/dsh-computer-use/brand`. The returned effect disposer releases that registration.

Providers stop admitting tool calls, close their resources, and await owned work before releasing the registration. `ctx.computerUse.providerName` reports the registered name until release.

Providers wrap actual desktop effects in `ctx.computerUse.run(execution, operation)`. Independent local callers retain the host operator's authority. Managed runtimes require a live Agent and a `computerUseAuthorization` provider; losing that provider never restores local access. The deployment policy owns qualification, Session confirmation and leases. Its cancellation reaches the driver, and revoked results are rejected after the driver settles.

The optional `computerUseAuthorization.confirmation` controller reads and changes the interactive user's confirmation. It requires a live human request and an exact root, node and desktop; it is not a model tool. Browser consumers import the wire value from `/types`, which does not load Host service declarations.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

One private name owns the slot. Cordis effects remove contributions when their plugin unloads; a repeated disposer cannot remove a later registration. The [source](src/index.ts) keeps driver schemas outside the service and delegates managed effects to the deployment policy.

No runtime invariant companion is published: the registry has one authoritative field and exposes no independently maintained observation that can diverge. Duplicate rejection and plugin disposal are covered by the owning tests.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Computer use](../../../docs/subsystems/computer-use.md) — provider selection and shared-desktop limits.
- [Cua Driver MCP provider](../../experimental/computer-use-cua-driver-mcp/README.md) — use an installed driver.
- [Cua Driver native provider](../../experimental/computer-use-cua-driver-native/README.md) — use the npm runtime.

-----

<a id="model-experience"></a>
## Model Experience

None, as this service registers no model-facing tools or prompt sections and providers own result rendering.

#### KV Cache effect

Registration does not alter model requests. Provider-owned tools and guidance determine their own request-prefix effects.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

The service limits registrations within its Cordis service instance.

- **Shared desktop** — concurrent Sessions and separate DSH processes can operate the same desktop; callers coordinate whole computer-use workflows.
- **Provider selection** — configuration selects the provider; the model cannot switch registered drivers at runtime.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
