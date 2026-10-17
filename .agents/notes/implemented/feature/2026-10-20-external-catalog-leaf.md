# Agent Note: external executions recorded as parent-catalog leaves

Status: implemented

English | [中文](2026-10-20-external-catalog-leaf.zh.md)

## Problem

Upstream #4394 widened the parent-owned subagent catalog to versioned leaves: v0 local modes, v1 `unknown` children from synchronized catalogs, and v2 `external` executions without a local child Session. This fork cataloged only runs exposing `localAgent`, so external-provider work (ACP, SDK) was invisible to descendant discovery.

## Decision

`subagent/catalog` accepts the three versions upstream defines — v0 one-shot/continuable, v1 adding `unknown`, v2 `external` — and `establishExternalCatalogChild(parent, childId, label)` records a provider-minted identity for runs without a local Session. `start()` now catalogs every returned run: local children through `establishCatalogChild`, external runs through the v2 leaf. `SubagentCatalogEntry` exposes `unknown`/`external` modes as leaf rows; the format validator admits v2 external and rejects mismatched version/mode pairs. The projection fold moved to `stateVersion: 3` because widened acceptance changes fold output for logs containing newer facts.

Upstream's `delivery: 'parent' | 'caller'` spec field maps onto existing fork structure rather than a new request member: `start()` is the caller-delivery surface (the caller awaits `run.result` and mediates model notification through its tool result), while continuation and `sendMessage` paths carry parent delivery.

## Alternatives considered

Skipping external leaves kept remote runs invisible to `listChildren`/`listDescendants` and diverged the wire view from upstream. Adding an explicit `delivery` request field would restate a distinction the fork's API surface already encodes.

## Consequences

Parent catalogs enumerate remote executions beside local children; entries mint no local Session facts, so readers must not assume a resumable child. `SubagentCatalogEntry.mode` gained two values — consumers switching on mode must handle or ignore the leaves explicitly.

## Verification

`catalog.spec` folds v0/v1/v2 facts into ordered leaf rows and rejects mismatched version/mode payloads; `service.spec` exercises the external write through `start()` with a mocked provider.
