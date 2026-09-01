# Agent Note: Knip accounts for generated Typert runtime dependencies

Status: implemented

English | [中文](2026-09-02-knip-generated-typert-dependencies.zh.md)

## Problem

Typert generation happens during the Host build and emits unbundled `lib/typert.host.js` and `lib/typert.remote-client.js` files. Those generated files import `zod` directly, but no source file needs the same import solely to make Knip observe the dependency.

`dsh-file-reference`, `dsh-session-reference`, `dsh-cordis-host-runner`, and `dsh-commands` all publish `./typert` and `./remote` exports backed by those generated files. Knip follows package exports when the ignored `lib` products exist, so a previously built checkout observes the `zod` imports directly. A clean checkout has no generated JavaScript and reports the same required dependencies as unused. A static `ignoreDependencies` entry cannot cover both states because Knip treats it as a redundant configuration hint once the products exist. Removing the manifest entries would make the published subpaths fail under pnpm's strict dependency layout.

## Decision

`knip.config.ts` wraps the checked-in `knip.json` base configuration. For each affected workspace, it adds a workspace-scoped `zod` exception only when neither generated JavaScript face exists. If either generated face exists, the wrapper leaves that workspace unchanged and Knip observes the bare import through the package export. The package manifests retain `zod` as a runtime dependency because the published generated JavaScript imports it.

The exception remains limited to these four packages: packages that import `zod` from source continue to be checked normally, and Knip does not gain a repository-wide exemption. The package READMEs record the generated-file dependency beside their durable maintainer constraints. Source files do not add empty imports to satisfy an analyzer; the configuration describes the actual source-plane versus artifact-plane difference instead.

## Verification

The Host build products for all four packages contain bare `zod` imports in both generated Typert files. `scripts/knip-config.spec.ts` exercises both clean-checkout and built-checkout resolution without mutating the base JSON. `pnpm run knip` passes with generated files present and with the affected generated JavaScript faces temporarily absent, while the normal build and package checks continue to verify that published exports resolve their declared runtime dependency.

## Alternatives considered

**Remove `zod` from the four manifests.** Rejected because the generated `./typert` and `./remote` JavaScript imports it at runtime.

**Add empty type-only imports to source files.** Rejected because that would misrepresent source ownership and couple production code to the limitations of one analyzer.

**Keep static workspace exceptions in `knip.json`.** Rejected because a built checkout makes those entries redundant configuration hints, and the repository intentionally treats Knip hints as errors.

**Ignore `zod` globally.** Rejected because source-owned uses in other packages should still be validated and stale dependencies should remain detectable.

## Consequences

Knip remains strict for ordinary source dependencies while accepting four generated-runtime dependencies in both clean and previously built checkouts. Adding another package with generated Typert exports requires a real `zod` runtime dependency and inclusion in the generated-face wrapper unless its source already imports `zod`.
