---
kind: upgrade-guide
description: "Web runtime disposal cancels and joins its short-lived browser-handoff helper."
---

# Web handoff helper cleanup follows its owner

English | [中文](guide.zh.md)

## Change

Unloading the Web runtime's injected connection owner cancels its short-lived browser-handoff Node helper and waits for native close. A helper error remains pending until close. Intentional owner cancellation produces no browser-failure warning; real opening failures retain the manual-URL fallback.

## Migration

Rebuild the Web bundle with its matching application. Custom users of the exported native test hook must pass an `AbortSignal` to `internals.openBrowser(url, signal)`. CLI flags, configuration and stored data stay compatible. The maintained opener retains platform handoff semantics, and the browser after handoff keeps its independent lifetime. See the [Web bundle reference](../../../../packages/bundle/web-app/README.md).
