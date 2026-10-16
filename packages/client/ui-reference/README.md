---
description: "Unified Web @file and @session reference source"
kind: "package-reference"
---

# `@deepseek-ai/dsh-client-ui-reference`

English | [中文](README.zh.md)

Unified Web `@file` and `@session` source. Each candidate request retains the browsing Client Session through completion and waits for its initial history open before starting the `fileReferences/list` and `sessionReferenceResolver/candidates` Remote calls, which then run together for an unquoted token; a session that is not already bound fails the query rather than reopening it, and either failed candidate domain degrades independently. Rows order files before sessions and the browsing session's direct subagents above ordinary sessions, rendered under non-selectable section headings without a redundant raw `reference` source title. A row carries only what distinguishes it: a file names its parent directory unless a drilled listing's breadcrumb already does, and a session names its workspace only when it is not the current one. Session rows carry the session list's relative activity age, falling back to the candidate's creation time when the list does not carry that session. An open `@"…` token searches files only.

File picks preserve the natural text defined by the shared `@path` grammar as their hidden serialized and clipboard form. A file closes completion as an atomic inline reference displayed with a file glyph, business-color filename, and no capsule. A directory settles as an atomic folder reference on an ordinary pick; its explicit drill action (Tab, the row chevron, or a breadcrumb) instead replaces the token with editable path text and keeps the menu active at its trailing slash. Drilled listings publish a reversible workspace breadcrumb. Paths containing whitespace use `@"path with spaces"`, and a quote the user opened explicitly remains quoted.

Session picks insert an atomic inline reference whose hidden `ref` and clipboard representation are the canonical `@[label](dsh-session:…)` mention returned by the Host. Its visible form is a chat-bubble glyph plus the business-color session title, without a capsule; serialization never reconstructs identity from that title. Ordinary send carries the canonical mention through `session.prompt`; the session-reference service validates it and captures model context at `agent/pre-step`.

The `/client` export is the plugin body (`apply`/`inject`) only; candidate encoding stays internal to the registration effect.

## Summary

Use `dsh-client-ui-reference` when Web users need to mention files, folders, or sessions from one `@` completion menu. Each request retains the browsing session through its initial history open rather than reopening released sessions. The menu lists files, then the session's direct subagents, then other sessions, keeping either group available when the other cannot load. Rows carry distinguishing detail — parent directory, foreign workspace, relative activity age. A pick inserts an atomic reference with a stable clipboard form; folder rows also let users descend without closing completion. Session mentions are validated before model context is captured; browsing has no model effect.

## Table of Contents

- [Invariants](#invariants)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="invariants"></a>
## Invariants

**Runtime invariant:** No companion is published. Candidates are fetched per token through the `fileReferences/list` and `sessionReferenceResolver/candidates` remotes under a short-lived `referenceCandidates` Session reference; the source keeps no candidate state between requests.

<a id="model-experience"></a>
## Model Experience

Indirectly, through Host-owned providers, which own the file guidance and session snapshot preparation this package's reference selection delegates to them.

#### KV Cache effect

Candidate browsing has no model effect. A selected file or session changes only the new user-message suffix and any Host-prepared session-reference context that follows that message; earlier target history remains unchanged.

## Known Limitations and Deferred Work

- **Candidate failure is intentionally quiet** — one unavailable or failed Remote discovery call yields no rows for that domain. A session-reference preparation failure occurs after prompt acceptance and terminates that agent turn.
- **No browser-side file scan** — Web completion requires a mounted Host `ctx.fileReferences` provider; the browser cannot fall back to its own filesystem.
- **Session search remains metadata-only** — discovery filters session id, cwd, and the latest log-backed title through `ctx.sessionReferenceResolver`; message bodies and full transcripts are not searched.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
