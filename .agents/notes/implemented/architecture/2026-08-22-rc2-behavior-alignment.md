# Agent Note: RC2 behavior alignment without repository merge

Status: implemented

English | [中文](2026-08-22-rc2-behavior-alignment.zh.md)

## Problem

CoHarness and the upstream DeepSeek Harness RC2 line do not share a common repository history, so an overall merge or a blind cherry-pick cannot establish compatibility. Earlier local alignment commits also left several RC2 user-visible and runtime behaviors absent: deterministic image admission, the DeepSeek Files request path, missing-resource status handling, and release-controlled documentation publication.

## Decision

CoHarness uses the upstream `dsh-v0.1.1-rc.2` behavior as the reference for user-visible, runtime, wire, security, and release semantics. Each applicable behavior is implemented locally or through an explicit adapter, with focused tests and assembled type/documentation checks. Repository history is not merged wholesale because the trees have different product extensions and ownership boundaries.

The image path now has deterministic canonical encoding, normalization and admission, request-image budgets, metadata/animation handling, and normalized `read_image` dimensions. DeepSeek image requests use the Files API with durable upload caching, file-id parsing and invalidation, stale-file retry, separate Files and stream timeouts, and inline fallback when Files resolution cannot be used. Quota reclamation removes each successfully deleted exact file id from the local upload index before continuing, so a failed or cancelled deletion does not clear later records. Static frontend misses return `404`, while explicit index entries continue to serve normally. Documentation deployment is manually dispatched and runs release verification against a complete tag history before publishing.

CoHarness-specific user documents, project workspaces, collaboration and ACL behavior, UI changes, and the default-unlimited document upload policy remain in place. They are separate product behavior, not substitutes for the DeepSeek Files pipeline. The document upload limit remains nullable: deployments may configure a finite limit, while the default does not impose a per-file limit.

The existing image-admission notes remain the owners of their narrower limits and encoding decisions: [web image admission](../bug-fix/2026-07-29-atomic-web-image-admission.md), [request-image payload bound](../bug-fix/2026-08-18-request-image-payload-bound.md), and [read-image dimensions](../feature/2026-08-10-minimal-read-image-tool.md). This note owns the cross-cutting RC2 alignment rule and the boundary between upstream compatibility and retained CoHarness extensions.

## Alternatives considered

**Merge or cherry-pick the upstream RC2 history.** Rejected because the repositories have no common ancestor and the local product has independent Gateway, workspace, collaboration, user-document and UI changes. A history operation would either fail or overwrite ownership decisions without proving behavioral equivalence.

**Copy upstream files one-for-one.** Rejected because package boundaries and local providers differ. The acceptance criterion is equivalent or stronger observable behavior, not identical source layout; local adapters are acceptable when tests cover the same failure and wire cases.

**Treat user documents as the DeepSeek Files implementation.** Rejected because user documents are a workspace storage and conversation feature, while Files API uploads are provider request preparation. Keeping the two paths separate preserves their different lifecycles, quotas and failure semantics.

**Declare perfect compatibility after focused tests.** Rejected because provider behavior, release builds, lint, documentation gates and deployment verification still require evidence. The project may claim RC2 behavioral alignment only after the relevant gates pass, and it must continue to state any intentionally retained CoHarness extensions.

## Consequences

The codebase has a documented, testable compatibility target without sacrificing local product behavior. Future upstream syncs compare behavior categories and acceptance tests instead of relying on commit-name matching. Files API failures can fall back to inline images without treating cancellation as a retryable provider failure; frontend clients no longer receive a successful SPA document for an unknown asset; and documentation publication cannot run from an arbitrary branch push.

This decision does not bump the package family from `0.1.1-rc.1` to `rc.2`, publish a release, push a branch, merge a pull request, or deploy production. Versioning and deployment remain separate release actions after the complete repository gates pass.
