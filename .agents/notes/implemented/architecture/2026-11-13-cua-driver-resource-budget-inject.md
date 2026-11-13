# Agent Note: Order the managed Cua Driver behind resource admission

Status: implemented

English | [中文](2026-11-13-cua-driver-resource-budget-inject.zh.md)

## Problem

On a desktop-enabled node every managed runtime mounted `computer-use-cua-driver-mcp`, and every managed runtime failed the same way: the driver's managed stdio transport spawned its MCP child through `subprocess`, `resourceBudgetOf` read `ctx.get('resourceBudget')` before the `gateway-resource-budget` provider finished its asynchronous `Service.init` — a POST to `/internal/runtime/resources/register` — and Cordis returns `undefined` for a provider whose fiber is not ACTIVE. Because `gateway-runtime` publishes `resourceBudgetRequired`, the lookup threw `ResourceAdmissionError: Managed execution requires its resource admission provider`, the driver's `apply` rejected, Cordis rolled the provider back, and `desktop.status` reported unavailable for the whole generation. The order was deterministic, not a race: the plugin declared `inject = ['computerUse', 'tools']` only, so nothing deferred its activation until admission existed.

## Decision

[managedDesktopPatch](../../../../gateway/src/launch-stamp.ts) now emits `inject: [resourceBudget]` on the `computer-use-cua-driver-mcp` entry. Entry-level inject merges with the plugin's own `inject` export through `Inject.resolve`, so the entry activates only after `resourceBudget` is ACTIVE — meaning its register POST already completed — and the transport's first spawn finds a live provider. The declaration lives in the Gateway-managed patch rather than the package's `inject` export: the provider is mandatory only in managed compositions, so standalone compositions that legitimately omit `resourceBudget` keep the plugin's old activation contract. `gateway-resource-budget` is always present in the same generated patch, so the new edge cannot dangle.

## Alternatives considered

- **Add `resourceBudget` to the package's `inject` export.** The package also runs in compositions with no budget provider, where that edge would stall activation forever; the Gateway patch is the only place that knows admission is mandatory.
- **Delay inside `ManagedStdioTransport`.** Retrying `ctx.get` re-implements inject ordering inside a consumer and still guesses at provider readiness; declaring the dependency is what the injection mechanism exists for.
- **Inject `gateway-resource-budget`'s plugin id instead.** Injections name services, not plugins; the service key is the stable contract other providers could also satisfy.

## Consequences

With admission ACTIVE first, the first spawn acquires a real lease instead of failing closed, and provider rollback no longer removes computer use for the generation. Environments where admission cannot initialize — for example the register POST itself failing — now leave the driver unactivated instead of failing inside spawn; the runtime log shows the pending entry rather than a rolled-back provider. The fix was exercised in production: the same runtime that logged `ResourceAdmissionError: Managed execution requires its resource admission provider` on every start advanced to the resource queue (visible as `Resource admission expired` under full node capacity) once the inject landed.

## Verification

[instances.spec.ts](../../../../gateway/tests/instances.spec.ts) asserts the generated `cordis.patch.yml` carries `inject: [resourceBudget]` on the driver entry, preserving the command/args override stanzas beside it. Live confirmation came from a managed runtime restart on the production node: the patched entry waited for admission and reached its registration path.
