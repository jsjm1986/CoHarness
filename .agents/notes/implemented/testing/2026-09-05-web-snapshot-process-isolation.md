# Agent Note: Isolate stateful Web snapshot suites in their own processes

Status: implemented

English | [中文](2026-09-05-web-snapshot-process-isolation.zh.md)

## Problem

The long Web snapshot lane intermittently failed stateful suites after unrelated files had already run in the same Vitest process. The same suites passed when selected alone, while the failing file set changed between CI attempts.

## Decision

`scripts/run-web-snapshots.ts` runs the stateful browser suites in separate Vitest processes before the bounded pool. The isolated set covers suites that retain browser, session, replay, or layout state across a long scenario; the remaining suites keep the existing pool and worker limit.

## Consequences

Each isolated suite pays one process startup, but its module state, environment restoration, browser lifetime, and replay cursor cannot leak into another suite. Add a suite to the isolated list only when standalone success and full-lane interference show that process ownership is the missing guarantee.

## Testing

The affected suites pass when run together from a clean checkout. CI must re-run the full Web snapshot gate to validate the process split on the hosted runner.
