# @deepseek-ai/dsh-host-directory-picker-auto

English | [中文](README.zh.md)

The **adaptive chooser** of the [directory-picker seam](../directory-picker/README.md): a node-half-only plugin that resolves the host's situation once at boot and mounts the matching dual-face backend — [`-native`](../directory-picker-native/README.md) or [`-browse`](../directory-picker-browse/README.md) — as a real Loader entry in the in-memory root tree (never persisted to a config file; the root tree's `write()` is a no-op). Because the backend arrives as an ordinary entry, its browser half is discovered by the client module table exactly as a config-row's would be, so the seam's one-row-swaps-both-faces invariant holds for the resolved choice. The Loader logs module import failures without rejecting `create()`. The chooser detects an entry without a fiber and fails its own fiber with the package name; it does not retry the import. Callers must audit activation after `loader.await()` resolves. A failed face takes the already-mounted faces with it, and unloading the chooser removes the entries again — deleting an entry only requests disposal, so the chooser joins each face's fiber teardown before its disposer settles.

Resolution is one pure boot-time sample (`resolveDirectoryPickerBackend`), exported for reuse. `native` requires every signal that the operator can see the host display and the native backend can serve it: a loopback-only bind (read from the injected `webServer`; an all-interfaces bind admits remote browsers no OS chooser can reach), no SSH launch (`SSH_CONNECTION`/`SSH_TTY` unset or blank — under SSH port-forwarding the chooser would open on the unattended server), and a servable display session — assumed on darwin/win32; on linux `DISPLAY`/`WAYLAND_DISPLAY` plus a zenity or kdialog binary on `PATH` (the probe is one more boot-time fact); never on any other platform, since the native backend drives exactly darwin/win32/linux. Anything ambiguous resolves to `browse`, which works everywhere. The sample happens exactly once per boot so the mounted capability stays stable for the service lifetime, as the seam requires. Pinning an interaction is not a config field here — compose the `-native` or `-browse` row directly instead of this one, the seam's documented swap point; mounting the chooser **and** a backend row together fails loud (duplicate `directoryPicker` service, duplicate client flow in the `single` holes).

## Summary

`dsh-host-directory-picker-auto` picks the right directory-picking interaction for every boot: it resolves the host's situation once at boot and mounts the matching backend — [native](../directory-picker-native/README.md) or [browse](../directory-picker-browse/README.md) — together with its browser half, as real Loader entries in the in-memory root tree. The resolution is one pure boot-time sample: `native` requires a loopback-only bind, a non-SSH launch, and a servable display session; anything ambiguous resolves to `browse`, which works everywhere. Pinning an interaction means composing that backend directly. The mounted capability stays stable for the service lifetime, as the seam requires.

## Invariants

**Runtime invariant:** No companion is published. The chooser resolves the host situation once at boot and mounts the matching backend as an ordinary Loader entry; there is no ongoing picker state.

## Model Experience

None, as the GUI host's directory-selection chooser only mounts a backend row and registers nothing model-facing.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **Detection infers operator location from launch context, which no launch-side signal can prove** — a tmux session detached from its SSH launch loses the `SSH_*` markers; a Darwin process outside an Aqua session still counts as displayed; and a workstation-local launch later reached through `ssh -L` arrives from `127.0.0.1`, resolves `native`, and opens the chooser on the unattended workstation. A wrong `native` choice degrades to the backend's existing retryable failure dialog, and composing `-browse` directly selects the safe interaction for such deployments.
- **The Linux chooser probe reads `PATH` only** — a zenity/kdialog reachable some other way (shell alias, non-PATH install) still resolves `browse`; installing either binary on `PATH` restores `native` eligibility at the next boot.
- **Boot-time only** — one resolution serves every client of the boot; per-connection adaptivity (native for a local browser, browse for a remote one, same server) would need a per-client capability and the wire advertisement the seam deliberately deleted, and waits for a deployment that serves both at once.
