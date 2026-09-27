# Agent Note: Client Session references

Status: implemented

English | [中文](2026-09-23-client-session-references.zh.md)

## Problem

Catalog-driven scopes kept browser resources after their readers disappeared. Replacing a scope under the same Session id also let old contexts resolve the replacement. Adding persistent auxiliary views requires ownership independent of the selected conversation.

## Decision

Adopt alpha.2's explicit reference and generation-identity model in [client/runtime](../../../../packages/client/runtime/README.md). Independent consumers share opening but retain and release separately. A cancelled acquisition waiter affects only its own readiness; callers still release their reference. The last release ends the local generation without cancelling the Host Agent. Borrowing a binding or observing counts cannot allocate a scope.

CoHarness selection and Workbench adapters acquire ordinary references through this allocator. The target-runtime pool keeps connections for independent consumers after a pane closes. Composer drafts and active submission attempts retain their generation until cleared, discarded, or disposed, preserving local input across view switches. Reference observers may synchronously request navigation; reconciliation publishes each acquired view owner before processing another request.

Navigation intent has a separate cancellation lifetime from Session ownership. Workspace creation, fork, initial selection, and cross-runtime Workbench loading must still belong to the latest intent when they update the view. Explicit selection, clearing, layout changes, and plugin disposal invalidate older updates without undoing Host-side mutations or discarding another view’s draft.

View navigation holds a temporary reference until history is usable. Selection then transfers ownership to the view before that reference is released. Failed loading preserves the previous view and its draft; the navigation consumer reports the error and allows retry. Reference readiness keeps the upstream attempt-settlement semantics, so operation callers that require usable history check the resulting snapshot.

Each generation has its own scope tag and cancellation signal. Root disposal rejects pending readiness and invalidates bindings. A retired context cannot resolve or dispatch into a replacement with the same durable id. Asynchronous cleanup removes only the input shell it owns.

This is the CoHarness adaptation of the [upstream reference decision](2026-09-15-client-session-references.md), which retains the broader UI ownership and invocation-lifetime rationale. The pooled current-selection adapter remains local; this increment does not establish Host-event invocation ownership or completion of the auxiliary UI migration.

## Alternatives considered

**Keep catalog membership as an implicit owner.** Every listed Session could accumulate plugin state without a live reader, and auxiliary consumers could not express independent ownership.

**Replace the Workbench with the upstream conversation shell.** Explicit lifetime does not require changing CoHarness navigation, project targets, or its four-pane layout.

## Consequences

List actions retain their Session for operation settlement. Returned create/fork identities are catalogued but must be retained before borrowing a binding. Unit tests exercise independent waiters, repeated release, root disposal, same-id replacement, reentrant selection, and target connection ownership. Composer tests protect drafts and disposal; application tests must additionally prove the assembled navigation and Workbench flows.
