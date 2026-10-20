---
description: "Model-facing memory_search/read/save/delete tools plus the tool:memory saved-memory system-prompt guidance section"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-memory

English | [中文](README.zh.md)

The four model-facing memory tools — `memory_search`, `memory_read`, `memory_save`, `memory_delete` — plus the `tool:memory` system-prompt guidance section, over the host `ctx.memory` service.

## Summary

`dsh-tool-memory` is a function plugin (`name = 'tool-memory'`, `inject = ['memory', 'tools', 'systemPrompt']`). It registers the four memory tools — search, read, save, delete — plus the `tool:memory` prompt section teaching when to save and consult them. In `personal` space the tools take a `scope` parameter; in `project` space they address the shared project scope and writes pass through execution-authority. Reads run concurrently with siblings; writes run exclusively. Service refusals surface as stable `HarnessError` `code`s; a project-write denial rethrows `execution/forbidden`.

## Table of Contents

- [Tools](#tools)
- [Scope resolution](#scope-resolution)
- [Refusal codes](#refusal-codes)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="tools"></a>
## Tools

| Tool | Kind | Purpose |
|---|---|---|
| `memory_search` | read, parallel | Ranked hits over key/summary/content, each with a bounded excerpt; `scope` optional filter |
| `memory_read` | read, parallel | One full entry including the `revision` token the mutating tools consume |
| `memory_save` | mutate, exclusive | Create without `revision` (`memory_exists` on collision) or replace with it (`memory_stale`); rendered as a diff card (`memory/{scope}/{key}`) |
| `memory_delete` | mutate, exclusive | Remove an entry, revision-guarded when `revision` is passed |

<a id="scope-resolution"></a>
## Scope resolution

The `scope` parameter exists only when `ctx.memory.space === 'personal'` (the two-scope space). The executor resolves the argument through `ctx.memory.scopesFor(exec.agent)`: `workspace` maps to the session's own workspace scope (a session with no `cwd` gets `memory_invalid`/`scope-unavailable`), `personal` maps to the personal scope, and an omitted scope on `memory_search` searches every available scope. A call without an agent throws `memory tools require a calling agent`. Write admission itself lives in the service — schema presence is never the enforcement.

<a id="refusal-codes"></a>
## Refusal codes

Stable `code` values on thrown `MemoryToolError`s: `memory_exists`, `memory_not_found`, `memory_stale`, `memory_full`, and `memory_invalid` (with `key`, `summary`, `content`, `scope-unavailable`, `workspace-mismatch`, or `query` reasons). A project authorization denial propagates as `RemoteError` code `execution/forbidden` carrying the model-facing refusal text.

<a id="invariants"></a>
## Invariants

**Runtime invariant:** No companion is published. Each tool call delegates to `ctx.memory` inside the tool executor's own lifecycle; the plugin registers schemas and guidance only, so it owns no relation that could diverge.

<a id="model-experience"></a>
## Model Experience

### Tool schemas

#### What the model sees

Four generated schemas in the [tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-tool-memory): `memory_search` (query plus optional scope filter), `memory_read` (scope and key), `memory_save` (scope, key, kind, summary, content, optional revision), and `memory_delete` (scope, key, optional revision). The `scope` parameter exists only in personal space.

##### Tool descriptions

```markdown
memory_search — Search saved memories by words in their key, summary, or content. Returns matching memories ranked by relevance, each with a short excerpt. Read a memory with memory_read before relying on its details.
memory_read — Read one saved memory in full, including the revision that memory_save and memory_delete use to change it.
memory_save — Save a memory that later conversations will see in their saved-memory catalog. Without a revision this creates a new memory and fails if the key is already used. To change an existing memory, read it with memory_read and pass its revision; the content you send replaces the old content entirely.
memory_delete — Delete a saved memory that is wrong or no longer useful. Pass the revision from memory_read when you have one, so that a newer change is not deleted by mistake.
```

#### Token effect

Four fixed schemas on every request where the tools are visible; descriptions and parameters are stable for a given `space` and `summaryMaxChars` configuration.

#### KV Cache effect

Prefix-stable while the definitions and visibility are unchanged. Plugin lifecycle or scoped restrictions may invalidate reuse from these schemas.

### Guidance section

#### What the model sees

The `tool:memory` prompt section (order `TOOL_MEMORY`, 2450) teaches when to save, what never to save, revision handling, and which scope to prefer; it renders only where `memory_save` resolves for the requesting scope.

##### Section text (personal space)

```markdown
Saved memories carry knowledge between conversations. The saved-memory catalog in this conversation lists them by key with one-line summaries; memory_search, memory_read, memory_save, and memory_delete manage them.

Save a memory when you learn something that will matter in later conversations and cannot be recovered from the workspace: who the user is and how they like to work (profile); a correction or a confirmed approach to how you should work, with the reason (guidance); goals, constraints, decisions, or deadlines that the code and its history do not show (background); where to find information outside the workspace (resource). When the user asks you to remember something, save it; when they ask you to forget something, delete it.

Do not save what you can read from the workspace — code structure, file paths, conventions, git history, or fixes already in the code — what AGENTS.md files already say, or details that only matter to the current task. Never save secrets, credentials, or tokens.

Before saving, check the catalog or memory_search for a memory that already covers the fact and update it instead of adding a near-duplicate. Delete memories that turn out to be wrong.

A memory records what was true when it was written. Before acting on a memory's claim about files, functions, or flags, check the current workspace, and update or delete the memory if it no longer holds.

Use the personal scope for facts about the user that apply in every workspace, and the workspace scope for facts specific to this conversation's working directory.
```

#### Token effect

One static section per request where the tools are mounted; the text is constant for a given `space`.

#### KV Cache effect

The section is a stable standing prefix; it does not change between steps, so it never invalidates an already-reusable prefix on its own.

### Tool-call results

#### What the model sees

Search returns a `<memory_search query="…">` block of hit lines with excerpts (or `No saved memory matches "{query}".`), read returns a `<memory key="…" revision="…">` frame with the full body, save returns `Created memory "{key}" … (revision {revision}).` or `Updated …`, and delete returns `Deleted memory "{key}"{scopeFrom}.`. Refusals arrive as tool errors with stable codes and model-facing text, e.g. `A memory with the key "{key}" already exists in the personal scope. Read it with memory_read and pass its revision to replace it, or choose another key.`

#### Token effect

Result text is small and fixed-shape per call; `memory_read` returns the stored body verbatim, bounded by the service's `entryMaxBytes` write cap.

#### KV Cache effect

Append-only; each result follows the reusable request prefix and does not invalidate earlier KV-cache entries.

## Known Limitations and Deferred Work

- **`memory_save` diff card presents a synthetic path** — `memory/{scope}/{key}` is a display path only; a client that treats diff paths as real files should fall back to the generic card (the field is metadata, not a filesystem referent).
- **No batch or list tool** — enumeration is the catalog's job; the model searches or reads one key at a time.
- **Scope parameter exists only in personal space** — project space exposes no scope choice; member/browser writers and curation arrive in later PRs.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
