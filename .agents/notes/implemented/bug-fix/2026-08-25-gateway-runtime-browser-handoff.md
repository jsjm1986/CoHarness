# Agent Note: Gateway-managed runtimes suppress browser handoff

Status: implemented

English | [中文](2026-08-25-gateway-runtime-browser-handoff.zh.md)

## Problem

Gateway starts a separate `dsh web` process when a user changes the account scope or browses documents in another scope. The Web bundle opens a default browser after every ordinary `dsh web` startup, so a background runtime start can open `http://127.0.0.1:<runtime-port>` on the operator's machine and expose an internal port in the browser UI.

## Decision

Gateway-generated source and release runtime commands pass `--no-open`. A custom `HGW_DSH_COMMAND` is rejected during configuration loading unless it carries the same flag. The Gateway configuration reference identifies this flag as a required background-runtime property. The public document listing remains protected by the separate [Gateway-owned document scope listing](2026-08-25-gateway-document-scope-loopback-leak.md) decision.

## Alternatives considered

**Infer Gateway ownership from an environment variable inside the Web bundle.** Rejected because it couples the generic Web application to a Gateway-specific process marker and creates another cross-package configuration contract.

**Let custom commands choose whether to open a browser.** Rejected because a missing flag silently restores the unsafe behavior during a deployment change; configuration must fail before any runtime starts.

**Disable browser opening globally in `dsh web`.** Rejected because interactive local `dsh web` launches intentionally retain their existing browser handoff.

## Consequences

Scope changes and document alternate-scope reads can start runtimes without creating browser tabs or navigating away from the public Gateway origin. Operators using a custom runtime wrapper must make its `--no-open` argument reach the Web CLI; an invalid command is reported at Gateway startup instead of surfacing later as a UI side effect.

## Testing

Gateway configuration tests cover the source and release defaults, the custom-command refusal, and the accepted flag. Launcher and systemd unit tests pin `--no-open` in the generated execution command.
