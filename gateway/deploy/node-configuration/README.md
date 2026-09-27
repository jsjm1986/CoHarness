# Current-node configuration

English | [中文](README.zh.md)

## Summary

This reference covers `/admin` → Deployment → Current-node configuration and its independent local applier. Settings belong to the server-confirmed organization and node. Saving creates a reviewed candidate; applying is a separate administrator action. Credentials remain in private files and are not returned to the browser.

## Contents

- [Settings and application](#settings-and-application)
- [Install the independent worker](#install-the-independent-worker)
- [Local recovery](#local-recovery)
- [Data and verification](#data-and-verification)

<a id="settings-and-application"></a>
## Settings and application

The [field definitions](../../src/node-config-fields.ts) own the editable ports, public origins, managed paths, credential locations, instance lifecycle settings and Linux resource limits. Each field displays its effective value, source, unit and prerequisites. The Gateway listener remains loopback-only. Node identity, authentication, confinement, executable paths and shell commands are not editable fields.

`HGW_NODE_CONFIG_FILE` selects a private JSON file; the default is `node-config.json` beneath the launcher's `HGW_STATE_ROOT`. Its location is bootstrap configuration, independent of the form. The file carries desired, applied and previous values, configuration revisions and the current operation. `GET /admin/api/deployment/configuration` reports the serving process's effective values separately from the saved values. Concurrent or wrong-node submissions fail instead of overwriting another edit.

Enter maintenance and stop all personal and project instances before choosing **Apply and restart**. Stopping an instance interrupts its active work and terminals; review that impact first. The independent worker acquires the database deployment lease, checks the request's write epoch, verifies paths and database identity, checks port availability, restarts the declared Gateway service and waits for its health endpoint to confirm the exact configuration revision and release. The window remains in maintenance for operator checks. DNS, reverse proxies and certificates require separate preparation.

<a id="install-the-independent-worker"></a>
## Install the independent worker

The worker must be supervised separately from Gateway so that restarting Gateway does not kill its applier. On Linux, place the same private bootstrap settings in `/srv/harness/gateway-data/node-launch.env` for both units and install [harness-gateway-config.service](../harness-gateway-config.service) beside [harness-gateway.service](../harness-gateway.service). Enable the configuration unit after the Gateway's first initialization. The restart target defaults to `harness-gateway.service`; `HGW_GATEWAY_SERVICE` changes that host-owned unit name.

On macOS, use the installed [release controller](../macos/release-control.sh) and [configuration LaunchAgent template](../macos/config-agent.plist). Replace every `ACCOUNT` and adjust any nondefault service label or controller path, then save the owner-private plist as `~/Library/LaunchAgents/com.maycran.harness-gateway-config.plist`. Validate it with `plutil -lint`, then load it with `launchctl bootstrap gui/$(id -u) <plist-path>`. The separate agent uses the same stable `HOME` and bootstrap environment as Gateway, with label `<Gateway label>-config` and arguments `config watch`. Its logs belong in the private host configuration directory. The controller restarts an installed configuration agent after release activation. Configuration apply and release activation share the activation lock.

`HGW_CONFIG_APPLIER_POLL_MS` controls the worker's serialized probe interval, defaults to 5000 ms, and accepts 1000–60000 ms. A probe without a pending operation performs no database or restart work. Failed requests require a new explicit apply; the worker does not retry them continuously.

<a id="local-recovery"></a>
## Local recovery

Run these commands from the release root with the same private bootstrap environment as the service. The macOS controller also exposes them as `config status`, `config apply` and `config recover`.

```sh
node gateway/lib/node-config-cli.js status
node gateway/lib/node-config-cli.js apply
node gateway/lib/node-config-cli.js recover
```

`apply` consumes an explicitly queued revision. `recover` preflights and reinstalls the retained previous values when the Web page is unreachable. Failure preserves diagnostics and does not reopen maintenance. After loss of the database lease, the interrupted worker stops publishing files; a new lease holder resolves the recorded applying state. A crashed process can leave a configuration or activation lock: stop competing services and verify the recorded process has exited before an operator removes its lock. File age alone does not establish abandonment.

<a id="data-and-verification"></a>
## Data and verification

Changing `HGW_USERS_ROOT` or `HGW_PROJECT_RUNTIMES_ROOT` changes runtime `DSH_HOME`. Database-recorded user `HOME`, project mounts, User Documents and external-member bindings stay at their existing locations. The applier neither copies project source or SSH workspaces nor rewrites custom provider paths. A systemd user HOME outside the candidate users root requires a coordinated migration before applying that root; local runtimes may retain their original HOME. Project allocation settings affect new projects only.

Prepare a destination with identical owned file membership, bytes, permissions and ownership while all writers are stopped in maintenance. A copied `managed-data.jsonl` still names its old absolute paths and cannot qualify unchanged. Save the desired settings, then put the runtime's complete reviewed candidate roots, including retained custom and HOME-owned roots, in the private `HGW_MANAGED_DATA_APPROVAL_FILE`. From `gateway/`, run `pnpm pg:deploy inventory adopt --runtime user:<public-id> --configuration-revision <saved-revision> --replace-reviewed` (or `project:<public-id>`) for each moved runtime. The command verifies current node identity and the saved revision, preserves the copied original under the current backup directory's `inventory-adoptions/`, and replaces only the candidate inventory. It neither applies settings nor changes the database connection. Ordinary adoption without these flags still appends historical records.

Apply and restart only after preparation. Preflight checks the candidate's actual ownership against all expected moved and retained roots, then verifies data bytes and metadata. Missing, stale or extra claims reject application. Absolute old-location references in environment, patch, profile or grant files, and executable YAML that cannot establish its storage locations, require a separately reviewed migration; the applier does not guess replacement strings. Moving a key file requires the same key bytes and is separate from key rotation. Changing a database credential file cannot select another database; use the [coordinated maintenance procedures](../postgres/README.md) for data migration.

Backup restoration preserves current node configuration and database connection files. A backup's node settings can be inspected from the backup list without applying them. Incompatible stored-data locations reject restoration before database writes. Restoration advances the database write epoch, invalidating configuration requests approved against the previous data generation.

The [applier decision](../../../.agents/notes/implemented/architecture/2026-09-27-current-node-configuration.md) records ownership and recovery rationale. Linux resource controls require systemd; macOS local runtimes retain the documented trusted-host restriction. An unavailable platform or service manager is a failed validation, not a successful application.
