# Agent Note: Subagent route follows the parent's current session target

Status: implemented

English | [中文](2026-08-22-subagent-current-model-route.zh.md)

## Problem

In-process subagent creation options were copied from `parent.options`, which records the route supplied when the parent Agent was created. A model picker or an `agent/request` contribution can select a different provider/model for a later request, and that selection is recorded in the parent's latest `request/header`. A child created after that switch could therefore use a stale default route and be rejected by model governance, even though the parent was already using an authorized route. Continuable children also persisted the stale route in their descriptor, so a cold resume repeated it.

## Decision

`resolveChildAgentOptions()` reads the latest parent `request/header` provider/model when one exists and falls back to the creation options before the parent has made a request. The parent's `maxTokens` remains creation-scoped. Explicit per-child `agentOptions` override the inherited values.

Continuable starts resolve these options before their first await and use the same detached values for both the durable descriptor and fresh materialization. Cold resume uses the descriptor route, so a parent model change after delegation does not rewrite an existing child.

## Alternatives considered

**Copy `parent.options` for every child.** Rejected because those values are creation-time options, not the current session route.

**Read a live picker registry.** Rejected because it is process-local, entry-point-specific, and not the durable source used by the loop or a resumed child.

**Use the deployment default when the parent route differs.** Rejected because a logged session selection may intentionally name an unlisted or gateway-served route, and governance must evaluate the selected route rather than silently replace it.

**Resolve the route after child creation.** Rejected because the child must have a complete route before its first request, and continuable descriptors must record the exact route used for cold resume.

## Consequences

Spawn, fork, and continuable in-process children follow the parent's latest logged provider/model route while preserving explicit child overrides. A route change after delegation affects only future delegations; it does not mutate an already-created child. Out-of-process providers keep their own deployment-owned route because they run a separate runtime or product process.

The regression is pinned by the in-process inheritance and continuation suites, including the durable descriptor and cold-resume route assertions.
