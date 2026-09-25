# Agent Note: Principal-owned Workbench layouts

Status: implemented

English | [中文](2026-09-23-principal-owned-workbench-layouts.zh.md)

## Problem

Separate browser records for the viewport and named Workbenches can disagree about the active pane and ratios. Unscoped records also expose private layout names and Session references when another account uses the same origin.

## Decision

The conversation viewport owns one versioned record per verified principal. The Workbench presentation package exposes no separate persistence writer. Account-catalog parsing validates optional event sequences and prompt timestamps before those fields affect restoration or sorting. Each named layout contains its pane ids, active pane, and ratios; the document contains the selected layout and presentation mode. The root store holds only current in-memory state. Identity loss clears layouts and staged references before another identity can restore its own record. Restored panes must pass current catalog visibility before staging. A refused pane replacement aborts navigation before the active Session changes; the browser keeps the existing view and reports the refusal.

A Host must explicitly declare independent local execution before the local principal is usable. Missing Gateway identity never selects that principal. Only the independent local operator may migrate legacy unscoped metadata, after the Session catalog is ready and inaccessible references have been removed. Gateway leaves those records unclaimed because their previous account cannot be proven. Storage denial keeps the current in-memory layout usable.

The [Workbench sidebar decision](../feature/2026-09-17-workbench-sidebar-panel.md) remains active for pane navigation and narrow-pane rendering. The [auxiliary sidebar decision](2026-09-23-account-scoped-auxiliary-sidebar.md) owns resource-tab persistence and holds; it does not own the center Workbench layout.

## Alternatives considered

**Keep two records.** Partial writes and independent restoration can select different active panes or discard manual ratios.

**Assign legacy metadata to the next login.** A visible shared Session does not prove ownership of private layout names.

## Consequences

Parsing rejects malformed records before Session resources are requested. Tests cover account changes, proof loss, storage denial, corrupt metadata, legacy visibility checks, active-pane restoration, and ratio preservation. Browser restoration still depends on available Session and project catalogs; persisted ids alone never authorize history access.
