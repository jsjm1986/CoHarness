# Agent Note: PostgreSQL Sessions keep Host identity inside each Runtime

Status: implemented

English | [中文](2026-10-30-postgres-session-runtime-namespace.zh.md)

## Problem

Host Session identifiers belong to their producing Runtime. A database-wide Host key makes independent histories compete for the same identifier. Adding Runtime metadata to an otherwise global key cannot isolate bodies, retries, descendants, approvals or derived records when identifiers coincide.

## Decision

PostgreSQL keys Session data by organization, Runtime namespace and the original Host id. `PostgresConversationStore.forRuntime()` constructs immutable repositories from authenticated Runtime coordinates; reads and mutations use that repository throughout the operation. Root lineage, append batches, migration predecessors, search, participants, interaction claims, file references, push deliveries and progress receipts retain the same namespace. Steward approval consumption and activity cursors also retain the Runtime.

Migration099 preserves existing columns and raw event bytes. Recorded assignments supply the namespace. Unassigned history and unwitnessed draft reservations remain legacy records; allocating a Runtime cannot adopt them. New body writes require a recorded Runtime, and reference reassignment is refused. JSONL generations and original Host identifiers remain unchanged.

Maintenance selection carries the reviewed Runtime/Host pair through preview, browser selection and confirmation. Notification actions carry the producer Runtime. Browser sharing reads and changes retain the Session’s Runtime allocation and project selector independently of other tabs’ scope cookies. An unqualified identity never selects another Runtime by a matching Host name. The [upgrade guide](../../../../docs/upgrade-guide/v0.2.1-rc.1.coharness.1/postgres-session-runtime-namespace/guide.md) owns deployment and client steps.

## Alternatives considered

**Rewrite every Host identifier into a global name.** Rejected because local logs, references and immutable predecessors retain their producer's identifiers.

**Find a matching Session first and infer its Runtime.** Rejected because equal identifiers can have several authorized or unauthorized owners.

**Assign unknown history to a newly allocated Runtime.** Rejected because an allocation proves neither the origin nor authority over older data.

## Consequences

Gateways sharing a database upgrade together. Current clients refresh old cursors and submit reviewed maintenance pairs. Legacy records remain available only through their existing explicit historical ownership paths; they do not provide a fallback for a new Runtime.

The [writer-lock](../bug-fix/2026-10-24-conversation-writer-locks.md), [collaboration](../feature/2026-08-15-project-collaborative-conversations.md) and [draft lifecycle](2026-08-26-session-draft-lifecycle-and-content-watermarks.md) decisions remain active. Runtime qualification supplements their authority and durability rules. Migration byte preservation, equal-name authenticated HTTP, concurrent writer revocation and independent browser selection require database and assembled application verification. Logical computer fixtures do not establish physical multi-host or real-provider acceptance.
