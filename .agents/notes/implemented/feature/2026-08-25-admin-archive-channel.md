# Agent Note: Admin archive channel and Gateway lifecycle index

Status: implemented

English | [中文](2026-08-25-admin-archive-channel.zh.md)

## Problem

Runtime archive membership was stored only in each Workspace registry. The regular Web client intentionally hid those sessions and offered no recovery or administration surface, so an organization administrator could not find, inspect, restore, or retire archived conversations across personal and project runtimes.

## Decision

**Gateway owns an organization-scoped archive lifecycle index while each runtime retains the local Workspace projection.** The Admin SPA exposes a root-conversation archive channel with server-side filters, a paged event reader, export, batch restore, a 30-day configurable trash window, and explicit purge. Runtime snapshots carry a monotonic revision and retained Workspace placement; Gateway commands remain pending until the owning runtime acknowledges them. Project transcripts are read from PostgreSQL; personal transcripts are read by starting their runtime on demand.

The index keeps a root record even when a personal transcript is not present in PostgreSQL, so legacy JSONL runtimes can backfill metadata without copying full logs. Search stores only title, Session ID, and user/assistant text. Administrator reads, exports, and mutations write audit events without storing message content in the audit row.

## Alternatives considered

**Scanning runtime `workspace.json` from Admin.** Rejected: runtimes can be offline or run under separate users and project accounts, and filesystem paths are not a stable organization API.

**Copying every transcript into PostgreSQL.** Rejected: it duplicates personal storage and expands the privacy and retention surface; on-demand runtime reads preserve the existing persistence owner.

**Removing archive IDs without a revisioned snapshot.** Rejected: the existing append-only client merge would allow an older carrier to re-hide or resurrect a row; restore requires an explicit revision/reset protocol.

## Consequences

The Gateway migration adds archive records, searchable personal-runtime projections, and a retryable command ledger. Purge removes project conversation rows and asks the runtime persistence provider to remove personal or project artifacts; a tombstone and audit trail remain. Standalone local DSH compositions keep the existing archive behavior and are outside the organization Admin index.
