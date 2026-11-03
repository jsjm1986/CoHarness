---
description: "Native-OS-chooser backend of the directory-picker seam for the DeepSeek Harness web GUI host"
kind: "package-reference"
---

# @deepseek-ai/dsh-host-directory-picker-native

English | [中文](README.zh.md)

The **native-OS-chooser backend** of the [directory-picker seam](../directory-picker/README.md): `NativeDirectoryPicker` registers `ctx.directoryPicker` with the `native` capability, whose `pick(signal)` opens one native chooser per call and resolves the chosen absolute path (`null` on cancel). Platform tools run without a shell: `osascript` on macOS and Zenity with a KDialog fallback on Linux; the caller's abort terminates the native process. Windows opens the modern `IFileOpenDialog` in a spawned child process — a koffi-driven COM conversation on the child's main thread with the best thread DPI awareness the host accepts (per-monitor-v2 first), aborted by posting `WM_CLOSE` to the dialog thread. Immediately before `Show`, the child synthesizes one Alt press through `keybd_event`, which lets the dialog activate as the foreground window even when a background host process spawned the child. Only viable when the operator sits at the host's display — remote deployments compose [`-browse`](../directory-picker-browse/README.md) instead. The command boundary (`DirectoryPickerRunner`) and platform facts are injectable. The shared no-shell subprocess runner lives in [`dsh-native-command`](../../util/native-command/README.md).

POSIX command output removes exactly one terminating LF. Carriage returns and additional newlines remain part of the selected directory name; an empty selection returns `null`.

Each service instance owns its accepted picks. Unloading the provider or Host aborts them and waits for their promises; retained capability objects refuse new picks. POSIX cancellation waits for each direct helper's process and captured streams to close. Cancelling one caller does not retire the provider or cancel other callers.

Windows results wait for worker process closure and outstanding window-close calls. Cancellation retries `WM_CLOSE`, then requests force termination for an unresponsive child. A refused termination request keeps the pick pending until closure. Observed worker exit cancels delayed window-message preparation.

This package supplies the Host backend. The matching browser interaction belongs to [`dsh-client-ui-directory-picker-native`](../../client/ui-directory-picker-native/README.md). The [automatic chooser](../directory-picker-auto/README.md) mounts both packages; explicit compositions include both entries.

## Summary

An operator at the host's display picks a workspace directory through the operating system's chooser. This Host backend returns the selected path without trimming filename characters, or `null` on cancel. The automatic chooser composes it with the matching browser interaction. Remote deployments use the [browse backend](../directory-picker-browse/README.md).

## Table of Contents

- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="model-experience"></a>
## Model Experience

None, as the GUI-host picking backend registers nothing model-facing.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **Linux requires desktop tooling** — with neither Zenity nor KDialog installed, `pick` rejects with an actionable error; it does not fall back to a typed-path prompt (the browse backend is that fallback at the composition level).
- **Windows has no mechanism fallback** — the child-process picker through packaged koffi is the only native tier, so a COM refusal or dialog crash surfaces the failure. The browse backend remains the fallback at the composition level.
- **Windows foreground grant relies on injected input** — the child synthesizes an Alt press before `Show` so the dialog can take the foreground from a background host; where synthesized input is suppressed (secure desktops, restricted remote sessions, an elevated foreground window), the dialog may still open behind other windows. The technique is validated on Windows 11 only.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
