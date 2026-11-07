# Agent Note: POSIX native chooser path terminator

Status: implemented

English | [中文](2026-10-31-native-picker-path-terminator.zh.md)

## Problem

POSIX directory names can end in carriage returns or newlines. Trimming all trailing line separators from chooser output changes the selected filesystem path and can target a different directory.

## Decision

The macOS, Zenity and KDialog adapters remove one LF emitted as the command's output terminator. Every preceding character remains part of the selected path. Empty output or a single terminator represents cancellation. The Windows COM adapter returns its path directly and does not use this decoder.

This preserves the directory identity required by the [native workspace interaction](../feature/2026-07-27-native-workspace-directory-picker.md), independently of its [client settlement fence](2026-09-16-native-picker-stale-settlement-fence.md).

## Alternatives considered

**Trim whitespace or every trailing CR/LF.** These characters are legal filename content on POSIX, so trimming cannot distinguish them from a protocol terminator.

**Treat CRLF as a two-character terminator.** These POSIX tools emit LF. A preceding CR can be the final filename character.

## Consequences

Selections retain exact directory identity, including trailing CR, LF and repeated newlines. The runnable Loader composition verifies real directories and cancellation through the production provider and external command processes. Interactive GUI selection is replaced; physical desktop dialogs remain outside that replay.
