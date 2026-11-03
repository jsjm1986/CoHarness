---
kind: upgrade-guide
description: "Managed directory browsing preserves the Runtime grant source, empty permissions and read-only grants."
---

# Upgrade managed directory access

English | [中文](guide.zh.md)

## Change

Gateway-managed directory browsing requires the Runtime’s private grants file. A valid empty array permits no listing or creation; missing or invalid managed files fail plugin activation. Directory creation requires the most specific containing grant to be `rw`. Independent launches retain optional-file browsing from the OS home. See the [browser provider](../../../../packages/host/directory-picker-browse/README.md).

The automatic chooser selects browser interaction for an inherited Gateway credential channel, including loopback listeners. Direct users of `DirectoryPickerHostFacts` provide `gatewayRuntime`, derived with `launchedByGateway(launchEnvironmentOf(ctx))`. The standard Gateway guard bundle already explicitly selects the browser interaction.

Grant roots bind to their filesystem objects at activation. Replacing a path with a different directory or link refuses listing and creation; links to ungranted targets are omitted. Operations retain parent handles while running and verify logical paths before returning results. The optional `readBatchEntries` setting controls stdlib and POSIX read batches (default 32, range 1–65,536); Windows granted reads use a protocol-bounded buffer.

## Migration

1. Deploy `@deepseek-ai/node-addon-system` 0.1.3 or later with its matching platform package on every upgraded POSIX computer. Restricted browsing refuses missing native capabilities; installation does not compile them.
2. Restart upgraded Runtimes so their launch environment receives the private `DSH_DIRECTORY_GRANTS` path and the provider records current root identities. The shipped CLI rejects this setting in project environment files; custom hosts also resolve the managed browser’s location from the inherited snapshot.
3. If a managed browser fails activation, restore a valid Runtime grants projection through Gateway administration and restart the Runtime. Give write access only to directories where creation is intended; read-only roots remain browsable.
4. After intentionally replacing a granted root with a different directory, refresh its authorized grants projection and restart its Runtime. Restoring the original directory object preserves its existing identity.
5. Keep a valid empty array when no filesystem browsing is authorized. It does not enable host-home access.

Session generations and database schemas are unchanged. The [directory-picker decision](../../../../.agents/notes/implemented/architecture/2026-07-28-directory-picker-capability-seam.md) records grant ownership and deployment selection.
