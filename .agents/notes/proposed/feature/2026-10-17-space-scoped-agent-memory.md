# Agent Note: Space-scoped agent memory for personal and project spaces

Status: proposed

English | [中文](2026-10-17-space-scoped-agent-memory.zh.md)

## Problem

Every session starts with an empty context window. Durable knowledge an agent learns while working — a user's corrections and preferences, project constraints the code does not show, where outside information lives — disappears when the session ends, so the next session asks the same questions and repeats the same mistakes. In a shared project space the loss multiplies: one member's agent learns a team convention and every other member's agent starts without it.

The harness carries adjacent mechanisms but no cross-session memory. [`agent-instructions`](../../../../packages/context/agent-instructions/README.md) loads human-written `AGENTS.md` files. [`session-reference`](../../../../packages/context/session-reference/README.md) injects a session the user cites. [`tool-session-query`](../../../../packages/session-query/tool-session-query/README.md) lets a model search earlier sessions in the same directory. [Recallable compaction](2026-07-06-recallable-compaction.md) restores shadowed history inside one session. None of them gives the agent a place to record a durable fact and receive a bounded catalog of those facts in every later session of the same space.

The runtime constrains where such a store can live and who may write it:

- Under `workspace-write`, file mutations and the bash sandbox may write only the session's original directory and the temporary areas ([`writableRoots`](../../../../packages/sandbox/sandbox/src/roots.ts)); a session's execution world may also be an SSH target rather than the host.
- A Gateway project runtime runs inside the project directory, while its Harness home lies outside it; each personal runtime has its own Harness home ([launch context](../../../../gateway/src/instances.ts)).
- One project runtime process serves every member's sessions. Resource capabilities are decided per execution participant by `ExecutionAuthority.authorize(capability)` and the Gateway's actor eligibility check ([`eligibleActors`](../../../../gateway/src/execution-identity.ts)).
- Project conversations are visible to every member unless private, and only the Gateway knows a conversation's visibility.
- The API proxy admits a project-scope Remote endpoint only when one of its explicit endpoint tables names it ([`authorizeTypertRemote`](../../../../packages/host/apiproxy/src/api-proxy.ts)).
- In the Web product, process-wide services and Remote receivers are host-plane rows, while model tools and per-session context are agent-plane rows mounted from [agent presets](../../implemented/architecture/2026-08-03-per-session-agent-presets.md) ([plane split](../../../../packages/bundle/web-app/cordis.patch.yml)).

## Proposal

Add agent memory as a capability owned by one host service, `dsh-memory` (`ctx.memory`), which keeps memory entries in a `memory` storage domain inside each runtime's Harness home and enforces every write rule inside its own write operations. Agent-plane consumers mounted from agent presets publish the memory catalog into sessions (`dsh-memory-context`), give the model memory tools (`dsh-tool-memory`), and optionally curate memory after turns (`dsh-memory-curation`). A browser plugin (`dsh-client-ui-memory`) lets people browse and edit memory. The Gateway gains a `memory` qualification lane that governs agent writes to shared project memory.

The component set follows ZCode's memory subsystem, which was read end to end in its source (mapped in the prior-art section below); every component binds to an existing harness mechanism and uses this repository's names.

## Spaces and scopes

The `memory` row's `space` setting selects the scopes a runtime offers. Personal runtimes and standalone products use the default `personal`; the Gateway's project runtime patch sets `project`.

| Space | Scope | Readers | Agent writes | Member edits in the browser |
|---|---|---|---|---|
| Personal | `personal` — facts about the user that apply in every workspace | The owner | Allowed | The owner |
| Personal | `workspace` — facts specific to one working directory | The owner | Allowed, from sessions of that workspace only | The owner |
| Project | `project` — facts shared by the project team | Every member | Requires the `memory` capability | Read-write members |

A workspace scope is identified by the session's execution target and its canonical original directory, so an SSH session's directory never aliases a host directory with the same path. Personal memory never enters a project-space session: project conversations are readable by other members, and injecting a member's personal memory there would disclose it.

## Entries

An entry is one fact: a branded `key` (lowercase letters, digits, and single hyphens, at most 64 characters, unique within its scope), a `kind`, a one-line `summary` of at most 150 characters used by the catalog and by recall, Markdown `content` up to a configured byte limit, an opaque branded `revision` that changes on every write, and `created`/`updated` fields recording the writer's source (`agent`, `extraction`, `consolidation`, or `member`), the session id, the public user id when the runtime knows it, and the time.

