# Agent Note: Touch users control composer keyboard activation

Status: implemented

English | [中文](2026-11-20-touch-composer-focus.zh.md)

## Problem

Session restoration could focus the composer before a user interaction. An Android landscape input method could then use nearly the entire browser viewport, clipping the focused textarea and its controls before the user tried to tap them.

## Decision

The [conversation composer](../../../../packages/client/ui-conversation/README.md) uses the primary pointer media query to leave keyboard activation to touch users. It still reveals the selection of an already-focused textarea. Desktop restoration keeps its existing focus and caret behavior.

The Android test driver uses the hit-tested point of a visible control without pre-scrolling it. A scroll-based actionability check after keyboard dismissal can reveal the still-focused input and move the send button before the touch arrives.

Short touch landscape viewports use the textarea's `enterkeyhint` to expose Send on supporting input methods. The hint stays stable while a draft changes and reuses the same IME-aware Enter handler.

## Alternatives considered

**Use a phone-width threshold.** A landscape phone can have enough CSS width for the medium frame while its keyboard still occupies almost all of the usable height.

## Consequences

Cold Session restoration leaves touch users room to reach the input. A supporting landscape keyboard can send while it covers the page. Dismissing the keyboard exposes the page's Send control with the draft retained. The [startup isolation scenario](../../../../apps/web/tests/plugin-startup-isolation.e2e.ts) covers restoration, multiline editing, and a settled send with optional scripts unavailable.
