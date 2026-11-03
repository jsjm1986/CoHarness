# Agent Note: 不依赖 libc 包装函数的 Linux 排他目录移动

Status: implemented

[English](2026-11-03-linux-exclusive-directory-moves.md) | 中文

## Problem

Linux 可以提供排他的 `renameat2` 系统调用，而 C 库未导出对应函数。只绑定该函数会使 musl 上的目录移动不可用，即使内核和文件系统支持此操作。

## Decision

[目录移动器](../../../../packages/attachment/userdoc-local/src/directory-move.ts) 在 Linux x64 和 arm64 上通过 `syscall` 调用 `renameat2`，使用各自固定的 Linux ABI 编号。两个父目录描述符和排他目标标记仍是显式参数。错误保留逻辑操作名称和原生错误码。其他 Linux 架构保留 C 库函数绑定；macOS 和 Windows 使用已有的原生操作。

[文档隔离规则](../architecture/2026-10-26-document-private-paths-and-staging-names.zh.md) 仍独立适用。不支持此操作的内核和文件系统拒绝操作。任何路径都不回退到会替换目标的重命名。

## Alternatives considered

**要求 libc 包装函数。** musl 不提供该函数，仅有内核支持不足以使操作可用。

**在会替换目标的重命名前检查目标。** 并发写入方可能在检查之后占用名称，导致其目录被覆盖。

**捆绑第二个原生扩展。** 现有 FFI 依赖能够调用此固定 Linux ABI，无需增加构建或分发路径。

## Consequences

Linux x64 和 arm64 的 ABI 常量必须分别对应其架构。操作保留父目录句柄、移动后验证、同步和清理行为。文档格式和公开 API 不变。

真实文件系统用例覆盖已占用目标、任一父目录替换，以及公开和私有根之间的捕获。原生调用干扰还会在实际重命名前创建占用目标。可运行的 Loader [示例](../../../../packages/attachment/userdoc-local/tests/fixtures/parts-driver.mjs) 观察冲突被拒绝，并在成功重试后确认目录对象和文档字节保持一致。
