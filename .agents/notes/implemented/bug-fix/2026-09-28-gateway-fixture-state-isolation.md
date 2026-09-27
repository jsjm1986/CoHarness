# Agent Note: Gateway fixture state isolation

Status: implemented

English | [中文](2026-09-28-gateway-fixture-state-isolation.zh.md)

## Problem

Gateway defaults point to the invoking account's runtime and state directories. Isolating a fixture's database and user directory does not isolate project policy projection: an HTTP settings mutation can write a project runtime's policy and home patch without starting that runtime.

## Decision

Resource fixtures pass an owned temporary root to `gateway/tests/test-config.ts`. The helper supplies user, project, project-runtime, state and systemd paths, then parses the real configuration and rejects writable locations outside the fixture root. Derived keys, backup files, node configuration and optional restore targets participate in the same check. A subprocess receives the same explicit environment as its in-process fixture; it does not inherit deployment configuration from the invoking shell.

Configuration parser tests retain the real production defaults. Read-only launcher classification and transport fixtures with injected senders do not use configured paths for writes. Source packages and migration inputs retain their real read-only locations.

## Alternatives considered

Changing `HOME` or mocking `homedir()` process-wide would hide default-resolution mistakes and introduce shared state between concurrent tests. Copying individual path overrides into each fixture leaves newly used resource domains unprotected. The owning temporary root makes the allowed write area explicit before services start.

## Consequences

The real project policy writer is exercised under the isolated root, and invalid path overrides are rejected before writing. Fixture authors still own subprocess shutdown, database disposal and temporary-directory cleanup. Paths stored directly in fixture database rows or durable manifests require their own ownership checks; configuration isolation does not rewrite those records.
