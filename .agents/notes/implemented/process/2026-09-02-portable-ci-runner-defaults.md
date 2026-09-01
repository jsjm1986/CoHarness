# Agent Note: Portable defaults for repository CI runners

Status: implemented

English | [中文](2026-09-02-portable-ci-runner-defaults.zh.md)

## Problem

The CI workflow selected organization-scoped larger-runner labels and master-only self-hosted standby pools by default. Those labels are not available in every repository that carries CoHarness, so required jobs can remain queued without ever producing a result. The worker counts tuned for 16-core enterprise runners also oversubscribe standard GitHub-hosted runners.

## Decision

Required Linux jobs use `ubuntu-latest` by default, and the non-blocking native Windows job uses `windows-2025`. Setting the repository variable `DSH_CI_ENTERPRISE_RUNNERS_ENABLED` to exactly `true` selects the existing named enterprise pools instead. The existing `DSH_CI_FAILOVER_LINUX=selfhosted` and `DSH_CI_FAILOVER_WINDOWS=selfhosted` switches take precedence over that opt-in and continue to exclude Dependabot pull requests from self-hosted capacity.

This decision supersedes the implicit enterprise-runner defaults and unconditional standby cadence recorded in the [larger-runner evidence](2026-07-22-evidence-based-larger-hosted-runners.md), [serial reference](2026-07-21-serial-cross-platform-ci-reference.md), [failover runbook](2026-07-26-ci-failover-runbook.md), and [native Windows topology](2026-08-08-native-windows-pull-request-ci.md). Those notes retain their measurements, topology rationale, and operational procedures, but their enterprise and self-hosted paths now apply only when the corresponding repository variables select them.

Worker and gate concurrency is resolved from the same capacity decision. Standard hosted runners use bounded low-concurrency values; enterprise or explicitly selected self-hosted pools retain the larger measured values. Master-only standby jobs require `DSH_CI_SELF_HOSTED_STANDBY_ENABLED=true`, and the larger-runner benchmark jobs require the enterprise-runner opt-in. An absent repository variable therefore selects only generally available GitHub-hosted capacity and never leaves an optional private pool in the required path.

`scripts/ci-workflow.spec.ts` pins the portable defaults, explicit opt-ins, failover precedence, and standby guards so a future workflow edit cannot silently restore repository-specific runner labels as defaults.

## Alternatives considered

**Keep the named enterprise pools as the default and document the prerequisite.** Rejected because a missing runner label produces an indefinitely queued required check rather than an actionable failure, and an independent repository should not require organization-owned infrastructure to validate a pull request.

**Remove enterprise and self-hosted runner support.** Rejected because the existing pools remain useful for measured high-concurrency runs and operational failover; they only need explicit repository-owned activation.

**Use enterprise concurrency on standard hosted runners.** Rejected because the existing worker counts were calibrated for larger machines and can increase contention, memory pressure, and test instability on the portable default pools.

**Add repository-specific runner labels for CoHarness.** Rejected because it would replace one private infrastructure dependency with another and leave the workflow non-portable.

## Consequences

A fresh repository can run the complete required CI surface on standard GitHub-hosted runners without configuring private runner groups. Organizations that own the larger or self-hosted pools retain them through explicit variables and preserve the existing failover paths. The portable default uses less parallelism and may take longer, but it produces a bounded result instead of waiting indefinitely for unavailable capacity. Enabling a private pool is now an administrator-owned repository configuration change rather than an implicit assumption embedded in the workflow.

## Testing

The CI workflow test parses the YAML and asserts the standard hosted fallbacks, enterprise opt-in, self-hosted failover precedence, reduced portable concurrency, standby enablement, and benchmark guards. The repository pre-push typecheck and the resulting pull-request CI exercise the complete workflow configuration.
