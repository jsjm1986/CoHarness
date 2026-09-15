# Agent Note: Document list select-all lives in the caption row

Status: implemented

English | [中文](2026-09-15-doc-list-header-orphan-row.zh.md)

## Problem

`DocumentsModal` rendered a dedicated `listHeader` band holding only the page select-all checkbox: a full-width bordered row with one unchecked box and no label, which read as a broken empty row between the scope caption and the first date group.

## Decision

The select-all checkbox sits inside the existing `.caption` line, ahead of the scope label and the document count. That line is already the list's header — hidden with the list under overview and trash panels — so the checkbox keeps the same visibility rules with no separate band. Workbench menu actions carry the same leading-icon convention as the session row menus, and the Session-log export capsule's zh label is translated (`Session 日志`).

## Alternatives considered

**Keep the band and label it.** Rejected: a second header row under the caption duplicates structure for one control; the admin archive table shows the same pattern of the select-all living inside an already-labeled header.

## Consequences

One less row in the document list; selection state and the `selectPage` aria-label are unchanged, so batch selection tests keep working.

## Verification

`packages/client/ui-documents/tests/components.client.spec.tsx` exercises the select-all checkbox through its `selection.selectPage` role query. Confirmed in the deployed build: no `listHeader` element renders, and the checkbox aligns with the per-row checkboxes below it.
