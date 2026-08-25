# Agent Note: Web boot supplies AbortSignal static-factory compatibility

Status: implemented

English | [中文](2026-08-25-abort-signal-webview-compat.zh.md)

## Problem

The Web client uses `AbortSignal.any()` while composing transport and lifecycle cancellation. Android WebViews can expose `AbortController` without the newer static `any`, `timeout`, or `abort` factories, so a mobile request fails before it reaches the Gateway with `AbortSignal.any is not a function`.

## Decision

The Web boot kernel installs small compatibility implementations for missing static AbortSignal factories before it prefetches or activates dynamic client entries. Native implementations remain untouched. The `any` implementation forwards the first abort reason and removes all listeners after settlement; the timeout implementation clears its timer when cancelled; the abort implementation returns an already-aborted signal. The compatibility code owns only browser API availability; request cancellation and transport termination remain owned by their existing callers.

## Alternatives considered

- **Require a newer Android WebView.** Rejected because the hosted Web UI has no reliable control over the embedded shell's system WebView version, and the failure prevents even ordinary navigation and model selection.
- **Replace every `AbortSignal.any` call independently.** Rejected because browser-facing and dynamically loaded packages would accumulate repeated signal-fusion implementations with diverging cleanup and reason semantics.
- **Patch the Gateway to hide the error.** Rejected because the exception is raised in the browser before an HTTP request is sent; server handling cannot repair an unavailable client API.

## Consequences

Older supported Android WebViews can open the Web UI, establish the connection, and use bounded RPC cancellation without the internal TypeError. Browsers with native factories follow the platform implementation. The compatibility layer does not promise support for browsers missing the underlying `AbortController` or `fetch` APIs.
