# Agent Note: Publish an explicit pre-release safety notice

Status: implemented

English | [中文](2026-08-30-safety-notice.zh.md)

## Problem

CoHarness can execute model-generated code, load plugins, access exposed host resources, and optionally make network requests. The repository had detailed component safeguards but no root-level operator notice that states the remaining pre-release risks and the required deployment posture.

## Decision

The repository root publishes `SAFETY.md` and `SAFETY.zh.md` as the operator-facing safety authority. They state that the project is unaudited pre-release software, describe sandbox and authorization limits, require least privilege and tested backups, and keep WebFetch, plugin metadata, and Session-log upload opt-in until endpoint, redaction, rate, audit, and rollback controls are approved. The notice does not replace Gateway authentication, TLS, sandboxing, or deployment-specific review.

## Alternatives considered

**Rely only on package-level security documentation.** Rejected because operators need one visible entry point before enabling a deployment.

**Claim that the existing sandbox makes untrusted execution safe.** Rejected because exposed resources, compromised plugins, and macOS isolation limits remain material risks.

**Enable the new upstream egress features by default.** Rejected because metadata and Session-log fields can disclose project or session information outside the local process.

## Consequences

New deployments have a clear safety warning and an explicit checklist for high-risk optional features. The notice is advisory; it cannot enforce infrastructure controls or substitute for a security audit.
