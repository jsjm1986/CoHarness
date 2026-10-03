---
description: "Summarize each top-level turn's changed files from git working-tree snapshots and whole-file captures around file-tool edits, announce them with a workspace/changes Session event, and serve the summary and per-file comparisons across Session release and Host restart; configuration, repository requirement, and coverage rules."
kind: "package-reference"
---

# @deepseek-ai/dsh-workspace-changes

English | [中文](README.zh.md)

The authenticated archive owner calls `removeStored()` only after Session release. It deletes the Session-owned immutable review directory before log removal; ordinary disposal never invokes it.

## Summary

This plugin summarizes each top-level turn’s changed files and preserves their before-and-after comparisons. Git snapshots cover the working tree; whole-file captures cover file-tool edits outside that coverage. Before announcing a `workspace/changes` event, it commits an immutable, Session-owned review under `DSH_HOME/workspace-reviews`. Closing the Session or restarting the Host removes scratch data but preserves the recorded review. The Web card opens that history; ordinary previews still read the current file.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

The shipped Web bundle mounts this plugin. Mount it in any composition with `fs` and `subprocess` providers for the same execution target and a git executable there:

```yaml
- name: '@deepseek-ai/dsh-workspace-changes'
  config:
    maxFiles: 500
```

| Field | Default | Meaning |
|---|---|---|
| `storageRoot` | `DSH_HOME/workspace-reviews` | Private persistent review directory; move existing artifacts under a stopped-writers maintenance window when changing it |
| `maxReviewBytes` | `67108864` | Maximum serialized bytes per review; read and publication limits, and required free-space reserve before execution |
| `timeoutMs` | `30000` | Milliseconds one git command may run before recording fails and the turn stops |
| `outputMaxBytes` | `8388608` | Bytes of git output retained per command; a larger diff listing fails recording and stops the turn |
| `maxFiles` | `500` | Maximum files carried by one summary; `total` still reports the complete count |
| `maxFileBytes` | `2097152` | Bytes a file may hold to be captured around a file-tool edit or read from a snapshot for its comparison; a larger file gets no comparison, and one captured around a file-tool edit is also listed without counts |
| `diffTimeoutMs` | `100` | Milliseconds a line comparison may run before it degrades to whole-file replacement |

Every Session with a working directory and no subagent origin is recorded; subagent Sessions are not. Snapshots are written through a private index into a temporary object directory owned by the Session, with the repository's own object store attached as a read-only alternate; the repository's index, objects, work tree, and refs stay untouched, and the user's earlier uncommitted changes never enter a summary. Session disposal removes the directory. Nested repositories and submodules inside the working directory are recorded as gitlinks, so their internal changes do not appear. A working directory outside any git repository takes no snapshots. Without git — or, on macOS, with only the developer-tools stub at `/usr/bin/git` — no repository is located either, and the plugin logs that once. Either way the summary lists the file-tool edits alone, as described next, with the working directory as the workspace; shell edits are absent.

Before a `write`, `edit`, or mutating `str_replace_editor` call runs, the recorder copies the file at its path into the Session's temporary directory, once per path per turn, and copies it again at turn end; the copies are named by the SHA-1 of their bytes, so identical content is stored once. This needs no git. Paths the snapshots cover keep their git counts; the copies serve the other paths — files matching an ignore pattern, files outside the repository, and every file-tool edit when there is no snapshot — with counts from a line comparison of the two copies, so repeated edits to one file count once and a shell edit after a file-tool edit is included. A path whose content is unchanged at turn end is not listed. A copy larger than `maxFileBytes` is not stored: the file is listed with `oversized` and no counts, and a path whose both sides are that large is listed too, since unread content is never known to be unchanged. A path whose only difference is a missing final newline compares as unchanged, while git still counts that line. Files under `/tmp` or the platform temporary directory are excluded unless they lie inside the repository. Changes made only through shell commands outside the snapshot coverage are not recorded.

For SSH workspaces, Git, private indexes and snapshot objects belong to the remote execution target. File captures use bounded, version-checked `fs` reads. The complete comparison is copied to Host-owned durable storage before its announcement; later remote edits or recorder disposal cannot change it. Remote scratch cleanup still finishes before releasing the connection, and an unreachable target reports cleanup failure.

