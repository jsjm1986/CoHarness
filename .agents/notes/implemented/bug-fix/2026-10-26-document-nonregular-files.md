# Agent Note: Non-regular document files

Status: implemented

English | [中文](2026-10-26-document-nonregular-files.zh.md)

## Problem

A POSIX named pipe can occupy an ordinary document path. Opening it for reading waits for a writer, so checking its type only after opening leaves a filesystem worker and the accepted document operation pending. Cancellation of the HTTP request does not interrupt that native open. A path can also change from a regular file to a pipe between its initial metadata lookup and descriptor acquisition.

## Decision

Ordinary document reads require a regular non-link entry before opening it. POSIX descriptor acquisition includes `O_NONBLOCK`, and the opened descriptor must still report a regular file. A late replacement is rejected and its descriptor is closed. Regular document bytes and caller-owned download streams retain their existing behavior. Upload payload reads, chunk writes and identity evidence use the same nonblocking acquisition rule where their host exposes it.

The [operation drain decision](2026-10-26-document-operation-drain.md) continues to own cancellation, accepted-work joining and independent cleanup failures. Nonblocking acquisition makes those lifetimes reachable when an ordinary path contains a pipe; it does not replace their cleanup rules.

## Alternatives considered

**Check only before opening.** Another writer can replace the entry after the check.

**Use only a request deadline.** Rejecting the request does not release a native filesystem open that is still waiting for a pipe peer.

## Consequences

Document APIs reject pipes and other non-regular entries without waiting for a peer process. POSIX acquisition uses a nonblocking flag even after a successful path check; the descriptor check remains necessary because a concurrent writer can replace the entry. Windows retains its ordinary-file checks without relying on POSIX pipe semantics.

## Verification

A real FIFO keeps the earlier source reader pending until its fixture-owned process is killed and joined. The repaired source reader rejects it and exits normally. The real Loader composition checks metadata, buffered reads and streaming reads against both existing FIFOs and regular files replaced by FIFOs immediately before opening; every acquired replacement descriptor is closed. The POSIX fixture runs in its own deadline-controlled process. Windows excludes this POSIX-only case; ordinary unsupported directories still have portable unit coverage.
