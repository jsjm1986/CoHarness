# @deepseek-ai/dsh-model-access

English | [中文](README.zh.md)

Service Definition for deployment-owned authorization of exact `(provider, model)` routes. `ModelAccessService` is the runtime face published as `ctx.modelAccess`; implementations may be plain objects. `ModelAccessPolicy` is an optional Cordis `Service` base for in-tree providers. Consumers use the same decision for catalogs, model selection, and execution. Absence of the service means no model authorization policy is mounted.

## Summary

Use `dsh-model-access` as the Service Definition for deployment-owned authorization of exact `(provider, model)` routes: catalogs, model selection, and execution consult the same `ctx.modelAccess` decision, and an absent service means no authorization policy is mounted.

## Invariants

**Runtime invariant:** No companion is published. The definition declares a decision contract whose absence means no policy; providers own any rule state.

## Model Experience

None, as the authorization seam permits or rejects routes but contributes no model input.

#### KV Cache effect

None; the package never assembles or sends provider requests.

## Known Limitations and Deferred Work

- **No policy storage** — deployments must mount a provider that owns policy persistence and refresh semantics.
