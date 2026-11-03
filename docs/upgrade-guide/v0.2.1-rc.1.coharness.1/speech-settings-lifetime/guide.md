---
kind: upgrade-guide
description: "Speech preferences rebind when the optional Settings provider changes."
---

# Follow active speech preference storage

English | [中文](guide.zh.md)

## Change

Speech preferences follow the currently mounted Settings provider. Withdrawing that provider restores composition defaults and rejects saves until a replacement is ready. Replacement reads its own persisted values; later saves use its file. Readiness observers receive these transitions without restarting speech recognition.

## Migration

Rebuild the speech service. Wait for a replacement Settings Loader entry to finish starting before saving preferences through it. If saving reports a provider change, the original file may already contain the write; retain committed data and retry after the current provider is ready. Existing `speech-to-text` namespace fields and stored files need no migration. No Session format or database version changes are required.
