# Agent Note: Recover a document catalog's acknowledged prefix

Status: implemented

English | [中文](2026-11-21-document-catalog-recovery-gap.zh.md)

## Problem

The document store compacts a journal prefix once the catalog confirms it. An older catalog can lose those records while the corresponding document files remain intact. The upload client needs a durable recovery error for this condition so callers can distinguish it from an interrupted delivery.

## Decision

The [local journal](../../../../packages/attachment/userdoc-local/src/projection.ts) reports the exact identity root, receiver cursor, locally acknowledged cursor and local head when the receiver needs records from a compacted prefix. The [Gateway](../../../../gateway/src/documents-local.ts) keeps these coordinates in the operator log and sends a stable recovery error to authorized upload callers. It refuses new upload allocations for the affected open scope after detection. A later delivery with verified history clears the refusal.

## Alternatives considered

**Advance the catalog cursor.** This would skip lifecycle changes that carry creator, initiator and ownership evidence.

**Rebuild the catalog from current files.** A current file list lacks the earlier incarnations, ownership transfers and trash decisions needed to recover their history.

**Read the catalog before starting every upload.** The additional network request would affect all healthy scopes. The admission check reuses the failure already established during ordinary delivery.

## Consequences

Existing upload manifests, files and retained journal records survive the refusal. Downloads still use current authorization and filesystem identity. The document manager keeps the completed files visible and asks the user to contact an administrator before continuing. Recovery requires the missing records for the same root. Once those records are available, confirmation of the same upload can finish through ordinary delivery.
