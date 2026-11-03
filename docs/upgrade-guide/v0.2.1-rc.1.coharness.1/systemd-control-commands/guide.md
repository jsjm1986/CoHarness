---
kind: upgrade-guide
description: "Systemctl clients have a configurable deadline, honor startup cancellation and exclude Gateway credentials."
---

# Systemctl clients have bounded lifetimes

English | [中文](guide.zh.md)

## Change

Native systemctl clients use `HGW_SYSTEMD_COMMAND_TIMEOUT_MS`, defaulting to 120000 milliseconds, and startup cancellation closes daemon-reload and restart clients. Previously these commands could wait indefinitely. Commands exclude Gateway and credential environment variables and disable password prompts and pagers. Failed restart retains its generation cleanup handle; CLI termination does not prove that systemd stopped the Runtime.

## Migration

1. Deploy the Gateway through its [deployment procedure](../../../../gateway/README.md). Set `HGW_SYSTEMD_COMMAND_TIMEOUT_MS` if service operations need a different deadline; values must be positive and no greater than 2,147,483,647.
2. Custom `SystemdLauncherOptions` must supply `commandTimeoutMs`. A custom `run(args, signal)` implementation must honor cancellation and await its owned command's closure.
3. Run `npm --prefix gateway run test:built-systemd-control` to check native CLI ownership with inert fixtures. Verify actual service start and stop on the Linux deployment separately; a failed stop keeps the Runtime reservation for retry. See [control-command ownership](../../../../.agents/notes/implemented/bug-fix/2026-10-25-systemd-control-command-ownership.md).
