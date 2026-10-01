---
description: "Record the local files and dedicated data directories a storage provider owns so deployment backups can select and verify them."
kind: "package-library"
---

# @deepseek-ai/dsh-managed-data

English | [中文](README.zh.md)

## Summary

Storage providers use this library to record the actual files and dedicated data directories they own before writing them. Gateway backup collection reads these records together with database-confirmed runtime identity and node-administrator approvals. `registerManagedDataPath()` appends a durable claim; `readManagedDataPaths()` reads current and earlier claims. Registration records ownership metadata, not file contents or permission grants.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="use-this-package"></a>
## Use this package

Pass an actual resolved file or dedicated data-directory path, its owning package and an absolute inventory filename to `registerManagedDataPath()`. The caller supplies the destination explicitly; an absent destination performs no registration. Gateway-managed launches supply it through `DSH_MANAGED_DATA_MANIFEST`. Call registration before creating or changing the provider's data. A malformed or unreadable inventory rejects that operation without replacing its original bytes.

Records are append-only JSONL with `version: 1`, `owner`, `kind` (`file` or `directory`) and an absolute `path`. `readManagedDataPaths()` retains earlier roots after configuration changes and deduplicates repeated claims. Unchanged registration does not append a record. A missing inventory is an error when reading for backup, not evidence of an empty runtime. The exact callable interfaces are documented in [the source](src/index.ts).

Deployment consumers must verify runtime identity, stop writers, exclude project source and SSH workspaces, reject escaping links and verify the copied bytes. Registration alone never authorizes deleting source data.

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals</summary>

Descriptor identity checks reject replacement files between validation and access. Reads remain bounded if the inventory grows concurrently; the 16 MiB limit applies to ownership metadata, not application files. Malformed, incomplete, oversized and link-shaped inventories fail. File flush and POSIX directory flush precede successful registration.

**Runtime invariant:** No companion is published. This library validates its persisted records on each read; providers own the data and lifecycle, and an inventory path may legitimately precede file creation.

</details>

<a id="further-exploration"></a>
## Further Exploration

- [Gateway maintenance and restore](../../../gateway/README.md) defines approved-root selection, historical adoption and complete backup verification.
- [Deployment maintenance decision](../../../.agents/notes/implemented/architecture/2026-09-25-gateway-deployment-maintenance.md) records writer exclusion and recovery rules.

<a id="model-experience"></a>
## Model Experience

None, as inventory records are deployment metadata and do not enter model requests or Session transcripts.

#### KV Cache effect

No direct effect on model request prefixes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Only declared storage is represented. A third-party provider must register its data paths before claiming backup coverage.
- The inventory does not traverse SSH filesystems or own external programs' caches. Deployment approval and data transfer remain the consumer's responsibilities.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
