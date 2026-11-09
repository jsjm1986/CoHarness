# Agent Note: Admin archive channel and Gateway lifecycle index

Status: implemented

English | [中文](2026-08-25-admin-archive-channel.zh.md)

## Problem

Runtime archive membership was stored only in each Workspace registry. The regular Web client intentionally hid those sessions; its only restore surface is the per-user Archived sessions Settings page ([the unarchive restore-surface note](2026-09-25-session-unarchive-restore-surface.md)), which cannot find, inspect, or retire archived conversations across personal and project runtimes — the organization-scoped gap this channel owns.

## Decision

**Gateway owns an organization-scoped archive lifecycle index while each runtime retains the local Workspace projection.** The Admin SPA exposes a root-conversation archive channel with server-side filters, a paged event reader, export, batch restore, a 30-day configurable trash window, and explicit purge. Runtime snapshots carry a monotonic revision and retained Workspace placement; Gateway commands remain pending until the owning runtime acknowledges them. Project transcripts are read from PostgreSQL; personal transcripts are read by starting their runtime on demand.

The index keeps a root record even when a personal transcript is not present in PostgreSQL, so legacy JSONL runtimes can backfill metadata without copying full logs. Each record carries an immutable runtime identity: a snapshot locks the claimed row `FOR UPDATE`, validates the declared lineage against owned sessions, and leaves a same-owner newer revision untouched while rejecting any foreign claim. Search stores only title, Session ID, and user/assistant text. Administrator reads, exports, and mutations write audit events without storing message content in the audit row.

Administrative lifecycle mutations lock the active organization and authenticated administrator account and membership before archive or command rows, retaining qualification until commit. Idempotent returns require the same current qualification. This separates accepted pending commands from unaccepted requests whose administrator was revoked while waiting; runtime acknowledgements and trusted maintenance retain their existing ownership.

Administrator reads retain active organization, account and membership through each database read. Personal Runtime I/O runs after releasing that client and retains the real administrator through queued startup, the purpose-scoped read principal and a generation-specific operation lease. Read completion rechecks current qualification even after Runtime failure; indexed fallback data cannot bypass withdrawal. This keeps slow or offline Runtimes from retaining database authority locks while preventing an admitted request from disclosing data after its administrator loses qualification.

Mixed shared and node-volume archive pages and empty-draft batches reuse their caller's governance transaction. The shared archive service borrows that client without beginning, committing or releasing it; node-volume queries retain their separate content transaction. No nested governance checkout is needed while placement and administrator locks are held. A full pool therefore cannot make these operations wait for their own connections. Shared and node-local pagination and draft eligibility checks retain their existing semantics.

## Alternatives considered

**Scanning runtime `workspace.json` from Admin.** Rejected: runtimes can be offline or run under separate users and project accounts, and filesystem paths are not a stable organization API.

**Copying every transcript into PostgreSQL.** Rejected: it duplicates personal storage and expands the privacy and retention surface; on-demand runtime reads preserve the existing persistence owner.

**Removing archive IDs without a revisioned snapshot.** Rejected: the existing append-only client merge would allow an older carrier to re-hide or resurrect a row; restore requires an explicit revision/reset protocol.

## Consequences

The Gateway migration adds archive records, searchable personal-runtime projections, and a retryable command ledger. Purge removes project conversation rows and asks the runtime persistence provider to remove personal or project artifacts; a tombstone and audit trail remain. Standalone local DSH compositions keep the existing archive behavior and are outside the organization Admin index.
