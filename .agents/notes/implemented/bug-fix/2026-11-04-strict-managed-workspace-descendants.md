# Agent Note: Strict managed workspace descendants

Status: implemented

English | [中文](2026-11-04-strict-managed-workspace-descendants.zh.md)

## Problem

A normalized path relative to itself is empty. Treating every non-parent relative path as a descendant accepts the reserved parent itself. A steward workspace can then consume its complete managed root, and project root validation loses the stricter containment check. Windows drive and share roots also require host-specific root detection; paths on different volumes have an absolute relative result and cannot overlap.

## Decision

Gateway's host-platform path comparison requires a nonempty relative path, rejects parent traversal and absolute results, and retains normalized path handling. Configured project data roots reject filesystem roots, including Windows drive and share roots, while independent volumes remain eligible. Managed project directories remain strict children of their configured data roots; a steward workspace remains a strict child of its steward root. The existing [project directory ownership](../feature/2026-08-15-project-collaborative-conversations.md) and [administrator directory browser](../feature/2026-08-17-gateway-admin-host-directory-browser.md) decisions retain their separate authorization rules.

## Alternatives considered

**Rely on reserved-directory overlap checks.** They sometimes reject a project root for another reason, but do not reject a steward workspace equal to its own root.

**Compare raw strings before normalization.** Trailing separators and equivalent path components can still denote the same directory.

## Consequences

Configurations selecting a root itself fail at load and must choose a child directory. Ordinary sibling and descendant comparisons retain host-specific path semantics. Parser regressions cover both project directory kinds, the steward workspace, normalized equality and Windows drive/share grammar. Path grammar checks do not establish filesystem permissions on a Windows host.
