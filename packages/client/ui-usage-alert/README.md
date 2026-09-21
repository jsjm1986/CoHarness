# @deepseek-ai/dsh-client-ui-usage-alert

English | [中文](README.zh.md)

Gateway quota warnings in the global Web shell. The browser plugin contributes one `shell.overlay` entry. Its apply-side callback reads the authenticated same-origin `/account/api/usage` summary once on mount through the shared streaming 16 MiB response budget; the presentation component displays only durable natural-month 80%/100% crossings already computed by the gateway. A failed advisory read leaves the shell unchanged.

## Summary

Use `dsh-client-ui-usage-alert` for Gateway quota warnings in the Web shell. One `shell.overlay` entry reads the authenticated `/account/api/usage` summary on mount and displays the durable natural-month 80%/100% crossings already computed by the gateway; a failed advisory read leaves the shell unchanged.

## Invariants

**Runtime invariant:** No companion is published. The banner displays durable quota crossings already computed by the Gateway from a single advisory read; it owns no usage state.

## Model Experience

None, as the browser-side quota warning projection registers nothing model-facing.

#### KV Cache effect

None; the package never assembles or sends provider requests.

## Known Limitations and Deferred Work

- **Mount-time refresh only** — a threshold crossed while one tab remains open appears after the next page load; the gateway remains the durable alert owner.
