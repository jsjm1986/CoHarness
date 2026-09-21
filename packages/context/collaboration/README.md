# @deepseek-ai/dsh-collaboration

English | [中文](README.zh.md)

Service Definition for authenticated [project collaboration](../../../.agents/notes/implemented/feature/2026-08-15-project-collaborative-conversations.md). Consumers capture one request-bound authority instead of reading mutable account state from a process-global service.

## Summary

Use `dsh-collaboration` as the Service Definition for authenticated project collaboration: Consumers capture one request-bound authority — participant identity and ACL decisions — instead of reading mutable account state from a process-global service.


## Runtime contract

- `capture()` returns the authenticated participant, assertion expiry, provider lifetime signal, session authorization, batch readability filtering, and atomic approval/question claiming for the current request.
- `authorize()` resolves every descendant through its root conversation and returns the root-inherited project, visibility, creator, and `ro`/`rw` access facts.
- `withSessionCreation()` carries a project root conversation's `project` or `private` visibility through the asynchronous create operation; `currentCreation()` exposes it only inside that operation.
- `CollaborationError` preserves stable denial codes for RPC and HTTP Consumers. Providers fail closed when membership, visibility, or their authorization backend cannot be established.

## Model Experience

Indirectly, through consumers that own participant attribution and other model-visible behavior for the authorization operations this service defines.

#### KV Cache effect

No direct invalidation; the consumer owns any request-prefix changes.

## Known Limitations and Deferred Work

- **Root-owned visibility** — descendants cannot carry independent visibility; every read, write, manage, and approval decision resolves through the root conversation.
- **No membership mutation API** — project membership remains a Gateway/admin responsibility, outside this Service Definition.
- **One production provider** — `dsh-collaboration-gateway` is the only shipped provider; alternate deployments must implement all authority operations rather than bypass individual checks.

## Invariants

**Runtime invariant:** No companion is published. The package declares a request-bound authority contract only; providers carry whatever account state exists.
