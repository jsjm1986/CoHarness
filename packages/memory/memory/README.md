---
description: "Host-plane durable per-scope memory service: scoped facts that survive sessions, with serialized writes, project authorization, and bounded search"
kind: "package-reference"
---

# @deepseek-ai/dsh-memory

English | [中文](README.zh.md)

The host-plane durable memory service `ctx.memory`: scope resolution, validation, serialized read-check-write mutation, project-write authorization, and bounded relevance search over scoped facts that survive sessions.

## Summary

`dsh-memory` stores small durable facts — the memory entries later conversations still see. Each entry belongs to exactly one scope; the composition's `space` config decides which scope families exist. The service is a Cordis `Service` default-exported as `memory` with `inject = ['storageDomain']`; it owns the `memory` storage domain (one JSON document per entry), validates every field before mutation, serializes all writes on one promise chain, authorizes project writes through the execution-authority capability, and ranks bounded search results. The agent-plane consumers — `dsh-memory-context` (catalog publication) and `dsh-tool-memory` (model tools) — own every model-facing frame.

## Table of Contents

- [Configuration](#configuration)
- [Scopes and spaces](#scopes-and-spaces)
- [Write rules](#write-rules)
- [Member Remote surface](#member-remote)
- [Storage](#storage)
- [Search](#search)
- [Events](#events)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="configuration"></a>
## Configuration

| Field | Type | Default | Bounds |
|---|---|---|---|
| `space` | `'personal' \| 'project'` | `'personal'` | — |
| `entryMaxBytes` | integer | `8192` | 256–65536 (UTF-8 bytes of `content`) |
| `summaryMaxChars` | integer | `150` | 20–500 (Unicode code points) |
| `maxEntriesPerScope` | integer | `200` | 1–10000 |
| `searchMaxResults` | integer | `10` | 1–50 |

Resolved values are exposed read-only as `service.space` and `service.limits`. The Gateway project runtime patch selects `space: project`.

<a id="scopes-and-spaces"></a>
## Scopes and spaces

`scopesFor(agent)` returns the scopes a session may address, synchronously:

- `personal` space → `{ kind: 'personal' }` plus `{ kind: 'workspace', directory, sshTarget? }` when the session header carries `cwd` (`SessionHeader.cwd` / `sshTarget`); the SSH target id keys the workspace so a remote directory never aliases the same host path.
- `project` space → `{ kind: 'project' }` only.

`list(scope)` returns catalog rows (entries without bodies) ordered by kind (`guidance`, `profile`, `background`, `resource`), then `updated.at` descending, then key ascending. `read(scope, key)` returns one full entry or `undefined`.

<a id="write-rules"></a>
## Write rules

`save(request, writer)` and `delete(request, writer)` serialize every read-check-write on one promise chain inside the service, enforced in this order before any mutation:

1. The scope must belong to the space — else `memory_invalid` / `scope-unavailable`.
2. An agent writer may address only its own session's workspace scope (same directory and `sshTarget`) — else `memory_invalid` / `workspace-mismatch`; a session with no `cwd` gets `scope-unavailable`.
3. Field validation (save only): key `^[a-z0-9]+(?:-[a-z0-9]+)*$` at most 64 characters → `key`; trimmed non-empty single-line summary at most `summaryMaxChars` code points → `summary`; trimmed non-empty content at most `entryMaxBytes` UTF-8 bytes → `content`. Stored summary and content are the trimmed values.
4. Project scope plus agent writer authorizes through `ctx.get('executionAuthority')`: a policy denial propagates unchanged and nothing is written; the attested `primaryActorUserId` lands in the attribution record.
5. Revision semantics: save without `expectedRevision` is create-only (`memory_exists`); with it, replace-only (`memory_not_found`, `memory_stale`). Delete with `expectedRevision` requires a match (`memory_stale`); a missing key is `memory_not_found`.
6. A create at the scope cap (`maxEntriesPerScope`) refuses `memory_full`; replaces and deletes never do.
7. The write mints a fresh `randomUUID()` revision, keeps `created` on update, and stamps `updated` `{ source: 'agent', sessionId, userId?, at }`. The durable write resolves before the service returns, and `memory/changed` emits after the commit.

Attribution `source` is a closed union (`agent`, `extraction`, `consolidation`, `member`); `agent` and `member` writes exist today — `member` records browser edits through the Remote surface below, while `extraction`/`consolidation` reserve the durable schema for the curation pass.

<a id="member-remote"></a>
## Member Remote surface

`MemoryService` is a `TypertRemoteService`; five `@Remote` methods serve the browser Memory page. `memory/scopes` returns the scope catalog — personal plus non-empty workspace scopes in a personal runtime, the project scope alone in a project runtime — with each view's live entry count and the calling member's `writable` flag, plus the `memory` section's `enabled` flag. `memory/list` and `memory/read` serve entries member-wide; the API proxy admits the three reads through `PROJECT_TYPERT_PROCESS_WIDE_READS`. `memory/save` and `memory/delete` write as the captured collaboration participant through `memberWriter()` and are admitted through `PROJECT_TYPERT_REGISTRY_AUTHORIZED`: a project-scope write requires a `project` participant with `mode: 'rw'`; personal/workspace writes require a `personal` participant; a missing principal or a read-only membership rejects with the shared `collaboration-forbidden` refusal. A runtime without a collaboration provider keeps owner semantics.

The service registers the `memory` settings namespace (`installSettingsSection`, owner `project`, `projectWrite: 'manager'`) with one field, `enabled` (default `true`). Setting it `false` removes every scope from `scopesFor` — agents see no catalog and every write refuses `scope-unavailable` — while member reads and the stored entries stay inspectable.

<a id="storage"></a>
## Storage

The `memory` domain declares `layout: 'per-record'` with `invalidRecords: 'backup-and-skip'`: one JSON document per entry under `<backend-root>/memory/entries/<recordKey>.json`, so a corrupt record moves aside (`<key>.json.bak.<timestamp>`) instead of bricking the domain. Record keys are `${scopeId}_${key}`: `_` is the separator because neither the scope id (`personal`, `project`, `workspace-<first 16 hex of sha256(JSON.stringify([sshTarget ?? null, directory]))>`) nor the entry-key slug can contain it, and the whole key stays inside the per-record unit's path-safe `[a-zA-Z0-9_-]+` grammar. The record schema is a strict zod mirror of `MemoryEntry`; the domain opens once at service construction (a readiness promise every access awaits) and closes on dispose.

The service requires `storageDomain`: the storage family is mounted only in the Web bundle today, so `dsh-memory` mounts in the `web-app` bundle after `storage-domain`; the agent-plane rows stay inert in compositions without it.

<a id="search"></a>
## Search

`search(scopes, query)` normalizes NFKC + lowercase, extracts terms (Latin/digit tokens of length ≥ 2; CJK runs ≥ 2 plus their 2-gram bigrams), then scores each entry per field (key ×3, summary ×2, content ×1): `+10×weight` when the field contains the whole normalized query and `+weight×(1+min(occurrences,5))` per contained term. Score-0 entries drop; results sort by score descending, `updated.at` descending, key ascending, capped at `searchMaxResults`. Each hit carries the catalog row plus a whitespace-collapsed excerpt of at most 160 code points around the first matching term (summary fallback), with `…` at a cut edge. An empty query after trim returns `{ ok: false, code: 'memory_invalid', reason: 'query' }`.

<a id="events"></a>
## Events

`memory/changed(scopeId, key)` emits after a write commits; consumers re-read through the service rather than trusting the payload.

<a id="invariants"></a>
## Invariants

**Runtime invariant:** No companion is published. The service validates and commits each write through `storageDomain` inside one serialized chain; the durable record and the `memory/changed` emission are the same committed fact, so there is no independently observed relation to compare.

<a id="model-experience"></a>
## Model Experience

Indirectly, through `dsh-memory-context` and `dsh-tool-memory`, which own every model-facing catalog frame, tool schema, and prompt section this service backs.

#### KV Cache effect

None directly: the service constructs no model input; its consumers' catalog and guidance contributions own any cache behavior.

## Known Limitations and Deferred Work

- **Single-runtime visibility** — writes in one runtime are visible to that runtime's sessions and Remote members; cross-runtime propagation (federation) is deferred.
- **Storage family only in the Web bundle** — `dsh-memory` requires `storageDomain`, which only the `web-app` bundle mounts; personal-space CLI/headless profiles keep the agent-plane rows inert until their host composition mounts storage and this service.
- **`danger-full-access` can edit storage files** — the JSON documents sit under the Harness home in plain text; a session granted unrestricted filesystem access can read or corrupt them outside the service's write rules.
- **No curation or recall** — the attribution union reserves `extraction` and `consolidation` sources; the after-turn curation passes and the per-question recall selector are deferred to their own rows.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
