# Agent Note: OAR one-shot subagent lane absorption

Status: implemented

English | [中文](2026-11-15-subagent-oar-absorption.zh.md)

## Problem

Upstream v0.2.2-rc.3 ships the OAR-based one-shot external-subagent lane:
`experimental/subagent-oar` registers named providers backed by the
`@botiverse/oar` runtime registry, and `experimental/tool-subagent-oar`
exposes the `subagent_oar` tool that selects one configured provider per
call. The fork's subagent service has no `startActivation` surface: it
publishes one-shot runs through `ctx.subagents.start`, records external
children through `establishExternalCatalogChild`, and delivers terminal
results through the `ctx.jobs` background-job seam. Upstream activation
semantics — committed sibling names, the activation manager's settlement
and parent delivery — therefore needed a deliberate port, not a copy.

## Decision

- Carry both packages as adapted. `subagent-oar` source lands verbatim:
  the local `out-of-process.ts` helpers it uses (`NO_START_CAPABILITIES`,
  `assertPositiveFinite`, `assertUsableCwd`, `settleRunResult`,
  `subprocessRunHandle`) share lineage with upstream, so only the
  `descriptor` field the local `ResolvedSubagentStartRequest` requires is
  added at test call sites.
- Port `tool-subagent-oar` to the local seam: the tool reserves a sibling
  name tool-locally, awaits `ctx.subagents.start` as the publication
  boundary (the catalog fact lands inside `start`, matching upstream's
  name-commit ordering), then registers the published run as a `subagent`
  job owned by the caller. The job owns termination and terminal
  recording; `dsh-tool-jobs` delivers the settlement notice and
  `job_output` returns the final answer. Failed cleanup inside settlement
  is handed back through `ctx.subagents.retainFailedCleanup` for the same
  parent's retry.
- Reserve names in the tool because the local parent catalog records no
  committed-name field: claims cover only names this tool gave that
  parent, documented as a limitation. The `agent-N` default sequence the
  model sees is unchanged.
- Port `packages/subagent/subagent/tests/external-activation-helpers.ts`
  from upstream: `startActivation` becomes `ctx.subagents.start`, the
  return type becomes `SubagentRun`, and the `Agent` stub drops the
  upstream-only `model` field and `unsupportedModel` import.
- Pin `@earendil-works/pi-ai` and `pi-coding-agent` to `1.3.0` and
  scope-override OAR's transitive pi dependencies, so the carried
  `pi-ai@1.3.0` patch (streaming tool-call parse fix, Gemini thought
  signature) actually applies; a floating `^1.3.0` resolves to 1.5.2 and
  silently drops it. `@botiverse/oar@0.67.0` stays a devDependency —
  `tsdown.config.ts` bundles it into `lib/index.js`, so the packed
  artifact carries the patched runtime with no resolvable external OAR.
- Both upstream patches are registered in `pnpm-workspace.yaml`
  (`patchedDependencies`, `minimumReleaseAgeExclude`). The fork's
  `dsh-llm-pi-ai` stays on patched `1.1.0`; the two versions coexist
  under different patch hashes.

## Consequences

- Codex and Claude Code one-shot delegation is reachable through the
  `subagent_oar` tool in experimental compositions; OAR's other default
  runtimes can be selected but carry only upstream's coverage.
- Parent-facing delivery is the jobs seam: the model reads the answer
  through `job_output`, and a composition without `ctx.jobs` fails at
  call time — the tool README documents the requirement.
- Sibling-name uniqueness holds only among children this tool started for
  the same parent; names committed by other delegation paths are not
  checked.
- `experimental/subagent-oar` pins pi packages at 1.3.0 while
  `dsh-llm-pi-ai` remains on `^1.1.0`; upgrading the release package's pi
  floor is a separate decision.

## Alternatives considered

- Porting upstream's `startActivation` manager was rejected: the run
  lease plus job settlement is the local equivalent, and duplicating an
  activation layer would create a second owner for the same lifecycle
  invariants the service already enforces.
- Adding a committed-name field to the parent catalog was rejected: the
  name is a display alias the catalog does not consume, and the schema
  version churn outweighs a tool-local claim for this lane's scope.
- Accepting `pi-ai@1.5.2` unpatched was rejected: whether the streaming
  fixes landed upstream is unverified, and the qualified 1.3.0-plus-patch
  combination is what upstream tested against OAR 0.67.0.

## Verification

- `npx tsc -b packages/experimental/subagent-oar packages/experimental/tool-subagent-oar` — clean.
- `npx vitest run packages/experimental/subagent-oar packages/experimental/tool-subagent-oar` — 38 unit tests pass (31 provider, 7 tool).
- `npx vitest run --config vitest.e2e.config.ts packages/experimental/subagent-oar` — 5 pass (native startup cleanup, environment scrub, Loader composition), 6 skip by design (`DSH_OAR_E2E` and `DSH_OAR_NATIVE_PERMISSIONS` gates, packed-artifact without a built `lib/`).
- `npx oxlint packages/experimental/subagent-oar packages/experimental/tool-subagent-oar` — clean.
- `npx tsx scripts/verify-export-jsdoc.ts`, `verify-translation-pairing`, `verify-upstream-sovereignty`, and `verify-agent-note-format` — clean.