The closed kind set is `profile` (who the user or team is: role, expertise, preferences), `guidance` (how the agent should work: corrections and confirmed approaches, with the reason), `background` (goals, constraints, decisions, and deadlines that neither the code nor its history shows, with absolute dates), and `resource` (where to find information outside the workspace). The service validates every field and a per-scope entry limit before it writes. Entries carry no link syntax between one another.

## Storage

`dsh-memory` opens one `memory` domain through `ctx.storageDomain` ([domain storage decision](../architecture/2026-07-24-domain-kv-storage-and-workspace.md)) with the per-record layout and the `backup-and-skip` invalid-record policy, following the [schedule domain](../../../../packages/schedule/schedule/src/storage.ts). The Web bundle already mounts the storage family with its root in the Harness home, so a personal runtime stores memory in its owner's Harness home and a project runtime stores it in the project runtime's Harness home, outside the project directory and outside every sandbox writable root. The service serializes read-check-write sequences, makes each write durable before it resolves, and emits `memory/changed` only after the commit.

## Catalog injection

`dsh-memory-context` is an agent-plane row with an `agent/pre-step` listener modelled on the skill catalog ([tool-skill](../../../../packages/skill/tool-skill/src/index.ts), [catalog refresh decision](../../implemented/feature/2026-07-27-skill-catalog-hot-refresh.md)). After downstream listeners decide the step, it derives the entries of the session's scopes and compares a digest of their model-visible fields with the latest catalog visible on the session surface. When they differ it enters one `user/message` whose source is `{ kind: 'memory-catalog', form: 'catalog', update?: true, entries, omitted? }`: the first publication lists the catalog, and a later one replaces every earlier list. The durable `entries` let the conversation view render the catalog without parsing model-facing prose, and the surface comparison republishes the catalog after compaction shadows the previous one.

The catalog groups entries by scope and orders them by kind (guidance, profile, background, resource), then by most recent update, then by key. A configured byte budget applies to the complete message text; entries that do not fit are counted in `omitted` and replaced by one line directing the model to `memory_search`. Catalog text is summaries only, framed as background notes from the time they were written rather than instructions. Delegated sessions receive no catalog unless the row's `delegatedSessions` setting enables it.

## Model tools

`dsh-tool-memory` registers four tools whose operations call `ctx.memory`:

- `memory_search` matches words in keys, summaries, and content, including CJK bigrams, and returns ranked entries with an excerpt.
- `memory_read` returns one entry in full together with its revision.
- `memory_save` creates an entry when no revision is given and fails if the key exists; with a revision it replaces the entry only when that revision is still current.
- `memory_delete` removes an entry, checking a supplied revision.

A `scope` parameter appears only when the space offers more than one scope. A static system-prompt section states what to save, what never to save (workspace-derivable facts, `AGENTS.md` content, task-local details, secrets), how to choose a scope and kind, to update rather than duplicate, and to verify a memory's claims about code before acting on them. `memory_save` declares the `diff` render intent so a change appears as old and new content.

## Write authorization

`ctx.memory.save()` and `ctx.memory.delete()` enforce every rule before mutating, because the model tools, curation, and the browser all reach memory through these two operations:

- **Personal and workspace scopes.** Agent writers may address only their own session's workspace. No grant beyond the already-authorized execution is required.
- **Project scope, agent writer.** The service calls `executionAuthorityOf(ctx)?.authorize('memory', agent, signal)`. The Gateway requires every participant to hold the user-level `memory` qualification, the project to enable it, every non-administrator participant to be a read-write member (the existing writer rule), and the conversation to be project-visible; a private conversation reads project memory but cannot write it.
- **Project scope, member writer.** A browser edit requires a captured collaboration participant with read-write access. The API proxy admits the memory write endpoints through a table whose owning service authorizes the participant itself, and admits the read endpoints as process-wide reads.

Memory files lie outside every sandbox writable root, so under `read-only` and `workspace-write` the service is their only writer. `danger-full-access` leaves file mutations unconfined everywhere; in managed project runtimes it already requires plugin-management authorization.

## Background curation

`dsh-memory-curation` is an agent-plane row with two opt-in passes. Both run under the execution identity captured at the triggering turn, authorize before their first model call, send `purpose: 'memory'` with that identity so usage is attributed to the initiating member, and write only through `ctx.memory` with their own write source.

