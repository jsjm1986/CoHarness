# Agent Note: Retry Office smoke tree cleanup through Windows handle-release lag

Status: implemented

English | [中文](2026-11-25-windows-office-cleanup-handle-lag.zh.md)

## Problem

The `python runtime / release-shaped matrix / node24-win-x64` lane failed after the Office smoke itself had already succeeded — "relocated Office native DOCX produced 18554 PDF bytes" printed before teardown — because `tempfile.TemporaryDirectory` cleanup could not unlink `libreoffice-kit-win32-x64/bin/libreoffice-kit.exe`: `PermissionError WinError 32`, followed by `NotADirectoryError WinError 267` as the half-deleted tree confused the error handler. Windows releases executable image handles asynchronously after process exit, so a native engine binary can remain locked briefly after the harness reports termination. The smoke lane has no influence over that OS timing; a single immediate deletion attempt is simply the wrong primitive on this platform.

## Decision

`workspace()` in `scripts/fixtures/office-render.py` now manages its root with explicit `tempfile.mkdtemp` plus a `remove_tree` helper: on win32, `PermissionError`/`NotADirectoryError` during `shutil.rmtree` retries every 0.5 s for a bounded 30 s window; POSIX behavior is unchanged (single immediate deletion). Artifact capture still runs before tree removal, and error propagation semantics are identical. Genuine non-lock failures still raise after the window rather than being swallowed, and no temporary tree is ever deliberately leaked — ownership of the acquired path is preserved per the scripts execution model.

## Alternatives considered

- **`ignore_cleanup_errors=True`** — leaks multi-hundred-megabyte engine trees on every locked run and hides real cleanup defects behind the same flag; ephemeral CI runners make the leak invisible locally but not smaller.
- **Terminating the engine more aggressively in the harness** — the harness already reports termination; the lag is in the OS releasing the image handle, not in a surviving process the product failed to kill, so there is nothing correct to fix upstream.
- **Retrying inside the CI step** — rerunning the whole matrix job to survive a teardown race wastes the successful smoke evidence this run already produced.

## Consequences

The Office smoke's pass/fail signal now reflects the conversion contract rather than the timing of Windows handle release. Other fixtures that acquire native-process trees should reuse `remove_tree` rather than raw `shutil.rmtree` when they move onto win32 runners. Related: [ptc cancellation probe yield](../testing/2026-11-25-ptc-cancel-probe-must-yield.md) and [windows teardown budget headroom](../bug-fix/2026-11-24-windows-teardown-budget-headroom.md) cover the same lane's independent teardown classes.
