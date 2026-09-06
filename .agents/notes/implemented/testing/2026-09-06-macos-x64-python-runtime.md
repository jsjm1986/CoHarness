# Agent Note: Python runtime publishes a native macOS x64 wheel

Status: implemented

English | [中文](2026-09-06-macos-x64-python-runtime.zh.md)

## Problem

The Python SDK runtime manifest and release workflow shipped Linux x64/arm64, macOS arm64, and Windows x64, but Intel macOS users had no native executable or wheel even though the runtime builder already models platform and architecture separately.

## Decision

Add `macos-x64` as a first-class runtime target with the `macosx_14_0_x86_64` wheel tag and the same ripgrep and node-pty spawn-helper sidecars as macOS arm64. Platform detection, release staging, deployment-target checks, workflow target selection, and Python resolution tests all consume the shared manifest. The existing arm64 target and carrier naming remain unchanged.

## Alternatives considered

**Ship an arm64 wheel through Rosetta.** Rejected because native x64 builds avoid translation assumptions and match the host architecture used by Intel macOS CI.

**Publish one macOS universal2 wheel.** Rejected because the runtime executable and native spawn helper are built as target-specific artifacts, while the existing release builder and manifest already publish one platform per wheel.

**Add an ad hoc fallback in Python resolution.** Rejected because platform support must be visible to the manifest, wheel builder, and release checks together.

## Consequences

The release matrix adds one native macOS runner and one wheel. Intel macOS users can resolve the same production carrier contract as arm64 users; deployment-target validation now receives the selected platform rather than assuming arm64.

## Verification

The three focused Python test modules pass (26 tests), the CI workflow parser and executable-builder tests pass (14 tests), and the manifest remains the single source for wheel tags and executable names.
