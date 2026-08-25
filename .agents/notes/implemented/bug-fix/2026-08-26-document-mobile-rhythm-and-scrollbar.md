# Agent Note: Document mobile rhythm and shared scrollbar geometry

Status: implemented

English | [中文](2026-08-26-document-mobile-rhythm-and-scrollbar.zh.md)

## Problem

The document manager's compact workbench mixed the generic modal spacing with a feature-owned sheet header, so phone layouts showed duplicate drag affordances, uneven text baselines, oversized rows, and more than one apparent scroll surface. The shared WebKit scrollbar was also wider than the document layout needed, while card-internal thumb insets assumed the old width.

## Decision

The document manager keeps the existing Modal portal, bottom-sheet interaction, focus behavior, scope state, and document operations. Its compact presenter owns one title row and one scrollport per sheet, and the manager keeps one primary document-list scrollport. Folder and document rows use the same mobile grid so names and metadata share a start line; visual labels use compact localized text while accessible names retain the complete operation.

The theme's WebKit scrollbar is 4px wide and high, and `--dsh-scrollbar-width` remains the geometry value consumed by surfaces that compensate for a space-consuming bar. Card-internal WebKit thumbs use the shared 1px transparent inset so the colored interior remains visible. Workspace and conversation geometry tests measure the shared value rather than carrying a second width.

No document endpoint, permission rule, upload protocol, pagination rule, or public component prop changes. Compact filtering and sheet navigation remain local operations; opening them does not add a request, observer, or polling loop.

## Alternatives considered

**Keep the feature-owned drag handle beside Modal's handle.** Rejected because two identical affordances consume vertical space and make the sheet header look like two nested surfaces.

**Hide the phone scrollbar or style it only inside the document package.** Rejected because hiding removes the primary continuation cue, while per-package pseudo-element rules would split the theme authority and leave other scroll consumers on the old geometry.

**Use a separate phone row interaction such as swipe actions or whole-card preview.** Rejected because it would introduce gesture state and conflict with batch selection, folder navigation, and read-only permissions.

## Consequences

Phone users get denser, aligned rows, a single predictable scroll area, and shorter controls that fit narrow widths without losing accessible names. Desktop keeps the existing scope rail and inline operations while sharing the same typography hierarchy. A 4px scrollbar reduces visible and reserved width across the client; the shared width and thumb-inset consumers, sidebar geometry, composer compensation, and browser goldens therefore change together.

## Verification

Component and stylesheet tests pin the one-handle presenter, mobile grid, compact type roles, localized metadata, shared scrollbar values, and custom-thumb inset. Keyless Web e2e covers document manager sheets at narrow phone widths, dark/light palettes, scope permissions, and no horizontal overflow. Sidebar and composer geometry e2e cover the 4px shared bar and its compensation consumers.
