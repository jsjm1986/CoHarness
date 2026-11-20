# Agent Note: Session preview keyboard access

Status: implemented

English | [中文](2026-11-20-session-preview-keyboard.zh.md)

## Problem

A long Session title could be read and copied from a pointer preview. Session rows had no focus stop, and Escape left the compact preview open.

## Decision

[Session rows](../../../../packages/client/ui-workspace/README.md) accept native keyboard focus and open the selected Session on Enter or Space. Keyboard focus on a row with a copyable title opens its [shared preview](../../../../packages/client/ui-primitives/README.md). Tab reaches the portaled copy action and continues from the row's place in the page. Escape closes the preview and restores row focus when the card held it.

## Alternatives considered

**Rely on the card's body-level tab stop.** The portal sits at the end of the document, separated from the Session row and its other actions.

## Consequences

Keyboard traversal can reach the Session, its full title, and its actions without a pointer. The original dwell and gap-crossing grace still apply to pointer previews.

## Verification

The browser replay renames a seeded Session, traverses to the copy action, checks the clipboard acceptance feedback, and verifies Escape and focus return. It also checks that pointer previews remain reachable in narrow and short windows.
