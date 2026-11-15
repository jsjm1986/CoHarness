# Agent Note: Tools describe exposes executor transport tools

Status: implemented

English | [中文](2026-11-16-tools-describe-executor-transport-surface.zh.md)

## Problem

Upstream rc.3 moved the PTC `run_code` tool out of the registration layer into the selected executor's transport surface. `ctx.tools.schemas(scope)` then returned only registered definitions: in PTC mode the inspection provider listed registered nested tools while omitting the one tool a caller can actually invoke, and the system prompt reached the executor through a private `describe` path no other consumer could share. Any consumer that needed the complete model-facing surface had to re-derive the same union.

## Decision

- `ToolsService.describe(scope?, toolSet?)` is now public and is the single source of the model-facing tool view: it selects the executor for the scope, returns its `ToolModelInput`, and fills `knownNames` from the visible registration layer when the executor omits it. The system-prompt integration calls this method instead of an inline closure.
- The `Tool` Cordis Inspector provider unions `ctx.tools.schemas(agent)` with `ctx.tools.describe(agent).schemas`, de-duplicates by tool name, and swallows only `ToolExecutorUnavailableError` so a composition without an executor still lists registered tools.

## Consequences

- In PTC mode `cordis_inspect_query`/`cordis_inspect_list` show `run_code` alongside registered tools without pretending it is a registered definition.
- Public API surface grows by one method; the generated Cordis API catalog and subsystem docs carry its signature.

## Alternatives considered

- Registering `run_code` as a normal tool — rejected: the executor owns the transport tool; a fake registration would create a second, bypassable call path.
- Leaving the union inside the Inspector provider — rejected: every future consumer would duplicate the same merge against the private describe path.

## Verification

- `packages/core/tools/tests/tools.spec.ts`: three cases cover the merged view, executor transport schema exposure outside the registration layer, and the no-executor error.
- `apps/cli/tests/profiles/headless/tests/ptc.e2e.ts` passes: PTC inspection reports `run_code` plus the cordis tools.
- `pnpm run test:snapshot` 379/380 green after refreshing the `cordis-inspect-jsdoc` fixture, whose reviewed diff contains only the new `describe` signature.
