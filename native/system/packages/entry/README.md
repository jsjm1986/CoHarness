---
description: "JavaScript entries for prebuilt Landlock, asynchronous POSIX flock and directory handles."
kind: "package-library"
---
# @deepseek-ai/node-addon-system

English | [中文](README.zh.md)

The `./landlock-run` entry exports the Landlock launcher path, enforcement probe, grant arguments, and protocol constants. The independent `./flock` and `./directory` entries export `tryLockExclusive(fd): Promise<void>` and `DirectoryHandle`. Importing an entry does not load `system.node`. The package has no root export.

`probe()` uses a 2000-millisecond deadline by default; `timeoutMs` selects the bound. A timed-out probe force-kills and joins its native client before returning `unusable`. Client closure does not establish kernel support or permit unconfined execution.

The lock operation attempts `LOCK_EX | LOCK_NB` asynchronously. Keep the caller-owned descriptor open until completion; contention rejects with `EAGAIN`/`EWOULDBLOCK`, other syscall failures also reject, and errors carry their code, positive errno, and `syscall: 'flock'`. Native setup errors reject the same promise. Closing the last descriptor for the open file description releases the lock. The binding does not open, duplicate, close, or explicitly unlock descriptors.

`DirectoryHandle.open(path)` owns a directory descriptor; `openChild(name)` traverses one real child without following a link, `read(count)` streams at most 65,536 entries per batch, and `createDirectory(name)` uses the retained parent. Absolute opens refuse links only in the final component; callers excluding ancestor replacement walk from a filesystem-root handle through every segment. Calls are serialized and `close()` waits for previously admitted work. Children own independent descriptors; callers close every handle. See the [directory behavior contract](../../docs/directory-contract.md).

`volumeIdentity()` reads the retained descriptor's filesystem UUID on macOS. Other POSIX platforms and zero UUIDs return absence; native failures reject. Persistent callers must also verify inodes and directory ownership. This operation requires matching JavaScript and native payloads from version 0.1.4 or later.

Optional OS/CPU platform packages carry the binaries. Linux has `bin/landlock-run` and separate `bin/glibc/system.node` / `bin/musl/system.node`; macOS has `bin/system.node`. Missing or unloadable bindings reject locking or directory access, without installation-time compilation. Landlock remains a separate executable with its existing fail-closed protocol; unsupported kernels/platforms probe unusable.

The three C sources ship for auditability. See the workspace [architecture](../../docs/architecture.md), [support matrix](../../docs/support-matrix.md), and [CLI contract](../../docs/cli-contract.md).
