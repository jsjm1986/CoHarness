# Agent Note: Title-wait deadline diagnostics

Status: implemented

English | [中文](2026-09-17-title-wait-deadline.zh.md)

## Problem

Vitest's `waitFor` reports a generic timeout if its first asynchronous callback remains pending until the deadline. A short title-wait deadline can therefore lose the session-specific diagnostic while reading persisted logs.

## Decision

The title wait retains the existing poll interval, deadline and title ordering predicate. It initializes the observation error to the session-specific diagnostic and retains subsequent read, parse or predicate errors. The outer rejection reports that observation error while Vitest continues to own the independent deadline timer.

## Alternatives considered

Increasing the timeout hides slow reads without fixing their diagnostic. Checking a deadline only after an awaited read cannot terminate a blocked read. Replacing Vitest polling introduces unnecessary timer ownership.

## Consequences

A real fake-ACP subprocess publishes an early title; a controlled read gate holds the first matching log read past the original 20ms deadline. This regression fails with the generic error before the fix and passes afterwards alongside the normal-read case. The test releases its gate in finally. The complete harness file passes 63 tests; package compilation and focused lint pass. No model-visible output changes, so no application transcript update is required. Other durable waits and full-suite Python failures remain outside this fix. The deadline does not cancel an in-flight filesystem read.
