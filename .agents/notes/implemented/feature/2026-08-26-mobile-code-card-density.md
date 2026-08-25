# Agent Note: Compact mobile code and result cards

Status: implemented

English | [中文](2026-08-26-mobile-code-card-density.zh.md)

## Problem

On phone viewports, code and tool-result cards combined a 44px copy target with desktop banner padding, leaving a short `text` block and its copy control with unnecessary vertical space. The same chrome pattern appeared across read, search, terminal, and diff cards, while web and JSON cards kept larger mobile insets and caps.

## Decision

The shared primitive cards use a compact mobile geometry below 768px. Copy and disclosure controls keep a 44px minimum target, while their surrounding toolbar rows remove vertical desktop padding and use 10px horizontal insets. Code, read, search, terminal, and diff bodies use the mobile code rhythm and smaller insets; web and JSON surfaces use tighter phone padding and content caps. An empty fenced code block keeps its DOM for markdown parity but marks the wrapper so the mobile stylesheet removes the blank body gutter.

Long output still scrolls inside its own card, and desktop geometry remains unchanged. The compact rules live in the primitives so every consumer receives the same treatment without per-tool overrides.

## Alternatives considered

**Reduce the copy button below 44px.** Rejected because the control would no longer satisfy the shared coarse-pointer target used by the rest of the mobile UI.

**Hide empty fenced blocks entirely.** Rejected because the markdown renderer's empty-fence DOM is part of its parity contract; collapsing only the blank mobile body preserves that contract while removing visual waste.

**Tune each tool row independently.** Rejected because CodeBlock, ReadBlock, SearchBlock, TerminalBlock, and DiffBlock are shared primitives used by multiple render sites; local overrides would drift and leave standalone markdown inconsistent.

## Consequences

Short code fences no longer reserve a blank content gutter on phones, and copy controls remain easy to tap. Result cards occupy less vertical space while preserving horizontal scrolling and bounded long-output behavior. Consumers that intentionally override a primitive's margin or code font continue to do so through their existing class-level custom properties.
