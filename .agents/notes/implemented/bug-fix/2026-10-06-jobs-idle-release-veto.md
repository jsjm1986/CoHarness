# Agent Note: Jobs veto idle release while work runs

Status: implemented

English | [中文](2026-10-06-jobs-idle-release-veto.zh.md)

## Problem

`tryDisposeIdle` consults `agent/idle-release-check` observers before retiring an idle Agent ([idle session purge](../architecture/2026-09-27-idle-session-purge.md)). The jobs seam installed no observer, so an Agent whose background job was still running or stopping could be idle-disposed; the job then reached teardown settlement only because its owner was already gone.

## Decision

`dsh-jobs` installs the veto in the `JobRegistry` constructor beside archive admission, through `src/idle-release.ts`: `agent/idle-release-check` answers `busy` while `registry.list(agent.id)` contains a running or stopping job owned by that exact agent (`job.owner === agent.id`). Unowned jobs veto nobody — they belong to the service until disposal. The exported `runningJobs` predicate keeps the archive-admission and idle-release listings identical.

## Alternatives considered

Checking jobs inside `agent-loop`'s release path would hardcode one resource kind in the loop and bypass the documented observer extension point. Relying on owner disposal to cancel the job lets an idle agent die while its work is still live — the veto is precisely the resource-plugin answer the purge contract asks for.

## Consequences

An Agent owning a live job is never idle-released; settled jobs stop vetoing. `jobs-local` specs cover busy-while-running, release-after-settlement, and the unowned case.