Each file carries its recorded `path` and sortable `display` label. Paths inside the working directory remain relative; labels may use `../`, `~`, or absolute paths outside it. `await ctx.workspaceChanges.summary(sessionId, seq)` resolves the announcement through the live recorder or a bounded persisted event read. `diff(sessionId, seq, index, signal)` serves the stored text hunks, `binary`, or `oversized` result at the original file index. Text comparisons retain three context lines and mark timeout-driven whole-file replacement as `coarse`. Reads verify the content digest, Session owner, and summary-to-diff indices; the authenticated RPC separately rechecks Session and path access.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

Each Session’s `TurnRecorder` serializes baseline snapshots, file-tool captures and turn-end recording. Git uses a private index and object directory with the repository object store as a read-only alternate. The user’s earlier uncommitted changes stay outside the turn’s diff. The recorder computes bounded comparisons before publication, writes and syncs the immutable artifact, then appends its content identity to the Session log. The durable review root is excluded from local Git snapshots with literal path matching, so saved reviews do not become new workspace changes. Historical reads need neither an active Agent nor current file contents.

Git uses the selected `subprocess` provider, a scrubbed environment, `GIT_CONFIG_COUNT=0`, `GIT_TERMINAL_PROMPT=0`, `GIT_OPTIONAL_LOCKS=0`, configured timeouts and bounded output. Recording or storage failure appends an incomplete announcement, stops the affected turn and blocks later work until a new request passes the storage probe. A recorded capacity requirement must fit the new limit; the filesystem must have room for a maximum-size review. Already executed file effects are not rolled back. Replacing the recorder during an open turn refuses further execution until a new turn can capture its own baseline. Disposal removes temporary Git objects and captures, not durable reviews.

**Runtime invariant:** No companion is published. Artifact reads enforce their Session owner, content digest and file-index relation before returning data; a separate scan would repeat that acceptance check without observing another production authority.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Web deliverables](../../client/ui-deliverables/README.md) — the changed-files card that reads the served summary and opens its files.
- [Subprocess capability](../../subprocess/README.md) — the seam git runs through.
- [Turn changed-files card decision](../../../.agents/notes/implemented/architecture/2026-09-23-authorized-workspace-review.md) — snapshot design, coverage rules, the deferred shadow repository, and rejected alternatives.

<a id="model-experience"></a>
## Model Experience

Indirectly, through the agent loop and tool pipeline, recording failures stop execution with logged errors. Historical comparisons remain client-only; this package adds no prompts or tool schemas.

#### KV Cache effect

Normal review data adds no model input. A logged recording error can change subsequent error context.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Managed launches with `DSH_MANAGED_DATA_MANIFEST` register the configured durable review root before data writes. Temporary local or SSH capture directories are not claimed. An invalid inventory refuses initialization; [inventory and backup rules](../../util/managed-data/README.md) govern retained roots and deployment approval.
- Historical announcements created before durable review storage may have no surviving content. The UI reports unavailable history and offers a read retry; it never reconstructs a past comparison from current files.
- Two git features still write into the repository's own git directory during a snapshot: `core.splitIndex` writes `sharedindex.*` files, and git-lfs runs its clean filter on changed files and stores their objects under `.git/lfs`.
- git 2.13 or later is required for `rev-parse --absolute-git-dir`; an unsupported repository format or another Git failure stops recording and the affected turn instead of treating it as a plain directory.
- The first snapshot of a Session writes every untracked, non-ignored file of the work tree into the Session's temporary directory; a repository without a `.gitignore` that carries large build outputs costs that much temporary space until the Session is disposed.
- Edits the user makes during a turn are attributed to that turn.
- A working directory outside any git repository lists file-tool edits only, so shell edits are missing from its card; a shadow repository under the Harness home is deferred until its exclude rules can replace a missing `.gitignore` reliably.
- Outside snapshot coverage only paths a file tool names are captured: a file only a shell command changes there is absent, and a file both changed before its first file-tool call is compared from that call onward.
- Every file-tool edit copies its whole file once per turn, up to `maxFileBytes`, even for paths the snapshots also cover; the copies go with the Session's temporary directory.
- A comparison serves the listed file's complete text to the client, including ignored files, repository files above the working directory, and files outside the workspace; the summary route serves only paths and counts. A deployment that must keep such content on the Host composes this plugin out.
- A comparison that degrades to whole-file replacement carries every line of both sides, up to twice `maxFileBytes`.
- Windows paths keep native separators in `path`; `display` is always slash-separated.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
