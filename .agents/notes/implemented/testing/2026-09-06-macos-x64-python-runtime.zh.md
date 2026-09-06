# Agent Note：Python runtime 发布 macOS x64 原生 wheel

状态：已实现

[English](2026-09-06-macos-x64-python-runtime.md) | 中文

## 问题

Python SDK runtime 的 manifest 和发布 workflow 已经提供 Linux x64/arm64、macOS arm64 与 Windows x64，但 Intel macOS 没有原生 executable 或 wheel，尽管 runtime builder 已经将平台和架构分开建模。

## 决策

将 `macos-x64` 加入一等 runtime target，使用 `macosx_14_0_x86_64` wheel 标签，并像 macOS arm64 一样提供 ripgrep 与 node-pty spawn-helper 伴随文件。平台探测、发布 staging、部署目标检查、workflow target 选择和 Python resolution 测试全部使用共享 manifest。现有 arm64 target 和 carrier 命名保持不变。

## 考虑过的替代方案

**通过 Rosetta 发布 arm64 wheel。** 拒绝，因为原生 x64 构建不依赖转译假设，也匹配 Intel macOS CI 使用的主机架构。

**发布一个 universal2 macOS wheel。** 拒绝，因为 runtime executable 和 native spawn helper 是按 target 构建的产物，而现有发布 builder 与 manifest 已经按每个 wheel 一个目标平台发布。

**在 Python resolution 中添加临时 fallback。** 拒绝，因为平台支持必须同时反映在 manifest、wheel builder 和发布检查中。

## 结果

发布矩阵新增一个原生 macOS runner 和一个 wheel。Intel macOS 用户可以使用与 arm64 相同的生产 carrier 约定；部署目标校验现在接收所选平台，而不是假定 arm64。

## 验证

三个聚焦 Python 测试模块通过（26 个测试），CI workflow parser 和 executable-builder 测试通过（14 个测试），manifest 仍是 wheel 标签和 executable 名称的单一来源。
