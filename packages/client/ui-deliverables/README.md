# @deepseek-ai/dsh-client-ui-deliverables

English | [中文](README.zh.md)

## Summary

The Web turn tail shows recorded workspace changes and explicit file deliveries. Each changed-file row opens its historical comparison in the shared right sidebar; delivery cards open current files through the existing authorized Workspace preview. Turns without either event retain their successful-mutation file chips. Exact paths and unique basenames in closing prose link to produced or delivered files. The Host half contributes file-reference guidance.

## Historical review and current files

The [workspace recorder](../../deliverables/workspace-changes/README.md) announces summaries with `workspace/changes`; the [present tool](../../deliverables/tool-present/README.md) records `deliverables/presented`. `deliverablesDefinition` folds these events into turn data without scanning conversation history. Mutation-location fallback retains support for tools that declare diff or edit render intent.

Review shows one file at a time with unified or side-by-side hunks, line wrapping, creation/deletion facts, and explicit binary or oversized states. Comparisons read the recorded turn snapshots, not current file contents. The renderer limits visible comparison lines and reports truncation. A separate preview action reads the current file. A disposed or restarted recorder yields an unavailable historical comparison rather than reconstructing one from current files.

Reads use the Session's runtime connection and ApiProxy authorization. The Host checks Session access and recorded paths before and after asynchronous reads. Client readers belong to the retained Session, discard cached results on connection replacement, and abort on disposal. A review resource must declare the same Session as its sidebar. Hidden tabs do not initiate comparisons.

Delivery cards preserve file descriptions and provide preview, default-application, and containing-directory actions. Native actions require an explicitly independent local Host, base runtime, loopback access, and an available desktop opener. Gateway users receive authorized previews without access to the server desktop. The directory action opens the containing folder; it does not promise platform-specific file selection.

## Invariants

No companion is published: the UI projects durable events and authorized read results; the recorder and resource services own the file relationships.


## Further Exploration

- [Authorized review decision](../../../.agents/notes/implemented/architecture/2026-09-23-authorized-workspace-review.md)
- [Workspace resources](../../../.agents/notes/implemented/feature/2026-09-12-cloud-workspace-file-resources.md)

## Model Experience

### File-reference guidance

#### What the model sees

A static system-prompt section asks the model to name primary outputs and link every mention of an existing file to its working-directory-relative or absolute path. Link labels use filenames or concise aliases, with optional line locations. Legacy inline-code references still resolve exact paths and unique basenames. The `present` tool independently owns the delivery schema and result text.

#### Token effect

One fixed guidance paragraph while the Web plugin is mounted. Summary and comparison data stay outside model requests.

#### KV Cache effect

The guidance remains unchanged throughout the plugin lifetime and is reusable across turns.

## Known Limitations and Deferred Work

- Historical comparisons live only as long as the Host recorder. The Session event remains durable after its comparison is unavailable.
- Inline-code matching accepts exact paths and unambiguous basenames; it does not guess path suffixes or files named only in prose.
- The recorder currently captures local execution. Remote execution needs a recorder using the same remote filesystem and subprocess target.
