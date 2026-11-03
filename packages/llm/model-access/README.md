---
description: "Model-route authorization Service Definition for DeepSeek Harness"
kind: "package-reference"
---

# @deepseek-ai/dsh-model-access

English | [中文](README.zh.md)

Service Definition for deployment-owned authorization of exact `(provider, model)` routes. `ModelAccessService` is the runtime face published as `ctx.modelAccess`; implementations may be plain objects. `ModelAccessPolicy` is an optional Cordis `Service` base for in-tree providers. Consumers use the same decision for catalogs, model selection, and execution. Absence of the service means no model authorization policy is mounted.


Managed runtimes publish `modelAccessRequired` on their root lifetime. Model calls capture the installed policy owner before asynchronous middleware, refuse owner withdrawal or replacement across waits, and enforce its route decision after dispatch guards. An absent required provider fails with `MODEL_POLICY_UNAVAILABLE`; standalone compositions may omit the policy.

## Summary

Use `dsh-model-access` as the Service Definition for deployment-owned authorization of exact `(provider, model)` routes: catalogs, model selection, and execution consult the same `ctx.modelAccess` decision, and an absent service means no authorization policy is mounted.

## Table of Contents

- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="model-experience"></a>
## Model Experience

None, as the authorization seam permits or rejects routes but contributes no model input.

#### KV Cache effect

None; the package never assembles or sends provider requests.

## Known Limitations and Deferred Work

- **No policy storage** — deployments must mount a provider that owns policy persistence and refresh semantics.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
