# Production deployment runbook

English | [中文](README.zh.md)

Brings the gateway online on a Linux host with systemd kernel confinement and switches the public domain over to it. Layout used throughout: gateway code at `/srv/harness/gateway`, data at `/srv/harness/gateway-data`, user directories under `/srv/harness/users`, the project-path root at `/srv/harness`, administrator-managed project data under `/srv/harness/projects/admin`, user-created project data under `/srv/harness/projects/user-projects`, shared project runtime homes under `/srv/harness/project-runtimes`, the directory guard at `/srv/harness/plugins/dsh-directory-guard`, and mandatory model governance at `/srv/harness/plugins/dsh-model-governance`.

## Prerequisites

- Linux with systemd, root access, Docker Compose, `sqlite3` for one-time import/rollback, and Node 25 (`/usr/local/bin/node`; adjust unit paths for nvm layouts). Create the non-login `harness-project` account used by shared project units, create each `HGW_PROJECT_PATH_ROOTS` directory, and grant the account the required Unix read/write access to every project directory below those roots. Each configured root becomes one top-level entry in the administrator host browser; the root itself is navigation-only, and imported projects must be strict descendants. Both managed roots must preserve runtime access for directories created later; for example: `install -d -o root -g harness-project -m 2770 /srv/harness/projects/admin /srv/harness/projects/user-projects` (use an equivalent default ACL when group inheritance is not available). The setgid parent gives Gateway-created `0770` project folders the shared runtime group.
- The pinned dsh release: `npm install -g @deepseek-ai/dsh@0.1.0-rc.5` (upgrades are a version bump + rolling restarts, never a source checkout). Note: locally uncommitted work in a dev clone (for example UI changes) is not in the npm release until it lands upstream.
- DNS/entry control for the public domain (Nginx or Cloudflare Tunnel).

## Install

From the exact release checkout, run `pnpm install --frozen-lockfile && pnpm run build:production`. The production entry builds the Harness libraries and Web application, both tree-external plugins, and the Admin SPA; it typechecks the Gateway and rejects a release missing any required CLI, Web, Gateway, Admin, plugin, administrator-overlay, or collaboration-migration payload.

1. Copy the built `gateway/` directory to `/srv/harness/gateway`; run `npm install && npm rebuild better-sqlite3 argon2` there with the production Node. `public/admin` is gitignored, so copy from the checkout only after `build:production` has produced it.
2. Copy the built `plugins/dsh-directory-guard/` directory to `/srv/harness/plugins/dsh-directory-guard` and `plugins/dsh-model-governance/` to `/srv/harness/plugins/dsh-model-governance`. The pinned npm dsh runs plugin `lib/` under plain Node, not tsx. Model governance is mandatory even when `HGW_GUARD_PATCH=off`.
3. Write the company default credentials to `/srv/harness/gateway-data/company.env` (`DEEPSEEK_API_KEY=...`, mode 600). Every runtime start copies it to `$DSH_HOME/.env`; personal keys set from Settings live in `.credentials.yaml` and outrank it, while shared project runtimes expose credential settings read-only and use the company source.
4. Start [`deploy/postgres/`](postgres/README.md), apply its migrations, and create the mode-`0600` database URL file. Import the frozen SQLite control plane or create the configured organization and compute node before starting the Gateway.
5. Create owner-private `/srv/harness/gateway-data/principal-keys` and `/srv/harness/gateway-data/runtime-credentials`, plus `/srv/harness/project-runtimes` and the project roots. Provision both managed roots with group inheritance, for example `install -d -o root -g harness-project -m 2770 /srv/harness/projects/admin /srv/harness/projects/user-projects`; directories imported through an explicit path still need an explicit `harness-project` read/write grant. Copy `deploy/harness-gateway.service` to `/etc/systemd/system/`; adjust the database URL file, `HGW_ORGANIZATION_SLUG`, `HGW_COMPUTE_NODE_NAME`, `HGW_PUBLIC_ORIGINS`, `HGW_PROJECT_PATH_ROOTS`, `HGW_PROJECTS_ROOT`, `HGW_USER_PROJECTS_ROOT`, project-runtime account/root, principal/credential directories, plugin paths, and other host paths, then run `systemctl daemon-reload && systemctl enable --now harness-gateway`.
6. A database with no users causes first boot to print the bootstrap admin password to the journal: `journalctl -u harness-gateway | grep 'bootstrap admin'`.

