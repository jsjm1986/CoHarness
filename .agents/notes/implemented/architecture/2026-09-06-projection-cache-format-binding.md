# Agent Note: Projection cache binds the Session format generation

Status: implemented

English | [中文](2026-09-06-projection-cache-format-binding.zh.md)

## Problem

A projection checkpoint can have a valid state schema and watermark while still describing a different Session log format. Reusing it after a format migration would let a cache row outrank the migrated event fold.

## Decision

Every projection-cache identity stores `formatVersion` alongside `createdAt` and `cwd`. Cache reads require all three header facts to match; a mismatch discards the row and refolds from the log. The storage-domain version advances so existing cache media is invalidated as a whole rather than interpreted under the new identity contract.

## Alternatives considered

**Bind only to the Session id and creation time.** Rejected because a format migration can preserve both values while changing event interpretation.

**Migrate cache rows with the Session log.** Rejected because the cache is a fold shortcut, not an authority; replaying the canonical log is safer and already fail-soft.

## Consequences

Format changes may cause one extra full projection fold, but stale rows cannot seed state from an incompatible log generation. The cache remains independent of the Session migration implementation.

## Verification

Projection-cache tests cover identity matching and the domain-version invalidation path; package typecheck and focused tests pass.
