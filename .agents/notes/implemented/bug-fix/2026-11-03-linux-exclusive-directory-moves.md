# Agent Note: Linux exclusive directory moves without a libc wrapper

Status: implemented

English | [中文](2026-11-03-linux-exclusive-directory-moves.zh.md)

## Problem

Linux can provide the exclusive `renameat2` system call while its C library exposes no corresponding function. Binding only that function prevents directory moves on musl even when the kernel and filesystem support them.

## Decision

The [directory mover](../../../../packages/attachment/userdoc-local/src/directory-move.ts) invokes `renameat2` through `syscall` on Linux x64 and arm64, using their fixed Linux ABI numbers. Both parent descriptors and the exclusive destination flag remain explicit arguments. Errors retain their logical operation name and native error code. Other Linux architectures retain their C library binding; macOS and Windows use their existing native operations.

The [document isolation rules](../architecture/2026-10-26-document-private-paths-and-staging-names.md) remain independently applicable. Unsupported kernels and filesystems refuse the operation. No path uses a replacing rename as a fallback.

## Alternatives considered

**Require a libc wrapper.** musl does not supply it, so kernel support alone cannot make the operation available.

**Check the destination before a replacing rename.** A concurrent writer can occupy the name after the check and lose its directory.

**Bundle a second native addon.** The existing FFI dependency can invoke this fixed Linux ABI without another build or distribution path.

## Consequences

The Linux x64 and arm64 ABI constants must remain architecture-specific. The operation retains its parent handles, post-move verification, synchronization and cleanup behavior. No document format or public API changes.

The real filesystem cases cover occupied destinations, replacement of either parent and capture between public and private roots. Native-call interference also creates an occupied destination immediately before the actual rename. The runnable Loader [example](../../../../packages/attachment/userdoc-local/tests/fixtures/parts-driver.mjs) observes a refused collision and a successful retry preserving the directory object and document bytes.