## Per-user provisioning

Create the user in `/admin`, then run `deploy/provision-user.sh <username>` once as root: it creates the `harness-<username>` system account and chowns `/srv/harness/users/<username>/{home,dsh}`. The personal unit is rendered automatically on every start from the user's current grants. An administrator-origin project either gets a managed `0770` directory below `HGW_PROJECTS_ROOT` or imports an existing directory selected below `HGW_PROJECT_PATH_ROOTS`; imported directories need an explicit `harness-project` read/write grant. A user-origin project remains name-only and allocates an empty directory below `HGW_USER_PROJECTS_ROOT`; the setgid/default-ACL setup above supplies the project unit's access, and the creator becomes its `rw` owner. Both origins allocate one shared runtime, support `ro`/`rw` invitations, and use the same conversation and folder scope. Project directories cannot overlap user data, runtime or credential data, Gateway/release/plugin code, user-managed project storage, or another project. Membership and personal directory-permission writes restart a live personal runtime when required; project ACL checks are request-time and do not require a shared runtime restart. Administrators retain the `danger-full-access` preset in both personal and project scopes, while a project runtime remains kernel-confined to its path.

## Database cutover and rollback

Stop the existing Gateway before the final import so no SQLite write can race the authority change. Create an online SQLite backup, import that standalone file into the configured PostgreSQL organization/node, then run `pg:backup` and `pg:restore-check`. Start the PostgreSQL Gateway only after all four operations succeed. Authentication sessions and intake tokens are deliberately absent from the import, so a new login and freshly projected instance policy are expected.

Keep the frozen SQLite backup and the exact pre-cutover Gateway artifact together. Rollback stops the PostgreSQL Gateway, restores those two artifacts, and starts only the SQLite version. Do not copy a live WAL database, run both versions simultaneously, or attempt to merge PostgreSQL writes back into SQLite. PostgreSQL remains preserved for diagnosis and a later clean cutover.

## Android shell and push providers

The Android application id is `com.coharness`. Register that exact id in JPush and, when used, Firebase and Huawei consoles. The shell can use JPush alone or combine it with FCM and optional vendor channels. Keep all credentials outside Git.

For JPush, set `JPUSH_APPKEY` as a Gradle property or environment variable when building. The shell initializes JPush only after Android notification permission is granted and remembers that consent for later launches. The module defaults to JPush `6.2.0`; enable vendor plugins with `JPUSH_ENABLE_HUAWEI`, `JPUSH_ENABLE_FCM`, `JPUSH_ENABLE_XIAOMI`, `JPUSH_ENABLE_OPPO`, `JPUSH_ENABLE_VIVO`, `JPUSH_ENABLE_MEIZU`, or `JPUSH_ENABLE_HONOR`. Huawei requires `apps/android-shell/android/app/agconnect-services.json`; FCM requires `apps/android-shell/android/app/google-services.json`. These files are deployment inputs and must not be committed.

For Gateway delivery, store the JPush Master Secret and any Firebase service-account JSON on the host with mode `0600`. Set `HGW_JPUSH_APP_KEY` and `HGW_JPUSH_MASTER_SECRET` together for JPush. For FCM also set `HGW_FCM_PROJECT_ID` and `HGW_FCM_SERVICE_ACCOUNT_FILE`. Normal Gateway startup applies PostgreSQL migration 010, which keeps FCM and JPush registrations unique per provider.

Build the shell against the deployed Web UI with a Java/Android SDK toolchain. For the current deployment use `DSH_ANDROID_WEB_URL=https://harness.maycran.com/ pnpm --dir apps/android-shell run build` and `DSH_ANDROID_WEB_URL=https://harness.maycran.com/ pnpm --dir apps/android-shell run cap:sync`, then `cd apps/android-shell/android && ./gradlew assembleRelease`. Publishing ordinary Web UI assets does not require another APK; rebuild only for native project, permission, package, icon, or notification-handler changes. A completed AI turn sends the creator's devices a notification containing the session id and event sequence, and tapping it opens the existing Web UI session.

