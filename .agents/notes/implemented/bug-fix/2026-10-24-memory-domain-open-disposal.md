# Agent Note: Memory domain ownership during asynchronous setup

Status: implemented

English | [中文](2026-10-24-memory-domain-open-disposal.zh.md)

## Problem

The memory provider opens its storage domain asynchronously. Its setup effect registered another effect only after opening completed. If provider unloading started during the open, Cordis rejected the late effect registration; the acquired domain remained open and reserved its name, blocking a replacement provider.

## Decision

The original setup effect returns the domain's cleanup closure directly. Cordis waits for pending setup and invokes that returned cleanup during disposal, including when the domain arrives after unloading starts. Cleanup does not require registering another effect on an inactive context. The domain facility remains the resource owner until the domain closes and releases its name.

This change covers the memory provider's pending acquisition. It does not establish resource ordering for unrelated providers or enclosing-owner shutdown. Committed mutation semantics remain in the [memory outcomes decision](2026-10-23-memory-mutation-outcomes.md).

## Alternatives considered

**Register a cleanup effect after awaiting the domain.** Unloading can already have made the context inactive at that point, after resource acquisition has succeeded.

**Rely on the storage backend's eventual shutdown.** The memory provider can be replaced while that backend remains active. A domain retained until application shutdown prevents the replacement from opening the same name.

## Consequences

Provider disposal joins pending acquisition and releases the acquired handle before it settles. Replacement can open the same memory domain. Stored entries, schemas and model-visible memory results retain their existing formats.

## Verification

A controlled unit regression opens the real domain facility over its in-memory backend, starts provider disposal before the open returns, and verifies domain closure and successful replacement reads. The original implementation leaves the unit open.

The keyless headless example uses the actual Loader entry and JSON backend. It stops memory during backend opening, verifies the domain is released, reloads the entry and completes a real model `memory_save` turn. Its golden includes the persisted `release-freeze` key. Restoring the late-registration implementation fails the assembled example before replacement can proceed.
