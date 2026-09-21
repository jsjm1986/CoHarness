# Release evidence

English | [中文](README.zh.md)

## Summary

Publication requires accepted upstream decisions and CI evidence for the exact candidate and tested artifacts. The family workflows own packaging and registry writes. This reference defines readiness inputs; it does not certify a release or supply missing environment proof.

## Contents

- [Candidate and evidence](#candidate-identity)
- [Failures and recovery](#release-failures)
- [Verification ownership](#verification-owner)

<a id="candidate-identity"></a>

## Candidate and evidence

The publishing workflow's `evidence_runs` input names comma-separated CI run IDs for its exact commit. The authenticated preparation step downloads `gate-evidence-*` artifacts and writes `.artifacts/release-evidence/readiness.json`. The publish job also consumes the current run's completed pack or wheel-validation job. It does not rebuild those artifacts.

[Requirements](requirements.ts) derive mandatory proof from the candidate diff. The report cannot subtract checks. [The guard](readiness.ts) checks the actual job and run, downloaded report bytes, environment and SHA-256 artifact inventory before registry writes. Stable report fields retain outcomes and identities; wall clocks, timestamps and runner instances remain observations.

An alignment release matches exactly one manifest: `targetVersion` owns dsh; `releaseVersions` names other families. An ordinary product release needs one previously accepted record with `accepted.upstreamCommit` and an ancestor `accepted.localCommit`. The current upstream target must remain that accepted target. Changed paths, including both rename sides and vendor inputs, need recorded ownership. These fields record reviewed facts; copying them from an unrelated run cannot satisfy the guard.

<a id="release-failures"></a>

## Failures and recovery

Missing or ambiguous records, pending decisions, empty verification, unclaimed inputs, mismatched commits, changed artifacts, failed checks and invalid environments stop publication. Correct the underlying record or verification and produce new evidence. Existing failures and missing environments are not waivers. Do not relabel a changed upstream target as an ordinary product release.

A timestamp-rewritten legacy baseline cannot substitute for a committed family version. The legacy publisher also calls the shared guard; the protected family workflows own accepted publication. Native releases use the version/tag rule in their [existing verifier](../../native/system/scripts/verify-release.mjs).

<a id="verification-owner"></a>

## Verification ownership

Linux source audits, both SDKs, Gateway, Admin UI and Android consumers supply their own evidence. Native Windows cannot be replaced by Wine. Kernel confinement and real-provider calls require their owning workflows. An ordinary debug APK and emulator bridge tests do not prove real push delivery; that requires a designated test device and enabled push service. Release maintainers own these environment-dependent acceptances and the final protected-environment approval.

The [decision](../../.agents/notes/implemented/process/2026-09-21-candidate-bound-gate-evidence.md) explains the retained upstream executor and shadow selector. The unit and executable rejection cases in [readiness tests](readiness.spec.ts) cover guard behavior without contacting a registry.
