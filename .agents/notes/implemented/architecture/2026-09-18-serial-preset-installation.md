# Agent Note: Serial creation awaits preset tool installation

Status: implemented

English | [中文](2026-09-18-serial-preset-installation.zh.md)

## Problem

A standing model-selection preset installs delegation tools in each Agent's scope. Cordis records injected-fiber failures without throwing synchronously from `inject()`. Ignoring that fiber lets Agent creation succeed despite a conflicting tool registration, bypassing the serial initialization failure path.

## Decision

The [delegation tool](../../../../packages/subagent/tool-subagent/README.md) returns the existing or newly created installation fiber from its scoped installer and awaits it in `agent/created`. A failed installation rejects creation before publication and input admission. The Agent registry owns rollback, including Session removal and releasing the reserved ID; the consumer does not add a second transaction.

## Alternatives considered

- Logging the conflict without rejecting creation admits an Agent with incomplete tools.
- A separate readiness flag duplicates the installation fiber's settlement and can miss an existing failed fiber.
- Changing Cordis injection semantics would affect unrelated plugins; awaiting the consumer-owned fiber preserves the upstream lifecycle model.

## Consequences

Preset recomposition remains synchronous and idempotent; only serial creation waits for installation. The regression uses a real preset and conflicting tool registration, verifies creation rejection and empty Agent/Session registries, then recreates the same ID and observes the installed delegation tool. No model provider or live credentials are required. This change does not alter Session format versions or persisted generations.

The product CLI also waits for dynamically installed watcher dependencies to settle and pass activation audit before watching patches. Loader entry creation alone does not promise active services. Product-profile snapshots retain success, awaited startup context, publication rejection without a turn, and terminal model failure assertions. Inserted fixture paths resolve beside their patch files; activation diagnostics preserve the original error and identify the inactive entry.
