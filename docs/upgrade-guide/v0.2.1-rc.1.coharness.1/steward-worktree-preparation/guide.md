---
kind: upgrade-guide
description: Steward checkout uses a filtered asynchronous Git client with a preparation deadline and Gateway shutdown cancellation.
---
# Bounded steward workspace preparation

English | [中文](guide.zh.md)

## Change

Steward worktree preparation runs asynchronously, so a slow checkout does not block Gateway HTTP requests. Git children receive the Gateway tooling environment filter; repository hooks cannot rely on inherited Gateway, Runtime or credential variables. `HGW_STEWARD_PREPARE_TIMEOUT_MS` sets the total preparation deadline, defaulting to 60000 milliseconds. Gateway shutdown cancels preparation before dependent project or Runtime work.

A retained `steward-workspace` branch is preserved while a replacement workspace checks out source `HEAD` detached. Other Git failures are reported directly rather than retried as a branch conflict. Failed checkout files remain for operator inspection; preparation does not reset existing worktrees or promise rollback of Git's partial writes. Cancellation joins the local subprocess provider’s managed Git process range, including ordinary checkout hooks. `HGW_STEWARD_PREPARE_KILL_GRACE_MS` defaults to 1000 milliseconds before termination escalates. Containment follows the provider’s [platform limitations](../../../../packages/subprocess/subprocess-local/README.md); escaped descendants on weaker platforms remain outside that guarantee.

## Migration

1. Review repository hooks that require inherited Gateway credentials. Prepare those steps explicitly outside Gateway bootstrap; the filtered environment is intentional.
2. Set `HGW_STEWARD_PREPARE_TIMEOUT_MS` and `HGW_STEWARD_PREPARE_KILL_GRACE_MS` to positive integers no greater than 2147483647 when their defaults are unsuitable. Invalid values fail configuration loading.
3. Inspect the steward workspace and Git error after a checkout failure. Preserve retained branch commits and partial files before retrying initialization. No database migration is required. See the [steward decision](../../../../.agents/notes/implemented/feature/2026-10-10-steward-maintenance-space.md).
