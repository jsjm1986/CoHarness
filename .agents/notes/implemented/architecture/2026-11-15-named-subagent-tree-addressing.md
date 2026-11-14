# Agent Note: Named subagent tree addressing

Status: implemented

English | [中文](2026-11-15-named-subagent-tree-addressing.zh.md)

## Problem

Upstream v0.2.2-rc.3 replaces id-keyed continuable children with a named tree: siblings hold durable unique names, members address each other through slash-separated paths below the root `lead`, and `sendMessage` reaches any member of the shared tree rather than only a direct child or parent. The fork's v0.2.1-era seam addressed children by Session id only — exact adjacency authorized messaging, sibling names did not exist, and Agent Teams v2's tree-wide delivery (siblings, deeper descendants, cross-branch members, `rootOf`, owner paths) had no local equivalent.

## Decision

- Names are committed state, not display aliases: `establishCatalogChild` and `establishExternalCatalogChild` emit a version-3 record carrying the reserved `name` beside the child record, so the sibling namespace survives restart and stays readable through `catalogNames`. Versions 0–2 keep decoding unchanged; a member at or below a historical unnamed link reports its Session id rather than an invented name. The [parent-catalog decision](2026-09-01-parent-owned-subagent-catalog.md) owns the catalog model the name commits into.
- `SiblingNameReservations` claims a name synchronously before `startContinuable` awaits, seeded from committed catalog names: concurrent sibling creations cannot collide, `INVALID_AGENT_NAME` and `DUPLICATE_AGENT_NAME` reject before startup, omission picks the first free `agent-N`, and rollback releases the claim while catalog commit makes it durable. `lead` names the root; children take 1–32 lower-case letters, digits, or hyphens starting with a letter.
- A member's model-facing name is the slash-separated path of sibling names from the root (`reviewer/checker`), built by `agentAddress`, `joinAgentPath`, `parentAgentPath`, and `resolveAgentPath`. Session ids remain the execution identity: `resolveName` reads committed catalogs from the live root and grants no authority, and every privileged operation still checks exact live `Agent`/`Session` identity.
- `sendMessage` is tree-wide within one shared root: the exact live tree root or any resident continuable member may target another member — siblings, deeper descendants, the direct parent — delivered as `Agent <sender-name> sent a message:` with durable `{ kind: 'agent-message', form: 'relay', senderSessionId }` attribution that records authorship without granting authority. An absent target cold-resumes below the shared root; its own creation ancestors need not be live. A lost root revokes member tree access, and the root itself cannot be cold-resumed.
- `rootOf(agent | session)` returns the shared live root a member's catalog ancestry resolves to, and `maxActiveSubagents` is a root-scoped pool counting resident and materializing continuable Activations, so one tree's concurrency budget is independent of who created whom.
- Continuable receipts return the durable name — the tree-relative path, or the Session id under an unnamed link — while settlement notices, `list_agents`, `listDescendants` paths, and tool schemas address members by name and keep Session ids for routing and transcript lookup.

## Consequences

- Agent Teams v2 gains tree-wide `sendMessage`, `rootOf`, durable member names, and owner paths without depending on this lane's internals.
- Named catalog records bump to version 3 while version 0–2 history stays readable; `subagent/descriptor`, timing, and lifecycle surfaces are unchanged.
- Any member can reach any other member of its tree, so authorization lives entirely in the service's exact-identity checks and `resolveName` convenience never confers it.
- A cold member's reachability no longer depends on its creator staying resident; conversely, losing the root strands the whole member tree's messaging even though each member's own Sessions persist.
- The `experimental/tool-subagent-oar` lane keeps tool-local name claims and publishes no version-3 name; deduplicating against committed names there is deferred work ([OAR lane note](2026-11-15-subagent-oar-absorption.md)).

## Alternatives considered

- Keeping exact-adjacency messaging was rejected: Agent Teams v2 needs sibling and cross-branch delivery, and a tree that already reconstructs shared ancestry for cold resume can authorize any member pair without extra state.
- Deriving names at read time (first-free `agent-N` projected per listing) was rejected: renumbering under deletion or concurrency would silently retarget messages, while a committed name is the only value a resumed tree can verify.
- Making names authoritative was rejected: display names can repeat across trees and outlive Agents, so `resolveName` deliberately returns a Session id that the exact-identity checks then admit or deny.
- Deferring the name claim to catalog-commit time was rejected: two overlapping starts would each run startup work before discovering the collision; the synchronous pre-await claim matches upstream ordering and fails fast.
- Keying `maxActiveSubagents` per creator was rejected: a tree shares one budget regardless of which member created a child, and per-creator pools let one member grow the tree past the limit by delegating through children.

## Verification

- `npx vitest run` over the subagent group — 1,514 package tests pass, covering catalog v0–v3 decode, sibling-name reservation, tree-wide send and cold-resume, root-scoped pools, and teardown cutoffs; 77 agent-team tests pass beside them.
- `npx tsc` and `npx oxlint` over the touched packages — clean.
- `verify-md-links`, `verify-md-wrap`, `verify-translation-pairing`, `verify-export-jsdoc`, `verify-agent-note-format` — clean for the touched docs.
