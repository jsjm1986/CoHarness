# Agent Note: Runtime start admission identity

Status: implemented

English | [中文](2026-10-31-runtime-start-admission-identity.zh.md)

## Problem

Runtime startup carries both an owner selector and an optional durable environment ID. Ignoring a supplied environment ID allows an inconsistent reference to alter the owner generation's allocation state and consume its node pressure credit. The identity checks earlier in ordinary managed startup do not make that behavior a valid admission-service guarantee.

## Decision

The pressure-admission query matches organization, computer, owner, generation and any supplied Runtime ID before recording a waiting or possible allocation. An inconsistent reference fails as a stale generation without spending credits. An omitted environment ID retains the existing generation lookup. The owner-generation allocator remains responsible for preventing overlapping generations between an owner's independent environments.

## Alternatives considered

**Rely only on upstream target selection.** The allocation operation would still silently discard an explicit selector and make an inconsistent request affect another environment.

**Remove legacy owner selectors.** Existing trusted callers use them; the generation allocator already gives that lookup an unambiguous owner namespace.

## Consequences

The check changes no schema or generation allocation. Real PostgreSQL cases cover foreign account, project and computer IDs plus an unknown ID, retaining a correct-target admission control. Plain compiled Node acceptance also checks refusal without allocation or credit changes, fresh-pressure waiting, cancellation and preservation of a ready assignment. This is an admission-service repair; no external cross-account execution exploit or generation collision is established.
