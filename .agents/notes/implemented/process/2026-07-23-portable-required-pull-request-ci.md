# Agent Note: Portable pull-request CI recovery boundary

Status: implemented

English | [中文](2026-07-23-portable-required-pull-request-ci.zh.md)

**Current runner placement.** The [portable runner defaults](2026-09-02-portable-ci-runner-defaults.md) supersede this note's enterprise-primary placement and lack of an automatic standard-hosted path. The required-versus-diagnostic inventory boundary and the rejection of skipping evidence remain applicable.

## Problem

Required pull-request jobs assigned to organization-owned runner labels remain queued when GitHub cannot allocate those pools. The workflow is valid and standard GitHub-hosted jobs can still pass, but `all checks passed` never starts and an otherwise healthy pull request cannot satisfy branch protection.

Billing health, a runner definition's `Ready` state, and a large autoscaling ceiling do not prove that a named pool can receive a job. Required correctness checks need a known portable recovery path even when the ordinary low-latency path depends on repository-external runner provisioning.

## Decision

[CI](../../../../.github/workflows/ci.yml) runs the required primary Node 24 jobs and the stable `all checks passed` aggregate on standard `ubuntu-latest` by default. `DSH_CI_ENTERPRISE_RUNNERS_ENABLED=true` may select the named enterprise pools, while `DSH_CI_FAILOVER_LINUX=selfhosted` takes precedence for trusted non-Dependabot pull requests. The aggregate performs no checkout or repository gate. The required Windows job runs Windows Node under Wine on standard `ubuntu-latest` for the blocking surfaces; an independent native `windows-2025` job starts automatically but does not participate in the aggregate ([dual Windows decision](2026-08-08-native-windows-pull-request-ci.md)). Standard hosted jobs also retain Node 22.19, Node 26, the Python SDK unit suite, and the [release-shaped Linux x64 Python runtime validation](../testing/2026-08-12-required-python-runtime-pull-request-ci.md).

The three Linux primary jobs, Node compatibility, Python SDK unit suite, Python runtime validation, and `windows node 24 / wine blocking` remain dependencies of `all checks passed`; `windows node 24 / native complete` is deliberately absent. Branch protection continues to require `e2e` and `all checks passed`. The portable labels are the automatic default rather than a fallback that skips or demotes evidence. A deployment selecting external capacity can return to the portable labels by removing its enterprise or failover variable and re-running the exact head.

The [larger-runner decision](2026-07-22-evidence-based-larger-hosted-runners.md) owns the measured consolidated topology. The [portable runner defaults](2026-09-02-portable-ci-runner-defaults.md) own current placement and capacity-specific worker bounds. The [serial cross-platform reference](2026-07-21-serial-cross-platform-ci-reference.md) retains independent self-hosted completeness drills for deployments that explicitly enable them; the only hosted serial reference is the disabled `serial-macos`. The manual larger-runner suites retain size comparisons without expanding the ordinary required matrix.

## Alternatives considered

**Keep enterprise capacity as the default primary path.** Complete standard-runner jobs can give slower feedback and still experience shared-capacity queues, but private labels can remain queued forever when the repository does not own those pools. The current decision accepts the latency trade-off for a runnable correctness default and preserves enterprise capacity as an explicit performance choice.

**Select enterprise size from advertised core count.** Benchmarks show non-monotonic scaling and setup variance, so exact complete-job measurements choose the required pools instead.

**Skip or demote checks while capacity is unavailable.** This would make the status green by dropping evidence rather than by running the repository's required contracts.

**Use one worker policy on every host.** Outer gate concurrency and inner tool workers contend differently on Linux, Windows, and standard runners; measured host-specific bounds avoid turning additional cores into slower execution.

## Consequences

Ordinary pull requests use standard GitHub-hosted capacity for the Linux critical path, while the Wine job keeps the required Windows verdict on standard Linux allocation. The independent native job uses standard Windows allocation without delaying or changing the aggregate. Deployments may explicitly select enterprise or self-hosted capacity without changing the required inventory. A live exact-head run distinguishes the commands branch protection consumes from the separate diagnostic contract; queue delay is reported separately from each job's `startedAt` to `completedAt` execution interval.

Changing a pool definition's status alone is insufficient evidence that it can receive work. A deployment using external labels must verify their allocation and can recover by restoring the portable default before re-running. Recovery never makes the status green by omitting a required Linux job or the aggregate.
