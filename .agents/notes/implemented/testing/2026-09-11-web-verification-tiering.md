# Agent Note: Tiered web browser verification by changed-path impact

Status: implemented

English | [中文](2026-09-11-web-verification-tiering.zh.md)

## Problem

The [required web browser gate](2026-07-30-web-browser-snapshot-ci-gate.md) ran the complete `apps/web/tests` inventory inside the PR consumer aggregate whenever any browser-rendered package changed, and ran no browser work otherwise. A one-plugin UI change paid the full inventory, and no tier existed between "no browser" and "all ~94 scenarios", so there was no way to ask CI for "the affected business area plus stable boot checks".

## Decision

`scripts/web-test-policy.json` (version 1) classifies the browser surface into eight business groups: shell, conversation, workbench, documents, settings, subagent, mobile, and lifecycle. `scenarios` keys are paths relative to `apps/web/tests/` — every `*.e2e.ts` and `*.snapshot.ts` file discovered recursively outside `snapshots/` maps to exactly one group — and browser-rendered packages map to one group, several groups, or `all`; a group list containing `all` is rejected in favour of the bare string. The mappings are enforced as bijections against disk by `scripts/web-test-policy.spec.ts`.

`scripts/ci-pr-scope.ts` extends `snapshot_mode` to `skip | scoped | focused | full`. `scoped` keeps the keyless ACP/CLI snapshots with no browser work; `focused` adds the owning groups of the changed browser packages, scenario files, and referenced goldens, plus an always-on smoke set (vite-entry, shipped-composition, scaffold-hermetic, cold-blank-session, built-boot); `full` adds the complete inventory. Under `apps/web/tests/` a scenario file routes to its group, a committed golden routes to the groups of every scenario the ownership scan attributes to its directory, and inert documentation contributes nothing; a golden directory no scenario references and shared fixtures outside the scenario table fall back to `full`. Full triggers are proved reachability: the web app source, public, and stress trees, client runtime/connection/modules/web (the Loader), `packages/api/`, extensions, Typert, the apiproxy fetch carrier, dependency and lockfile edits, web-lane infrastructure files, and any path outside the classifier's proven-irrelevant categories. An unmapped browser-rendered package falls back to `full`, so a policy gap can never silently skip verification.

The browser lane moved out of `node-24-consumers` into a dedicated `web-verification` pull-request job that always exists under the fixed check name `web verification`, so branch protection can require it; the job writes the selected tier and groups to the step summary. `skip`/`scoped` record the selector's reason and pass; `focused` replays the selected groups with two workers; `full` replays the inventory. The keyless consumer aggregate is identical under `scoped`, `focused`, and `full`, and the master/nightly web-snapshot-sweep workflow still replays the complete inventory after every merge.

`scripts/run-web-snapshots.ts` gained `--focused` with `--groups` (argv) or `DSH_WEB_GROUPS` (env, the CI channel): the selection is the groups' scenarios plus the smoke set, serial owners run first, and the remainder goes to the bounded pool. `pnpm run test:web:focused` and `test:web:full` replace `test:web:ci`, and the `check:ci:web:focused`/`check:ci:web:full` aggregates run the complete `pnpm run build` — web bundle plus the client build record — before the browser run. CI still only ever replays with `DSH_SNAPSHOT=replay`; record and refresh remain explicit local workflows.

## Alternatives considered

**Keep the full inventory on every browser-relevant pull request.** The status quo needs no policy file and no group vocabulary, so it cannot misroute a change. It lost because leaf-plugin edits — the most common UI change — pay the whole inventory for one business area, and the only escape was skipping browser verification entirely.

**Derive focused groups from package directories alone, without a scenario table.** Package-to-group mapping is roughly half the policy's size, and directories are the thing a diff already names. It lost because scenarios, not packages, are what runs: without a scenario table there is no mechanical proof that every scenario is reachable by some selection, and shared UI packages cannot route to the scenario sets that actually exercise them.

**Let each test file declare its own group in source.** Keeping the mapping beside the test removes the separate document, and a moved file carries its group along. It lost because the consumer is the CI scope classifier, which reads a versioned data file without parsing TypeScript sources, and an out-of-band comment rots silently where the policy bijection test fails loudly.

## Testing

`scripts/web-test-policy.spec.ts` pins the policy document: the scenario bijection against recursive discovery under `apps/web/tests/`, golden-directory ownership (every golden has a referencing scenario and every attributed owner sits in the scenario table), non-empty groups, smoke membership in every focused selection, and loader validation failures. `scripts/ci-pr-scope.spec.ts` pins the tier selection, including scenario and golden routing, the full triggers, and the browser-irrelevant categories. `scripts/ci-workflow.spec.ts` pins the workflow shape: the fixed check name, the keyless consumer step, the mode-branched `web-verification` steps, and the aggregate verdict dependency. `scripts/run-gates.spec.ts` pins the web aggregates to a single complete build before the browser gate.

## Consequences

This partially supersedes [the required browser CI gate note](2026-07-30-web-browser-snapshot-ci-gate.md): its replay-only rule, worker isolation, and serial-owner rationale remain authoritative; its placement of the full browser suite inside the consumer job is replaced by the tiered lane. Shared surfaces (`ui-primitives`, `ui-renderer`, `ui-layout`, `ui-slots`, `ui-theme`, `locale`) map to `all`, which selects the whole inventory — focused is a routing decision, not a size discount. Shared packages whose slots several groups' scenarios exercise (`ui-commands`, `ui-collaboration`, `ui-deliverables`, `ui-sidebar`, `ui-open-in-app`, `ui-trajectory`, `ui-workspace`) map to every such group rather than `all`. Adding a scenario requires a policy entry or the bijection test fails, and a new browser-rendered package without a mapping escalates to `full` rather than skipping verification.
