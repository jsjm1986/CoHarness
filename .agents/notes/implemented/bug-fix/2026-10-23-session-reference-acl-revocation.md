# Agent Note: Recheck session-reference access before publication

Status: implemented

English | [中文](2026-10-23-session-reference-acl-revocation.zh.md)

## Problem

A session can become unreadable while reference preparation waits for its projected surface or saves a full snapshot. An admission decision made before those awaits can publish content after access has been revoked.

## Decision

[`dsh-session-reference`](../../../../packages/context/session-reference/README.md) records whether collaboration access is required when an operation starts. It filters candidate sessions again after title projection, checks all referenced sessions before reading, rechecks after reads before spill, and checks once more before publishing model context. A revoked session, failed authority, or disappeared provider rejects the entire preparation. The same batch checks apply to full snapshots; authorization failures do not carry provider diagnostics. Compositions without collaboration keep the trusted-caller behavior.

The last successful authorization response is the publication checkpoint. It does not make ACL changes and session-log publication one cross-process transaction.

## Alternatives considered

**Authorize only before reading.** A slow session read or spill write can finish after revocation and expose the stale snapshot. Final batch checks observe access changes across those waits.

**Authorize every referenced session separately.** That multiplies remote authorization calls by the number of references. A single batch at each stage keeps call count bounded while withholding the whole result on any refusal.

## Consequences

Collaboration-backed references make up to three batch authorization calls during preparation, independent of the number of references. A revocation observed during an awaited read or spill withholds all referenced content from the model and leaves the target turn failed. Candidate discovery adds a final batch after asynchronous title projection.

## Verification

[`session-reference.spec.ts`](../../../../packages/context/session-reference/tests/session-reference.spec.ts) pauses source reads and spill writes while access is revoked, unloads the authority provider, and checks sanitized failures. The [headless snapshot](../../../../snapshots/session/session-reference-acl-revocation/snapshot.yml) boots the shipped profile with an external ACL fixture that revokes access during preparation; its persisted Session must end before a model request or referenced context is published.