## TLS entry and cutover

Point the public domain at the gateway and close the direct instance port. Nginx server block essentials:

```nginx
server {
  listen 443 ssl;
  server_name harness.maycran.com;
  location / {
    proxy_pass http://127.0.0.1:8899;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header Origin $http_origin;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 300s;
  }
}
```

Cutover checklist: set `HGW_PUBLIC_ORIGINS=https://harness.maycran.com` (Secure cookies switch on it), reload the entry to upstream `127.0.0.1:8899`, then **stop the previously exposed single dsh instance** (or rebind it to loopback) — after cutover nothing but the TLS entry may reach the host ports.

## Acceptance

- Gateway behavior: `HGW_ACCEPT_DATABASE_URL=postgresql://.../harness_accept bash scripts/accept-phase1.sh` (a disposable PostgreSQL database whose name ends in `_test`, `_accept`, or `_acceptance`; no API key).
- Kernel confinement: log in once as the test user so the unit starts, then `sudo bash scripts/accept-phase2.sh <user> <other-user> [ro-path] [rw-path]` — verifies peer invisibility, own-home writes, `ProtectSystem`, ro/rw grant semantics from inside the mount namespace. Re-run it after switching the session to `danger-full-access`: the kernel boundary must hold unchanged.
- Collaboration: use two test users in one project to verify shared history and participant attribution, then change one member to `ro` and confirm the composer plus direct Host write/approval paths refuse it; verify a private conversation is absent for the second member.
- Project lifecycle: create a user-origin project from an account, accept an invitation, and verify the Admin project list distinguishes administrator-origin and user-origin records. Log in as an administrator in both personal and project scopes and verify `fullAccess` is exposed; verify a regular member cannot select the preset through `/permission` or a new-session default.
- Reboot resilience: `reboot`, then confirm `harness-gateway` is active and personal/project logins re-reach working runtimes.

## macOS variant (launchd, tunnel entry)

A macOS host (e.g. an office machine behind a Cloudflare Tunnel) runs the same gateway with `HGW_LAUNCHER=local` and launchd instead of systemd: a `~/Library/LaunchAgents/com.maycran.harness-gateway.plist` (KeepAlive, RunAtLoad) execs `node --import tsx/esm src/index.ts` in the gateway directory with the PostgreSQL and other `HGW_*` variables, and the tunnel config's ingress upstream points at `http://127.0.0.1:8899`. Set explicit writable `HGW_PROJECT_RUNTIMES_ROOT`, `HGW_PRINCIPAL_KEY_DIR`, and `HGW_RUNTIME_CREDENTIAL_DIR` paths owned by the launchd account. The administrator host browser starts at `/`, and mounted external disks appear below `/Volumes`; grant the launchd process the required macOS Privacy & Security file access, including Full Disk Access when the selected directories require it. Kernel directory confinement does not exist on macOS: personal and shared project processes rely on the directory-guard plugin and ordinary account permissions, so treat a macOS deployment as a trusted-team form, not the full Phase 2 boundary. Cutover disables the previous direct-instance LaunchAgent (`launchctl bootout` and rename the plist so RunAtLoad cannot revive it).

## Upgrades and backup

Upgrade dsh: `npm install -g @deepseek-ai/dsh@<next>` on staging, run both acceptance scripts plus the collaboration smoke, then roll production runtimes one by one (`systemctl restart harness-<user>` / `systemctl restart harness-project-<id>`, or let idle runtimes pick the new binary on next access). Gateway upgrades: replace `/srv/harness/gateway`, apply PostgreSQL migrations, then `systemctl restart harness-gateway` (existing runtimes keep running, but a protocol/package change requires their rolling restart). Database: install `deploy/postgres/backup-postgres.sh` under cron, retain its restore-checked dumps, and copy successful dumps to a second machine or NAS.
