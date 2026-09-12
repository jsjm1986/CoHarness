# Agent Note: Post-merge sweep repairs — leaked replay env and a raced mid golden

Status: implemented

English | [中文](2026-09-12-sweep-env-leak-and-steering-mid-race.zh.md)

## Problem

The post-merge sweep ran the complete consumer inventory under one step that exported `DSH_SNAPSHOT: replay` at step level. Every spawned built-bin child inherited it: `dsh-acp-demo`'s bin resolves `cordis.yml` to `cordis.snapshot.yml` under replay mode, the test's consumer directory has no snapshot config, and the child exited before the ACP handshake. Separately, `steering.e2e.ts` captured its mid-turn golden between the steering rows rendering and the question card mounting; on the serialized sweep runner the card mounted first, so the aria dump diffed and the fixture's second recorded call was never consumed.

## Decision

The sweep's consumer step drops the step-level `DSH_SNAPSHOT` export. Every snapshot consumer already defaults to replay (`process.env.DSH_SNAPSHOT ?? 'replay'`) and the web snapshot gate carries its own `env`, so the export added nothing but the leak. The steering scenario waits for `[data-question-key]` before the mid capture, making the card-mounted state deterministic on any runner speed; the refreshed golden records that state.

## Alternatives considered

**Keep the step env and strip it inside the test.** Rejected because the leak is ambient: any future gate spawning a bin would re-hit it, while no consumer needs the export.

**Keep the pre-card mid golden and wait for the card's absence.** Rejected because waiting for a non-mount cannot be made reliable; asserting the deterministic mounted state keeps the mid point meaningful — both steering rows rendered, the queue drained, and the question open.

## Consequences

The sweep's built-bin smoke runs every spawned bin on its own committed config regardless of the surrounding lane's snapshot mode, and the steering mid golden is stable across macOS and serialized Linux runners. The pre-card mid state is no longer pinned.