- **Extraction** runs after a turn ends with reason `completed`. It skips a turn that already called `memory_save` or `memory_delete`, a turn without human prose, and a delegated session. Requests are coalesced per session (one running, one pending), and a durable per-session cursor in the memory domain bounds the transcript slice. The request replays the session's last request prefix — system head, surface messages, and the request header's tools, as compaction does in [`buildSummarizationInput`](../../../../packages/compaction/compaction-basic/src/region.ts) to reuse the provider's prefix cache — and appends an extraction instruction listing the current catalog. A bounded tool loop then executes only memory operations and returns every other tool call as an error result.
- **Consolidation** runs after a turn-end pass once a scope's gates qualify: `lastRunAt` older than the configured interval, `changedSince` committed mutations at least the configured threshold (the service increments this counter inside its serialized write chain), and a sha256 content digest over the scope's `[key, summary, content]` tuples that differs from the last run's. It reviews the whole scope to merge near-duplicates, delete contradicted or stale entries, and convert relative dates, with a larger turn bound. The `consolidation-{scopeId}` cursor — `lastRunAt`, `lastDigest`, `changedSince: 0` — commits only after the run's writes land, so a repeated run over unchanged content makes no model call and an interrupted run re-arms itself.

The `memory` settings namespace exposes an `enabled` master switch plus the `extraction`, `consolidation`, and `recall` curation switches on the Plugins page; the curation switches are off by default. With them off, memory changes only when the agent saves deliberately or a person edits it.

## Per-question recall

When the `recall` switch is on, `dsh-memory-context` starts an auxiliary selector request at a turn's first step. The request receives the catalog fields and the latest human message — bounded at `recallInputMaxBytes` — and returns at most `recallMaxSelections` keys (five, capped) as JSON `{"keys": [...]}`. The listener injects the selected entries' bodies, each capped at `recallEntryMaxBytes` and fitted to `recallMaxBytes` per message, through `agent.inject()` as a `memory-recall` context, so they join the next admitted request; an injection still pending when the turn ends is discarded. A per-session byte budget folded from the surface (`recallSessionMaxBytes`), and the set of `scopeId:key` addresses folded from durable `memory-recall` events, bound repetition — a key is never re-selected inside one session even after compaction reclaims the bytes. No embedding service is involved.

## Earlier-session lookup

ZCode's `ReadSessionContext` corresponds to the existing `tool-session-query` tools. They authorize a target session by working-directory equality, which in a project runtime would expose other members' private conversations, so enabling them in project space requires filtering every target through `CollaborationAuthority.readableSessionIds()` in addition to the directory check.

## Browser surface

`dsh-client-ui-memory` adds a Memory page in the sidebar. In a personal space it shows the personal scope and each workspace scope that holds entries; in a project space it shows the project scope. The page groups entries by kind, searches them, and shows each entry's content, revision time, writer record, and a link to the source conversation. It creates, edits, and deletes entries when the service reports the scope writable for the caller. A Plugins-page card edits the `memory` settings namespace.

## Package map

| Package | Plane | Responsibility |
|---|---|---|
| `packages/memory/memory` (`@deepseek-ai/dsh-memory`) | Host | `ctx.memory`: spaces and scopes, entry validation, the `memory` storage domain, write authorization, `memory/*` Remote methods and `memory/changed`, the `memory` settings namespace |
| `packages/memory/memory-context` (`@deepseek-ai/dsh-memory-context`) | Agent | Catalog publication and per-question recall |
| `packages/memory/tool-memory` (`@deepseek-ai/dsh-tool-memory`) | Agent | `memory_search`, `memory_read`, `memory_save`, `memory_delete`, and the memory guidance section |
| `packages/memory/memory-curation` (`@deepseek-ai/dsh-memory-curation`) | Agent | Extraction and consolidation passes |
| `packages/client/ui-memory` (`@deepseek-ai/dsh-client-ui-memory`) | Browser | Memory page and settings card |
| `gateway/` | Gateway | `memory` qualification lane and the project runtime's `space: project` setting |

The standard, PTC, and Cordis presets mount the agent-plane rows; the minimal preset does not. The Web bundle mounts the host row after the storage family.

## Prior art — ZCode, verified against source

| ZCode component | This design |
|---|---|
| Per-workspace memory directory under the CLI storage root | `memory` storage domain in each runtime's Harness home, scoped by space |
| One Markdown fact per file with `user` / `feedback` / `project` / `reference` types and `[[name]]` links | One validated entry per key with `profile` / `guidance` / `background` / `resource` kinds and no link syntax |
| Agent-maintained `MEMORY.md` index loaded once per session | Catalog derived by the service and republished whenever it changes |
| Write and Edit on memory paths, auto-allowed by a permission rule | Dedicated memory tools; shared project writes require the `memory` capability |
| `originSessionId` stamped into frontmatter | Created and updated writer fields on every entry |
| Background extraction agent after each successful round | Extraction pass, off by default |
| Dream consolidation pass, implemented but not triggered | Consolidation pass, off by default |
| Semantic recall through an auxiliary selector, disabled in the shipped code | Per-question recall, off by default |
| `ReadSessionContext` | `tool-session-query`, with project-space ACL filtering |
| Subagent memory per agent profile | Deferred until an agent preset needs isolated memory |

