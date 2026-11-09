# Agent Note: Windows document storage and userDocs runtime path

Status: implemented

English | [中文](2026-11-04-windows-document-storage-userdoc.zh.md)

Verified on the live `windows-vps-47` node (Runtime generation 43, release `coharness-full-real-20261104-r50-winexec`).

## Problem

`userDocs` could not activate on Windows, which blocked every agent preset that injects it (`standard`, `cordis`, `ptc`). Four POSIX-only assumptions broke the chain end to end:

1. `gateway/src/document-storage.ts` required `process.getuid()` and judged private/protected directories by `uid` and `mode`.
2. `gateway/src/document-scope-storage.ts` validated scope records with the same `uid`/`mode` test.
3. `gateway/src/launcher.ts` set `HOME` for the Runtime child, but Node's `os.homedir()` on Windows resolves `USERPROFILE`, so the Runtime's `~/documents` expanded to the SYSTEM profile while the Gateway advertised the owner's root — `Document service root does not match this runtime`.
4. `packages/attachment/userdoc-local/src/identity-storage.ts` required a `volume` field on persistent markers; `persistentObject()` returns no volume identity on Windows, so every marker written there failed reopening with `belong to another metadata domain`.

## Decision

- `gateway/src/node-private-file.ts`
  - New `protectedDirectoryState()` — Windows verdict through a PowerShell probe: zero non-`InheritOnly` Deny rules and zero Allow rules granting modification-class rights (`WINDOWS_MODIFY_RIGHTS_MASK`: Delete, DeleteSubdirectoriesAndFiles, ChangePermissions, TakeOwnership, WriteAttributes, WriteExtendedAttributes, GENERIC_ALL, GENERIC_WRITE) to a SID outside the owner, LocalSystem (`S-1-5-18`), and Administrators (`S-1-5-32-544`). `InheritOnly` ACEs such as `CREATOR OWNER` templates are skipped — they constrain future children, never the directory itself, which is all the POSIX `mode & 0o022` ancestor test sees. Creation-only grants (CreateFiles/CreateDirectories) stay benign for the same reason.
  - `tightenPrivateFileAcl` now emits inheritable rules for directories (`ContainerInherit,ObjectInherit`) — without an inheritable ACE, children fall back to the creator token's default DACL, which on SYSTEM service tokens grants dozens of unrelated service SIDs.
- `gateway/src/document-storage.ts`
  - Windows branches for `privateDirectory`, the state-root check, and the ancestor-protection walk, reusing `privateDirectoryState`, `protectedDirectoryState`, and `tightenPrivateFileAcl`; POSIX logic unchanged. `owner` may be `undefined` on Windows. `DirectoryIdentity` keeps the raw `stat` so verdicts can read `isDirectory()`/`mode`.
- `gateway/src/document-scope-storage.ts`
  - `privateJson` now uses `privateFileState` — one cross-platform owner-only verdict for scope records instead of a POSIX-only stat check.
- `gateway/src/launcher.ts`
  - Runtime child env sets `USERPROFILE` alongside `HOME` on win32 so `os.homedir()` resolves the owner's home and `expandHomePath('~/documents')` matches the Gateway-advertised root.
- `packages/attachment/userdoc-local/src/identity-storage.ts`
  - `recordedObject()` compares `volume` only when either side carries one; Windows markers validate on device+inode alone while POSIX v2 markers keep their volume requirement.

## Alternatives considered

Trusting a Windows directory based on its POSIX mode would admit an ACL that permits other accounts to modify it. Resolving the Runtime home independently from the Gateway would allow the account to open another document root. Both the account identity and the protected filesystem object must match.

## Consequences

- The org credential key `organization-model-credentials.key` must be identical on every Gateway that serves `resolveManagedCredential`; a node-generated key cannot decrypt center-issued ciphertexts (`Decipheriv.final` AEAD failure → HTTP 500 to the runtime).
- `org-deepseek-official` uses `driver: "pi-ai"`: without `@earendil-works/pi-ai` installed, `llm-pi-ai` fails to import and `routeServed()` refuses `session.prompt` with `model-unavailable`.
- pnpm patched dependencies materialize as `*_patch_hash=*` `.pnpm` directories that differ from the unpatched layout a fresh `pnpm install` produces — release packaging must carry them, and on Windows tar-extracted file-type symlinks pointing at directories must be converted to junctions or `stat()` fails with EPERM.

## Verified end to end on Windows

- `session.create` for `standard`, `cordis`, `minimal`, `ptc` presets.
- `session.prompt` → real DeepSeek round-trip via `org-deepseek-official` (pi-ai driver, managed credential from the local Gateway) → `turn/end completed`.
- `session.history` returns durable records.
- Resumable upload protocol (`POST /api/documents/uploads` → chunk PUT with `x-dsh-chunk-sha256` → `complete`) writes the file under `C:\harness-users\admin\home\documents\` and retains the object bytes in the ACL-private store.
- `userdoc_list`/`userdoc_read` tools return the uploaded document to the agent; private roots, scope bindings, and retired stores all pass the Windows ACL privacy verdicts.

## Remaining gaps

- `session-telemetry-otel` needs the matching `@opentelemetry/exporter-logs-otlp-http` `.pnpm` payload on the node (the module itself resolves once present).
- No native-Windows CI lane yet covers these probes; the PowerShell ACL helpers are exercised only through the live deployment.
