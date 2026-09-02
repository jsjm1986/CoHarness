# Agent Note: Portable defaults for repository CI runners

Status: implemented

English | [中文](2026-09-02-portable-ci-runner-defaults.zh.md)

## Problem

The CI workflow selected organization-scoped larger-runner labels and master-only self-hosted standby pools by default. Those labels are not available in every repository that carries CoHarness, so required jobs can remain queued without ever producing a result. The worker counts tuned for 16-core enterprise runners also oversubscribe standard GitHub-hosted runners.

## Decision

Required Linux jobs use `ubuntu-latest` by default, and the non-blocking native Windows job uses `windows-2025`. Setting the repository variable `DSH_CI_ENTERPRISE_RUNNERS_ENABLED` to exactly `true` selects the existing named enterprise pools instead. The existing `DSH_CI_FAILOVER_LINUX=selfhosted` and `DSH_CI_FAILOVER_WINDOWS=selfhosted` switches take precedence over that opt-in and continue to exclude Dependabot pull requests from self-hosted capacity.

This decision supersedes the implicit enterprise-runner defaults and unconditional standby cadence recorded in the [larger-runner evidence](2026-07-22-evidence-based-larger-hosted-runners.md), [serial reference](2026-07-21-serial-cross-platform-ci-reference.md), [failover runbook](2026-07-26-ci-failover-runbook.md), and [native Windows topology](2026-08-08-native-windows-pull-request-ci.md). Those notes retain their measurements, topology rationale, and operational procedures, but their enterprise and self-hosted paths now apply only when the corresponding repository variables select them.

Worker and gate concurrency is resolved from the same capacity decision. Standard hosted Linux coverage runs two single-worker instrumented partitions, applies a 30-second test and polling timeout, and serializes the instrumented and exempt-heavy gates. The standard consumer lane runs one outer gate at a time, gives Oxlint and publint one worker each, and runs ordinary snapshots serially while retaining two browser replay workers. Standard native Windows uses two coverage partitions, one outer gate worker, one publint worker, and the same 30-second coverage timeout. Enterprise or explicitly selected self-hosted pools retain the larger measured values.

The coverage inventory runs the real persistent PowerShell PTY check only on Windows. POSIX hosts may provide `pwsh` for non-interactive execution, but the `terminal-bash` PTY handoff evidence is Windows-specific; probing it on Linux made the required coverage gate fail before reaching its threshold. The native Windows lane retains the real-shell check.

The consumer lane also installs `gateway/package-lock.json` with `npm ci --prefix gateway --omit=dev` before running snapshots. `gateway/` is an independent npm project outside the root pnpm workspace, but its snapshot files are part of the root Vitest snapshot inventory and import Gateway runtime dependencies such as `pg`. A root `pnpm install` therefore cannot make that inventory self-contained by itself.

The first complete standard-runner execution showed why both layers must be bounded together: four or eight concurrent coverage partitions plus two outer gate workers caused otherwise bounded repository scans, large-file upload checks, terminal-idle observation, and ACP snapshot polling to miss their deadlines. The consumer lane also overlapped build-backed snapshots, lint, package publication checks, and browser replay on the same small host. Raising individual test timeouts alone would preserve the resource contention and make failure latency longer; the portable topology therefore reduces process fan-out first and uses the larger timeout only for legitimately slow coverage instrumentation.

Master-only standby jobs require `DSH_CI_SELF_HOSTED_STANDBY_ENABLED=true`, and the larger-runner benchmark jobs require the enterprise-runner opt-in. An absent repository variable therefore selects only generally available GitHub-hosted capacity and never leaves an optional private pool in the required path.

Portable hosted execution also makes the clean checkout authoritative. Built-entry tests resolve third-party package roots from public entries instead of assuming `./package.json` exports, the consumer lane installs the independent Gateway runtime graph before root snapshots, and protocol assertions include the current ACP message and provider capability fields.

`scripts/ci-workflow.spec.ts` pins the portable defaults, explicit opt-ins, failover precedence, and standby guards so a future workflow edit cannot silently restore repository-specific runner labels as defaults.

## Alternatives considered

**Keep the named enterprise pools as the default and document the prerequisite.** Rejected because a missing runner label produces an indefinitely queued required check rather than an actionable failure, and an independent repository should not require organization-owned infrastructure to validate a pull request.

**Remove enterprise and self-hosted runner support.** Rejected because the existing pools remain useful for measured high-concurrency runs and operational failover; they only need explicit repository-owned activation.

**Use enterprise concurrency on standard hosted runners.** Rejected because the existing worker counts were calibrated for larger machines and can increase contention, memory pressure, and test instability on the portable default pools.

**Keep two outer gate workers and only raise test timeouts.** Rejected because the standard-runner failures occurred while multiple coverage processes and unrelated build-backed gates competed for the same cores and memory. Longer deadlines do not restore the intended scheduling boundary.

**Add repository-specific runner labels for CoHarness.** Rejected because it would replace one private infrastructure dependency with another and leave the workflow non-portable.

## Consequences

A fresh repository can run the complete required CI surface on standard GitHub-hosted runners without configuring private runner groups. Organizations that own the larger or self-hosted pools retain them through explicit variables and preserve the existing failover paths. The portable default uses less parallelism and may take longer, but it produces a bounded result instead of waiting indefinitely for unavailable capacity. Enabling a private pool is now an administrator-owned repository configuration change rather than an implicit assumption embedded in the workflow.

## Testing

The CI workflow test parses the YAML and asserts the standard hosted fallbacks, enterprise opt-in, self-hosted failover precedence, exact portable partition and gate bounds, coverage timeouts, the independent Gateway install ordering, standby enablement, and benchmark guards. Focused Gateway snapshot, built-bin, subagent composition, and ACP snapshot tests cover clean-install consumer behavior. The repository pre-push typecheck and the resulting pull-request CI exercise the complete workflow configuration.
