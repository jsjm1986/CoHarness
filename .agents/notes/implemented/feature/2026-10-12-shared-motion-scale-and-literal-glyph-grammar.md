# Agent Note: Shared motion scale and literal-glyph grammar across client surfaces

Status: implemented

English | [中文](2026-10-12-shared-motion-scale-and-literal-glyph-grammar.zh.md)

## Problem

The web client grew surface-local visual dialects: each feature family picked its own transition durations and easings, icons were chosen as loose metaphors (a share arrow for a project space, a generic glyph for archived sessions), chrome stacked into multi-row headers, and secondary surfaces drew bordered banners and OS-native selects the shared vocabulary did not sanction. Aesthetic drift compounded per surface, and every new contributor inherited inconsistency rather than a system.

## Decision

The client converges on one design grammar with three named vocabularies, each owned centrally and applied per surface.

- **The motion scale is tokenized, not per-surface.** `--dsw-motion-duration-*` and `--dsw-motion-ease-*` live on `base.css`; menus, modals, disclosure rows, the composer, sidebar rows, settings, message actions, workbench surfaces, and shared primitives all consume the scale. Popovers enter with a directional scale-fade, cards and docks rise on mount, and interactive rows, pills, tabs, and switches share hover/active transitions — every one gated by `prefers-reduced-motion`. Motion never moves layout: entrances animate opacity and transform inside already-reserved geometry.
- **Icons name the channel, not a metaphor.** Glyph choices read literally: a project space is `Users` (its personal counterpart is `User`), the reserved steward space is `Shield` (the same glyph the dock notice carries), archived sessions get their own nav glyph, and weak metaphors were remapped to the literal channel each control actually opens. New controls pick the glyph that names the thing acted on; when none exists, extend the `ui-primitives` ic_ds_ table rather than re-purposing an unrelated action icon.
- **Chrome quiets into shared geometry.** The session header flattens to a single non-wrapping row; the session-log export card and command leave the web composition; documents notices become tinted bars without hairline boxes; selects drop the OS arrow for the shared chevron; inputs share the 3px accent focus ring; secondary surfaces reuse the raised-pill and icon-tile idioms instead of inventing local containers.

## Alternatives considered

**Recording one note per polish commit.** Dropped: the commits implement a single design direction; splitting the record would scatter one vocabulary over eight entries and invite future contributors to cite whichever fragment suits them.

**Keeping per-surface transition timing as local constants.** Dropped: that is exactly the drift being removed — local durations look equivalent in isolation and diverge in composition. A token cannot drift per surface.

**Treating steward/icon remaps as one-off bug fixes.** Dropped: each remap is an instance of the glyph rule — recording the rule prevents the next metaphor icon from slipping in under "it's just an icon".

## Consequences

New client surfaces inherit motion, iconography, and chrome geometry by consuming tokens and the ic_ds_ table; a surface that needs a bespoke duration or an off-vocabulary glyph is the signal to escalate the design decision rather than ship local constants. The motion scale is the single place duration and easing change for the whole client. Sessions created before the session-log export unmount keep their transcripts — only the download surface retired.
