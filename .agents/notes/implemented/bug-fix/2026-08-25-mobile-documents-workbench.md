# Agent Note: Compact document workbench uses task-focused sheets

Status: implemented

English | [中文](2026-08-25-mobile-documents-workbench.zh.md)

## Problem

The document manager compressed its desktop scope rail, filter controls, and five row actions into phone widths. Short viewports could place controls outside the visible card, while a horizontal scope strip and inline destructive actions made navigation and permission state difficult to understand.

## Decision

The document plugin keeps the desktop workbench unchanged and presents a separate compact information hierarchy below the 768px breakpoint. A current-scope trigger opens a local-search scope sheet. Upload remains the primary toolbar action; filters, history, refresh, folder creation, and alternate-source browsing are in one More sheet. Document and folder rows expose one More control, and multi-selection uses a safe-area-aware batch bar followed by a batch sheet.

`DocumentsMobileSheet` is an internal presenter over the existing `Modal` primitive. It is mounted only while a compact surface is open, uses the existing portal and dialog focus behavior, and closes before an existing preview, move, copy, or delete dialog opens. No document endpoint, permission rule, pagination rule, or public component prop changes.

The compact workbench has one list scrollport. Sheet searches and filters are local operations, and row action controls are not rendered until their sheet opens. A shared media-query subscription selects the compact action tree; no per-row observers, polling, virtualization, or additional network requests are introduced.

## Alternatives considered

**Keep the horizontal scope rail and wrap row buttons.** Rejected because wrapping preserves desktop information density, hides the operation priority, and still allows long names and destructive controls to compete for a 320px row.

**Extend the global `Menu` primitive with document-specific headers and forms.** Rejected because scope search and filter controls need a titled, scrollable dialog, and a global API expansion would increase the blast radius for a document-only requirement.

**Add a mobile-only backend listing or pagination endpoint.** Rejected because the existing page-sized client list is sufficient for the compact presentation; adding a route would increase latency and create a second permission path without improving the interaction.

## Consequences

Phone users get stable touch targets, explicit read-only states, and predictable layering at the cost of one extra tap for row operations. Desktop users retain the established rail and inline action order. Opening a sheet and typing a filter perform no network work; only an intentional scope or document operation invokes the existing client methods.

## Verification

Component tests cover compact scope search, row action routing, preview handoff, and batch permissions. Keyless Web e2e snapshots cover the compact manager, scope sheet, document action sheet, and batch sheet at phone widths; geometry assertions cover dialog bounds, touch targets, and horizontal overflow. The compact visual audit captures 390px, 375px, and 320px layouts and the dark-token review remains part of the browser lane.
