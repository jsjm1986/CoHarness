# Agent Note: Upstream alpha.2 use-driver, MCP, and invariant-companion sync

Status: implemented

English | [中文](2026-09-19-upstream-alpha2-use-drivers-sync.zh.md)

## Problem

DeepSeek Harness `dsh-v0.1.6-alpha.2` ships the browser-use/computer-use driver family, the auto-review capability, an MCP client rewrite, and a package-invariant policy that publishes `./invariant` only where a package owns runtime-observable relations. CoHarness needs the driver and MCP surface while keeping its bounded-teardown cancellation semantics and the local package set.

## Decision

The nine driver and review packages — `browser-use`, `browser-use-runtime`, `browser-use-chrome-devtools-mcp`, `browser-use-playwright-mcp`, `browser-use-stagehand-native`, `computer-use`, `computer-use-cua-driver-mcp`, `computer-use-cua-driver-native`, and `auto-review` — plus the `mcp-client`/`mcp-resources`/`http-proxy` sync land verbatim, with upstream snapshot fixtures, e2e support modules, and a private `benchmarks` workspace covering the terminal-io suite. `agent-team` and `tool-agent-team` stay private under `PRIVATE_EXPERIMENTAL_PACKAGE_DIRECTORIES`; experimental packages otherwise publish by default per upstream policy.

One test row diverges by design. Upstream's auto-review spec drives `adapterStream` with `iterator.next()` directly, so a fixture adapter that ignores the abort signal still yields a decision and the tool outcomes read `ABORTED_BEFORE_DISPATCH`. The local `llm.stream` (`nextWithSignal`, the bounded-teardown contract) races cancellation and tears the stream down first, so the review fails closed and every outcome reads `AUTO_REVIEW_DENIED` — the same production behavior upstream exhibits against a signal-compliant adapter. The spec asserts the local outcome and documents the divergence at the assertion site.

Package invariants follow the upstream `omit-unneeded-invariant-companions` policy: 213 empty companions were removed with their `exports`, `files`, tsconfig references, tsdown entries, peer declarations, and companion specs, and each affected README records a package-specific `**Runtime invariant:**` reason line in both languages. Real installers, `runtime-diagnostics/invariants`, `sdk-minimal`, `session-persistence`, `agent-spine-demo`, and `webhook` (deferred to the persistence phase) keep companions. tsconfig `references` now derive from each tsconfig file set's actual workspace imports plus the upstream reference set, since the deleted companions previously carried transitive vendor declarations; `src`-only service imports such as `session-persistence`'s `dsh-invariants` resolve through `paths` without a project reference.

## Alternatives considered

**Keep the upstream auto-review cancellation row verbatim.** Rejected because it encodes the fixture adapter's signal-blindness as contract; under the local bounded-teardown stream the assertion would demand an outcome the fail-closed design correctly refuses.

**Keep explained empty companions.** Rejected: upstream moved the justification into a README reason line and deleted the companion, its build entries, and its test; retaining 213 no-op modules would reintroduce the divergence the policy removed.

**Declare the synthetic profile-resolution fixture names.** Rejected: `metadata-lib`, `#missing`, `./relative.cjs`, and similar specifiers are intentionally unresolvable test inputs, so knip records them as ignored imports rather than real dependencies.

## Consequences

The auto-review outcome vocabulary under caller cancellation reads `AUTO_REVIEW_DENIED` locally; porting future upstream spec rows must re-check which side of the race they assert. Invariant ownership is now opt-in per package, so adding a real invariant requires the companion, the reference, the export, and the README reason's removal together. `knip` is the local dependency-hygiene gate: bundle packages whose `dependencies` exist only as the cordis.yml resolver manifest carry `@deepseek-ai/.+` ignores, and mandated Cordis peer/dev pairs are ignored globally. `benchmarks` is a terminal-io-only subset; the remaining upstream suites, the coverage-partition rewrite that consumes `coverage-canonical-locations.ts`, and the `tsdown.client.ts` consumer of `bundle-input-isolation.ts` remain pending sync work.

## Verification

The nine ported packages pass their unit suites (`auto-review` 25/25, `browser-use-stagehand-native` 72/72 with restored snapshot fixtures) and the full hygiene chain is green: `verify-package-invariants` (43 companions), `verify-built-package-invariants`, `verify-client-packages` (52 packages), `verify-optional-dependency-imports`, `verify-package-dependencies` (289 packages, 729 edges), `check-workspace-constraints`, `rescope-vendor --check`, `verify-cordis-config` (166 files), and `knip` with zero findings. `tsc -b` host and client faces and `pnpm run build` complete after the reference rebuild and the `tsconfig.base.json` handwritten/generated duplicate-key cleanup.
