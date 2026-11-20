---
kind: upgrade-guide
description: Manual release activation and node-agent controls require confirmed Gateway and Runtime shutdown.
---

# Protect running work during deployment

English | [中文](guide.zh.md)

## Change

macOS `release-control.sh activate` requires stopped Gateway and Runtime processes and verifies the candidate against the live PostgreSQL migration ledger. A failed candidate stays selected if it may own work. After confirmed exit, rollback requires a fallback with an exact match for the installed governance and configured node content migrations. If that proof fails, the candidate stays selected and automatic launch pauses. Windows manual agent restart/removal requires exact task ownership and stopped installation work.

## Migration

1. Install the updated release controller outside release directories. Do not execute older helpers that kill Runtime supervisors or use `taskkill /T /F`.
2. Follow the [deployment runbook](../../../../gateway/deploy/README.md): enter maintenance, review long tasks and schedules, confirm shutdown, and pause automatic Gateway launch before stopping its process. If work cannot stop, use a candidate with separate databases, identities, directories and ports.
3. Install the updated stable `release-control.sh`. Stage a release containing `gateway/lib/release-schema-check.js` and retain a fallback compatible with the expected post-upgrade database. Run `release-control.sh preflight`, then `activate <candidate> [--rollback-target <compatible-release>]`.
4. If rollback is refused on schema compatibility, stay in maintenance and activate a release built for the already installed migrations. Check `status`, `/healthz` and the exact release before leaving maintenance.
4. On Windows, use the script registered by the agent task, pause other enabled tasks in the installation and confirm Gateway/Runtime shutdown before `-Restart` or `-Uninstall`. A refusal changes no task or process. Do not infer shutdown from an idle page or unavailable database.
