# Agent Note: Dependency ownership and dual-release install gates

Status: implemented

English | [中文](2026-09-01-alpha23-dependency-gates.zh.md)

## Problem

Selective upstream synchronization added package edges and a second release version to a workspace whose manifests mix host, browser, bundle, vendor, and native policies. Existing workspace checks did not detect a runtime Host import missing from production dependency sections, duplicate production declarations, or an npm tree that lets two DSH releases resolve through one package directory.

## Decision

`scripts/verify-package-dependencies.ts` scans workspace manifests and Host source imports. It requires workspace protocol ranges, matching peer/development declarations for DSH packages, no duplicate production declaration, no dangling peer metadata, and a production dependency section for each detected Host runtime edge. Client, bundle, app, vendor, and native policies remain with their existing specialized checks.

`scripts/benchmark-npm-resolution.ts` provides a metadata-only local registry resolver. `scripts/verify-npm-install-layout.ts` builds two incompatible synthetic DSH releases, asks npm for a hoisted lock layout, verifies nested and root paths for every resolved production/optional edge, and requires one shared Cordis path. The fork's complete DSH peer graph is too cyclic for npm's strict solver to finish within the Node heap; the layout probe removes DSH peer metadata only for that npm invocation, checks the 1,244 source peer ranges before cloning, and checks all 2,488 synthetic DSH peer ranges directly against their release version. The source manifests and the separate ownership gate retain the peer declarations.

The ownership gate runs in static CI and hygiene. The dual-version layout gate runs in the release verification workflow before build and publication. Both are read-only and operate on throwaway metadata or temporary consumers.

This note narrows the packed-install decision in [the npm release sequence note](2026-08-10-npm-release-sequences.md): that release probe still validates packed payloads and executable startup, while this upgrade gate validates range resolution and cross-release placement.

## Alternatives considered

**Rely on `check-workspace-constraints`, `verify-client-packages`, and Knip alone.** Rejected because those checks do not jointly prove Host runtime ownership or physical placement of two incompatible release graphs.

**Run npm's strict peer solver over the complete fork graph.** Rejected because the current 251-package peer graph exhausts the Node heap; a release gate that cannot complete locally or in CI is not an actionable safety check.

**Use only a hand-written graph simulation.** Rejected because it would verify our interpretation of npm's hoisting rather than npm's actual lock layout. The npm resolver remains in the loop for production/optional edges, with peer range integrity checked independently.

**Rewrite or remove peer declarations in published manifests.** Rejected because peers are part of the package contract and the host/client compositions rely on them; the resolver workaround is confined to synthetic benchmark metadata.

## Consequences

Manifest drift fails before release packing, and a dual-release regression reports the exact package path and edge that crossed versions. The npm probe is fast and deterministic for the current graph, but peer physical placement is represented by a static same-version assertion rather than by npm's strict peer solver. A future reduction of peer cycles can restore strict peer resolution without changing the ownership rules or release layout assertions.

## Testing

The verifier unit suites cover malformed sections, duplicate declarations, runtime import ownership, synthetic registry cloning, npm metadata resolution, path isolation, and shared Cordis placement. `CI=true pnpm run verify-package-dependencies` and `CI=true pnpm run verify-npm-install-layout` pass on the current workspace.
