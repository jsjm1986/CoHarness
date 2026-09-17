# Agent Note: Await publication inside Agent creation rollback

Status: implemented

English | [中文](2026-09-17-await-agent-publication-rollback.zh.md)

## Problem

Returning an asynchronous publication operation directly from a `try` block lets its rejection bypass the creation transaction's `catch`. An entered Agent and Session can remain registered after creation reports failure.

## Decision

AgentLoop's private `PreparedAgent.publish()` returns a Promise. `setupAndPublish()` awaits it inside the existing rollback handler, which awaits disposal before propagating the error. Public creation events retain their synchronous semantics; this change does not implement asynchronous `agent/created` initialization.

## Alternatives considered

**Return the publication Promise directly.** This preserves success results but bypasses rollback on rejection. The two publication-failure tests reject this implementation.

**Migrate creation events in the same change.** Serial initialization also requires queued-input control, cancellation ownership and every event consumer to migrate together. That migration remains separate from the private publication operation.

## Consequences

Creation failure preserves registry cleanup and permits reuse of the same identity. Tests cover failures in both `session/created` and `agent/created`, assert cleanup without polling, and recreate the same id. Existing interception, lifecycle, resume and configured-session tests cover unchanged behavior. No Session event schema, SDK output or model-visible transcript changes in this preparatory refactor.
