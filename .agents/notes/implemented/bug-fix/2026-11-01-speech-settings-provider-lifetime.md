# Agent Note: Speech preferences follow their Settings provider

Status: implemented

English | [中文](2026-11-01-speech-settings-provider-lifetime.zh.md)

## Problem

Speech recognition cached the first Settings scope independently of its provider. Removing that provider left stale preferences visible; replacing it could send a later save to a disposed writer instead of the active settings file.

## Decision

An optional Settings injection owns the namespace registration, watcher and cached scope. Binding publishes the new provider’s resolved selection. Withdrawal clears that scope and publishes composition defaults. Saving requires the current binding and rechecks that ownership after persistence. Provider changes reject the acknowledgement while retaining any committed original-file data. Speech registry disposal cancels and joins its own work before releasing the optional binding.

## Alternatives considered

**Cache a lazily created scope.** A scope belongs to its provider and cannot survive that provider’s withdrawal.

**Restart speech recognition with Settings.** Recordings and recognizer registrations have independent lifetimes; preference storage replacement does not require restarting them.

## Consequences

Observers receive preference-storage transitions. Default resolution and subsequent saves use the active provider. Stored namespace fields, service methods, audio routing and Session formats are unchanged.

## Verification

Actual file providers cover withdrawal, replacement, saving to the new file, observer updates and withdrawal during persistence. The runnable SDK application changes the Settings Loader entry while retaining the speech service and compares its resulting selection and saved files.
