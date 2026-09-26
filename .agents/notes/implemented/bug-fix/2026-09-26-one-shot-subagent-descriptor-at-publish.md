# Agent Note: Agent Teams classify subagent children by durable session origin

Status: implemented

English | [中文](2026-09-26-one-shot-subagent-descriptor-at-publish.zh.md)

## Problem

`tryMembership` in the Agent Teams roster distinguished provider-owned subagent children from implicit Team roots by folding the child Session's own events for a `subagent/descriptor` record. The in-process one-shot driver appends that descriptor only when the child's first `agent/pre-step` admits the turn — the event deliberately proves entry, so every `agent/created` observer ran before the discriminator was durable. An ordinary `tools.subagent` child with a live parent was therefore classified as an implicit Team Lead: `tool-agent-team` installed the full Team scope on it, and the `team:policy` prompt section's strict `membership()` read threw `TEAM_NOT_MEMBER` once the descriptor landed, terminating the child's turn as a generic `subagent run failed` after the delegated work had already succeeded.

## Decision

[TeamRoster.subagentDescriptor](../../../../packages/experimental/agent-team/src/roster.ts) treats `session.header.origin === "subagent"` as the classification first: `childSessionMeta` writes that marker into the durable session header at creation, so it is visible before `agent/created` announces the child. The descriptor fold remains as the authority for sessions created before the origin field existed, and for cold-resumed children whose own events already carry it.

## Alternatives considered

**Append the descriptor during unpublished `setup`.** This makes the marker durable before `agent/created`, but it deletes a load-bearing ordering contract: workflow gates can hold a spawned child at its first `agent/pre-step`, and the descriptor's presence must keep proving the child actually entered. A held child would carry the record without ever running.

**Defer Team installation past `agent/created`.** A microtask or first-step install still exposes the classification gap between creation and observation, and a `session/event`-driven uninstall leaves Team tools advertised to a child model for its first step.

**Consult a live registry instead of the durable log.** `establishCatalogChild` writes the parent's `subagent/catalog` entry only after `provider.start` resolves, which is after `agent/created`; the parent-side record has the same timing gap and adds a dependency where the session header already carries the fact.

**Render `team:policy` through `tryMembership`.** Swallowing the strict read hides future misclassification instead of fixing it; the section is installed only for members, so a strict failure stays the correct alarm.

## Consequences

The roster's classification no longer depends on event-fold timing, so any observer ordering — `agent/created`, `agent/status`, cold resume — resolves provider-owned children correctly. Team teammates still win over the origin check because roster membership is consulted first; `origin: "subagent"` on a rostered continuable child cannot downgrade it to a non-member. Out-of-process providers (`dsh-sdk`, ACP) create their children in separate processes and are unaffected.
