# Agent Note: Windows node enrollment

Status: implemented

English | [中文](2026-11-04-windows-node-enrollment.zh.md)

## Problem

The [multi-computer design](../../proposed/architecture/2026-10-28-multi-computer-personal-runtimes.md) deferred Windows nodes entirely: enrollment, probe and directory schemas admitted only `darwin`/`linux`, the agent process exited on other platforms, and the credential and connection state checks evaluated POSIX mode bits and `getuid`, which do not exist on Windows.

## Decision

`win32` is now a third admitted node platform. Enrollment, leases, heartbeats, disconnect and the control channel run unchanged; the wire protocol and identity model are platform-neutral already, so the change is confined to platform schemas, the agent's private-file boundary and one PostgreSQL check constraint. Enrollment still reports `executionReady: false`: a connected Windows node proves connectivity only, and Windows local Runtime execution, service hosting and resource-pressure sampling remain separate work.

`gateway/src/node-private-file.ts` owns the private-state boundary on both platforms. POSIX keeps the existing open-handle check (`mode & 0o077` plus `uid === getuid()`); Windows evaluates the file's ACL through a bounded PowerShell `Get-Acl` probe and accepts only the caller SID plus `S-1-5-18`/`S-1-5-32-544` (LocalSystem and Administrators — the OS-boundary equivalents of owner access), with any Deny or foreign Allow ACE failing closed. `O_NOFOLLOW` is inert on Windows, so the path is re-checked for a reparse point through `lstat`; fresh state files are tightened with `icacls /inheritance:r` after the atomic rename. Directory `fsync` fails on Windows (EPERM), so the durability flush is skipped there — NTFS journals the rename itself.

## Alternatives considered

**Keep rejecting `win32` until the full Windows execution stack lands.** A connectivity-only node is a legitimate intermediate state the protocol already carries (`executionReady: false`), and refusing enrollment delays real verification of the control plane, credential lifecycle and ACL boundary without protecting anything the refusal model does not already gate.

**Treat Windows file privacy as satisfied by user-profile inheritance.** `%USERPROFILE%` ACLs are private by default but say nothing about files placed elsewhere (`HGW_NODE_AGENT_STATE_FILE` is configurable). The explicit ACL check plus post-rename tightening preserves the same owner-boundary invariant as mode 0600 on any path.

## Consequences

Windows x64/arm64 computers can enroll, hold leases, serve control-channel probes and forward existing Gateway services once configured. `deploy/windows/node-agent-task.ps1` registers the compiled entry as the `HarnessNodeAgent` Scheduled Task (SYSTEM, at startup, restart-on-failure), and `GatewayNodeConnection.start` dispatches `schtasks /Run`; the local Runtime supervisor/owner path, kernel-boot identity and pressure sampling remain POSIX-only and gate actual execution. Both `node-agent.ts` and `node-connection.ts` share `node-private-file.ts`, so the private-file contract stays single-sourced; Windows privacy anchors on the file's owner SID plus SYSTEM and Administrators rather than the reader's account, so an operator-written setup file stays private to a SYSTEM-hosted agent.

## Verification

`tests/node-private-file.spec.ts` covers both branches: POSIX accepts/rejects on mode bits, Windows accepts the tightened ACL, rejects a widened grant, a symlinked path and a vanished file. `tests/node-access-postgres.spec.ts` asserts `freebsd` stays refused while `win32` enrolls. A Windows Server 2025 host enrolled against a live center: `enrolled` → `connected` with `executionReady:false` → `channel-ready`, heartbeats renewed the 30s lease, an admin-initiated probe returned `platform:win32/architecture:x64`, and a killed agent's lease lapsed before credential-persisted reconnect resumed at epoch+1. The CI `windows-native` lane owns repeat coverage.