## Delivery stages

1. The `memory` qualification lane: the execution capability, Gateway eligibility, migration, and administrator API and UI.
2. The foundation: `dsh-memory`, catalog publication, the model tools, preset and bundle rows, the project runtime setting, the API proxy tables, documentation, and snapshot coverage.
3. The Memory page and the settings card.
4. Extraction, consolidation, and the `memory` model-call purpose.
5. Per-question recall.
6. Collaboration-aware filtering in `tool-session-query` for project spaces.

## Alternatives considered

**Memory files inside the repository, written with the ordinary file tools.** The repository is a sandbox writable root, so bash or a file tool could write project memory without the lane being consulted. The files would also appear in every member's working tree, and an SSH session would keep a second copy on the remote machine. Rejected.

**Memory files in the Harness home, written with the ordinary file tools.** A session's file tools act in its execution world, which may be a sandbox or an SSH target, and the Harness home lies outside the writable roots. Rejected in favor of tools whose operations run in the host service.

**An agent-maintained index file.** Every save would need two coordinated writes, and the index would drift from the entries. A catalog derived from the entries cannot drift. Rejected.

**Injecting personal memory into project-space sessions.** Project conversations are readable by other members. Rejected.

**Memory blocks or extraction-and-vector services (Letta, mem0, Zep).** They add a store and retrieval path that the session log and a person cannot audit. Recall here uses an auxiliary selector over the catalog and needs no embeddings. Rejected.

**A single structured-output extraction call.** Replacing an entry requires its current content and revision, which a single call cannot read first. A bounded loop over the memory operations can. Rejected.

**A project-level grant alone for agent writes.** An administrator could not withdraw one member's agent from writing shared memory, and the lane would differ from the desktop, terminal, and SSH lanes. Rejected.

**Extraction on by default.** It adds a model call to every eligible turn, billed to the initiating member. Rejected; the switch is on the Plugins page.

**Per-preset memory now.** No agent preset needs isolated memory. Deferred: when one does, entries gain a preset dimension and the catalog filters on it.

## Acceptance criteria

- **Lane.** `authorize('memory')` succeeds only when every participant holds the user-level memory qualification, the project enables it, every non-administrator participant is a read-write member, and the conversation is project-visible. It is refused in personal runtimes and private conversations. Revoking a grant fails the running session's next check. Administrators manage both grants in the Gateway UI.
- **Foundation.** A session whose space holds entries logs one `memory-catalog` message whose entries equal the scope entries within the byte budget, and the log reconstructs the exact injected text. A change made in another session publishes a replacement catalog at the next step, and the catalog republishes after compaction. Tool writes enforce key, kind, summary, content, revision, and entry-count rules. A project write by a participant without the grant is refused inside `ctx.memory.save()`, proven through the tool executor, while reads continue. A browser write by a read-only member is refused. A test-only composition booted through the Loader proves storage round-trip and disposal. Model-visible text is pinned by package README quotes and a keyless snapshot.
- **Browser.** The Memory page lists, searches, opens, creates, edits, and deletes entries in both spaces and shows the read-only state for read-only members; the settings card writes the `memory` namespace.
- **Curation.** With extraction on, a real-provider end-to-end test records a fact in one session and a later session in the same space receives it in the catalog. With the switches off, no curation model call is made. Denied authorization makes no model call. Consolidation merges a seeded duplicate pair into one entry.
- **Recall.** With recall on, a matching question injects the selected bodies in the next admitted request within the per-entry and per-session budgets. With recall off, no selector request is made.
- **Session lookup.** In a project runtime, `tool-session-query` never returns another member's private conversation.

## Risks

- **Catalog cost.** Each republication adds the catalog to the conversation. The byte budget, one-line summaries, and change-only republication bound the cost; a large corpus relies on `memory_search` and recall instead of the catalog.
- **Memory quality.** Agents may save low-value or wrong facts, and extraction amplifies this. Curation is off by default, the guidance excludes derivable facts, consolidation merges and prunes, and people can edit or delete any entry.
- **Persisted untrusted text.** Content written from one conversation reaches later conversations. The catalog and recall frame memory as dated background rather than instructions, the entry's writer fields identify every writer, and project writes require the lane.
- **Secrets.** A model may save a credential despite the guidance. Members can delete it; the service does not inspect content for secrets.
- **Single-process visibility.** Domain state is authoritative in memory, so two standalone processes sharing one Harness home do not see each other's writes until they restart. Gateway runtimes run one process per space.
- **Unconfined sessions.** `danger-full-access` can modify the storage files directly, bypassing the service's checks.
