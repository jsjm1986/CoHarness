# Agent Note: Archive records have stable identities within Runtime namespaces

Status: implemented

English | [中文](2026-10-30-archive-runtime-namespace.zh.md)

## Problem

Host Session identifiers are local to a Runtime. A shared Gateway database and administrator reader need to distinguish equal Host IDs without changing logs or allowing another Runtime to claim their data. Root-only keys also couple search, pending commands, file cleanup and browser selection to the wrong record.

## Decision

Each archive has a branded, opaque UUID `archiveId`. PostgreSQL assigns it once and retains the unique organization/Runtime/Host-root tuple. Search, commands and file-cleanup tasks reference the archive; search event identity also includes its Runtime. The migration preserves recorded assignments and unassigned history. Creating a Runtime cannot adopt unassigned archive data.

Administrator reads and actions use the [record-addressed API](../../../../docs/upgrade-guide/v0.2.1-rc.1.coharness.1/archive-administration-authority/guide.md). The original Host root remains the Runtime read/command argument. Session fallback reads and destructive SQL require the archive's recorded Runtime; an unassigned legacy record additionally requires its recorded project or personal creator. Browser selection, polling, detail responses and exports use the opaque archive identity. Idempotent retries retain the selected computer and current administrator qualification.

Draft reservations use the existing canonical Session for lifecycle checks and lock its root before locking reservation rows. An archived root needs an explicit restoration before reservation; a concurrent reservation release requires a new attempt. Empty-draft cleanup uses the restoration time as well as Session activity, preserving the administrator’s restored work until it is old enough for the confirmed cutoff.

## Alternatives considered

**Rewrite Host IDs or Session logs.** Rejected: Runtime-local logs and immutable generations retain their producer identity.

**Treat an organization-wide Host ID match as ownership.** Rejected: independently copied or generated histories can share an identifier. A matching name cannot establish authority to read, reassign or delete another Runtime's data.

## Consequences

Custom administrator clients upgrade with the Gateway and bundled UI. Legacy root routes refuse rather than interpreting a Host UUID as an archive UUID. Runtime snapshot and command payloads keep their Host IDs. Migration preservation, concurrent same-Runtime projection, same-name cross-Runtime actions, late browser responses and purge isolation require real database and assembled HTTP verification. Logical computer fixtures do not establish physical multi-host startup or model-provider acceptance.
