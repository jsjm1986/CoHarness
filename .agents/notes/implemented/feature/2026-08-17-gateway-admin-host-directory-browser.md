# Agent Note: Gateway administrator host directory browser

Status: implemented

English | [中文](2026-08-17-gateway-admin-host-directory-browser.zh.md)

## Problem

The Gateway supports administrator-managed project creation by name, while its JSON API also accepts an existing host directory. The Admin SPA exposed only the managed mode, so adopting an existing project still required shell access or a manually constructed API request. A browser-native folder picker would select the administrator's client filesystem, not the Gateway host filesystem used by project runtimes.

## Decision

The administrator create dialog has two explicit modes. **Managed directory** submits `{ name }` and keeps the [managed project directory](2026-08-16-gateway-managed-project-directories.md) behavior. **Existing directory** uses an embedded Gateway host browser and submits `{ name, path }`; selecting a directory suggests its basename only while the project name is blank. The existing-directory mode never creates folders. Ordinary-user project creation remains name-only below `HGW_USER_PROJECTS_ROOT`.

`GET /admin/api/project-directories?path=<absolute-path>` returns one sorted directory level, canonical breadcrumbs, whether the current directory can be selected, hidden-directory markers, and a truncation flag. Listings contain at most 1,000 directories. The UI hides dot directories by default, exposes a toggle when they are present, and requires a selected directory before project creation.

Local-launcher browsing starts at the filesystem root. On macOS, mounted external disks are therefore reachable through `/Volumes` when the Gateway process has operating-system permission. The systemd launcher instead presents a virtual root containing only canonical `HGW_PROJECT_PATH_ROOTS` entries. Those configured roots are navigation-only; a project must be a strict descendant. `/` remains invalid in `HGW_PROJECT_PATH_ROOTS`.

Directory symlinks are followed only after canonicalization. A systemd symlink that leaves its configured root is omitted from a listing and rejected when requested directly. Gateway-owned user data, project runtime data, principal and credential data, Gateway and dsh release code, directory-guard and model-governance code, the company environment directory, user-managed project storage, user homes, and registered project directories are unavailable for selection. Ancestors remain navigable so an administrator can reach unrelated sibling directories, but they are not selectable when selecting them would include reserved data.

The browser is advisory. `POST /admin/api/projects` resolves the submitted path again and applies the same absolute-path, configured-root, reserved-directory, user-home, and existing-project overlap checks before persistence. Stable diagnostics distinguish non-absolute, missing, non-directory, inaccessible, outside-root, reserved, and overlapping paths. Renaming a project changes only its catalog name, and deleting a project retains the host directory.

## Security model

Only authenticated administrators can call the directory-listing endpoint. Local mode intentionally lets that role inspect directory names across every host tree the Gateway process can read, subject to the reserved-directory exclusions and macOS/Linux permissions. Systemd deployments keep enumeration and project mounts within administrator-configured roots, and imported directories still require Unix read/write access for `HGW_PROJECT_RUNTIME_USER`.

The remote Web browser never asks the client operating system for a directory. The separate [native workspace directory picker](2026-07-27-native-workspace-directory-picker.md) remains limited to the loopback desktop carrier and selects that carrier's local filesystem.

## Verification

Directory-browser tests cover local and systemd roots, hidden entries, sorting, the 1,000-entry limit, reserved paths, canonical symlinks, and systemd escapes. SQLite project-service and Admin API tests cover absolute-path, reserved-path, and overlap diagnostics plus administrator-only listing. Admin UI tests cover both creation modes, navigation, hidden-directory visibility, selection, basename suggestion, error recovery, and submitted payloads. A keyless real-server snapshot logs in, lists a host directory, imports it, and proves the registered directory disappears from later listings. PostgreSQL integration coverage applies the same final path policy when `HGW_TEST_DATABASE_URL` is configured.

## Alternatives considered

**Use the browser client's native folder picker.** Rejected because a remote administrator would select files on the wrong computer. Native dialogs remain correct for the loopback desktop carrier, whose trust and transport are owned by the [native picker decision](2026-07-27-native-workspace-directory-picker.md).

**Restore a free-text absolute path field.** Rejected because it exposes deployment prefixes, permits avoidable typing errors, and provides no visibility into the Gateway process's actual permissions.

**Expose the full filesystem in systemd deployments.** Rejected because project units can mount only configured project roots; showing paths that can never satisfy that isolation policy would be misleading and would disclose unrelated host layout.

**Create arbitrary folders from the directory browser.** Rejected because the approved workflow adopts existing projects, while managed mode already creates a new project directory with the required ownership and mode policy.

## Consequences

Administrators can adopt existing projects anywhere permitted on the Gateway host without shell access, while managed project creation stays the default low-input path. Local deployments gain whole-host navigation but inherit host account permissions and macOS privacy controls. Linux deployments can expose multiple storage volumes by configuring multiple project roots without weakening the strict-descendant mount rule.

The Gateway owns a bounded filesystem enumeration API and a matching final validation policy. Adding a new Gateway-owned secret or runtime directory requires adding it to the reserved-path set so both browsing and project creation continue to exclude it.
