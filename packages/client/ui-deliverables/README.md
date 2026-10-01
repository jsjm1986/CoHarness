---
description: "Produced-files turn tail and clickable final-response file references for Web"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-deliverables

English | [中文](README.zh.md)

## Summary

The Web turn tail shows recorded workspace changes and explicit file deliveries. Each changed-file row opens its historical comparison in the shared right sidebar; delivery cards open current files through the existing authorized Workspace preview. Turns without either event retain their successful-mutation file chips. Exact paths and unique basenames in closing prose link to produced or delivered files. The Host half contributes file-reference guidance.

## Table of Contents

- [Historical review and current files](#historical-review-and-current-files)
- [Invariants](#invariants)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="historical-review-and-current-files"></a>
## Historical review and current files

The [workspace recorder](../../deliverables/workspace-changes/README.md) announces summaries with `workspace/changes`; the [present tool](../../deliverables/tool-present/README.md) records `deliverables/presented`. `deliverablesDefinition` folds these events into turn data without scanning conversation history. Mutation-location fallback retains support for tools that declare diff or edit render intent.

Review shows one file at a time with unified or side-by-side hunks, line wrapping, creation/deletion facts, and explicit binary or oversized states. Comparisons read the recorded turn snapshots, not current file contents. The renderer limits visible comparison lines and reports truncation. A separate preview action reads the current file. Completed comparisons survive recorder release and Host restart. Missing older history displays an unavailable status with an explicit retry; a failed recording displays an incomplete status without implying zero changes.

Reads use the Session's runtime connection and ApiProxy authorization. The Host checks Session access and recorded paths before and after asynchronous reads. Client readers belong to the retained Session, discard cached results on connection replacement, and abort on disposal. A review resource must declare the same Session as its sidebar. Hidden tabs do not initiate comparisons.

Delivery cards preserve file descriptions and provide preview, default-application, registered-application, and file-manager actions. The menu re-queries `host.fileApplications` on each open so a handler installed after delivery still appears; the Host revalidates a chosen id against current handlers, so a stale row fails instead of silently opening the default. Native actions require an explicitly independent local Host, base runtime, loopback access, and an available desktop opener. Gateway users receive authorized previews without access to the server desktop. The manager action reveals the file on macOS/Windows and opens its containing folder on Linux, where no selection API exists.

<a id="invariants"></a>
## Invariants

No companion is published: the UI projects durable events and authorized read results; the recorder and resource services own the file relationships.


<a id="further-exploration"></a>
## Further Exploration

- [Authorized review decision](../../../.agents/notes/implemented/architecture/2026-09-23-authorized-workspace-review.md)
- [Workspace resources](../../../.agents/notes/implemented/feature/2026-09-12-cloud-workspace-file-resources.md)

<a id="model-experience"></a>
## Model Experience

### File-reference guidance

#### What the model sees

A static system-prompt section asks the model to name primary outputs and link every mention of an existing file to its working-directory-relative or absolute path. Link labels use filenames or concise aliases, with optional line locations. Legacy inline-code references still resolve exact paths and unique basenames. The `present` tool independently owns the delivery schema and result text.

#### Token effect

One fixed guidance paragraph while the Web plugin is mounted. Summary and comparison data stay outside model requests.

#### KV Cache effect

The guidance remains unchanged throughout the plugin lifetime and is reusable across turns.

## Known Limitations and Deferred Work

- History created before durable review storage may retain an announcement without its comparison. Current files cannot reconstruct that history.
- Inline-code matching accepts exact paths and unambiguous basenames; it does not guess path suffixes or files named only in prose.
- The recorder currently captures local execution. Remote execution needs a recorder using the same remote filesystem and subprocess target.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
