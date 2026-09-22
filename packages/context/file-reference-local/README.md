# `@deepseek-ai/dsh-file-reference-local`

English | [中文](README.zh.md)

Local-filesystem implementation of `ctx.fileReferences`. It maintains one bounded `WorkspaceFileSearch` per agent, rooted at that session's `cwd` and falling back to the host process cwd. The index ranks direct directory listings for queries containing `/`, otherwise fuzzy-ranks a bounded recursive index; it never follows directory symlinks.

Tool-result events invalidate the addressed agent's reusable index so later completion observes likely workspace mutations. Agent disposal releases that index and its scoped prompt contribution; plugin disposal awaits every prompt fiber and releases all cached searches.

## Summary

Agents and host UIs can complete `@file` mentions with ranked paths from each agent's local workspace, with bounded discovery that stays responsive in large repositories. Results refresh after tool activity without blocking completion, and directory symlinks are never followed. When `read` is available, the model also receives stable guidance for interpreting referenced paths. Choose this package when `read` uses the Harness host filesystem; remote or virtual namespaces need matching discovery.

## Configuration

| Key | Default | Contract |
|---|---:|---|
| `maxResults` | `20` | Maximum ranked candidates returned for one query. |
| `maxEntries` | `10000` | Maximum files and directories indexed per agent workspace. |
| `excludedDirectories` | `[".git", "node_modules"]` | Directory basenames omitted from traversal and candidates. |

Every numeric value must be a positive safe integer. Excluded names must be non-empty basenames without `/` or `\`.

## Invariants

**Runtime invariant:** No companion is published. The per-agent index is a bounded cache rebuilt from the filesystem on demand; the filesystem remains the only authority.

## Model Experience

### File-reference guidance when read is available

#### What the model sees

When the addressed agent has an effective `read` tool, the provider contributes this stable system-prompt section:

##### File-reference instruction

```markdown
Tokens prefixed with @ are workspace paths the user explicitly referenced, relative to the workspace root. A trailing slash marks a directory: list it when its contents matter. Anything else is a file: use the read tool when its contents are needed, and do not claim to have inspected it before reading. @"..." quotes a path containing spaces.
```

#### Token effect

Conditional and fixed: the one sentence is present while `read` is visible to the addressed agent; candidate lookup itself adds no tokens, and a selected path contributes only its ordinary user-message characters.

#### KV Cache effect

The stable sentence joins the system-prompt prefix. Mounting or removing this provider, or changing whether `read` is visible, changes that prefix; queries, candidates, and index staleness do not.

## Known Limitations and Deferred Work

- **Host-local namespace** — the provider scans the Harness host filesystem, so remote or virtual `read` implementations require a provider whose namespace matches the tool.
- **Bounded advisory index** — very large workspaces may omit paths after `maxEntries`, and excluded or unreadable descendant directories do not appear. An unreadable workspace root rejects the index so the next query can retry instead of publishing a false empty result.
- **No ignore-file semantics** — `.gitignore` and other project ignore files do not influence discovery; only configured directory basenames are excluded.
