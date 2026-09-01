# Agent Note: Selective alpha.2 and alpha.3 runtime adaptation

Status: implemented

English | [中文](2026-09-01-alpha23-selective-runtime-adaptation.zh.md)

## Problem

The alpha.2 and alpha.3 releases change several shared client and runtime paths at once. Copying their package layout would replace CoHarness ownership of headless composition, Gateway authorization, input serialization, and the existing conversation façade. Leaving every difference untouched would retain measurable allocation costs and omit directory navigation that the product plan describes.

## Decision

CoHarness adopts the upstream behaviors whose authority can be expressed inside existing extension points. `GoalService` reads the strict `goal` projection when the optional registry is present and keeps its incremental cache for headless compositions; `AgentLoop` publishes a `turnBoundary` host projection and goal-tool authority scans the immutable event cut by index. The projection state records round advancement and the first replay failure without changing the session format.

The `@` source now distinguishes settling a directory from drilling into it. `InputTriggerSource` may publish a header, candidates may advertise `drill`, and the controller routes Tab, the chevron, and breadcrumb picks through one drill action. Drill text is applied through the existing span-CAS input event, then the menu re-tracks; ordinary folder picks remain atomic references. The existing session-reference encoding and mobile composer shell stay unchanged.

Tool rows retain raw argument text and call `formatToolBody` only after an expandable row opens. Chat and Trajectory retain a persistent next-step splice chain and a current claim set; the Chat side registers no unused next-turn classifier. Queue ownership remains in the Host queue projection.

Detailed domain decisions remain owned by [the goal note](../feature/2026-07-19-persisted-same-session-goal-domain.md), [the input-machine note](2026-07-25-web-input-machine-and-slash-pipeline.md), [the inbox lifecycle note](2026-07-31-claimed-pre-step-inbox-lifecycle.md), [the tool-row note](../feature/2026-07-30-web-tool-row-unified-expand-and-inspect.md), and [the dependency-gates note](../process/2026-09-01-alpha23-dependency-gates.md).

The release-wide source matrix and version record are maintained in the [selective upstream integration audit](2026-09-01-selective-upstream-alpha2-alpha3-sync.md).

## Alternatives considered

**Copy the upstream packages wholesale.** Rejected because it would replace CoHarness Gateway/ACL, wire error classes, mobile UI ownership, and headless dependency choices.

**Keep every local implementation and document the differences.** Rejected because the missing drill path contradicts the product behavior, and eager argument formatting adds a full payload copy to collapsed rows.

**Make the new projections mandatory.** Rejected because headless tests and minimal bundles intentionally omit the projection registry; optional registration with a safe local fallback preserves that composition.

**Use npm's strict peer solver for the complete fork graph.** Rejected for the install-layout probe: the local 251-package peer graph exhausts the Node heap. The probe resolves production/optional placement through npm and checks every synthetic DSH peer edge's same-version range directly.

## Consequences

The shipped behavior aligns with the two upstream releases at the selected seams while retaining CoHarness's authority and wire formats. Directory navigation, goal reads, and tool expansion have explicit coverage across controller, source, renderer, and replay paths. The npm layout check is intentionally split between physical dependency placement and static peer-range validation; a future package-graph reduction can restore a strict peer install probe without changing the runtime decisions.

## Testing

Focused Goal, authority, input-trigger, reference, tool-row, Chat, Trajectory, dependency-gate, and npm-layout suites pass. `pnpm run typecheck` and the targeted Oxlint invocation pass; browser assembled snapshots, Windows lanes, and real-provider e2e remain release-environment checks.
