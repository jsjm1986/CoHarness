# Agent Note：Release 校验要求 session-format 载荷

状态：已实现

[English](2026-09-17-release-session-format-payload.md) | 中文

## 问题

编译后的 Gateway `runtime-api.ts` 导入 `@deepseek-ai/dsh-session-format` 及其 `/surface` 子路径，`build:production` 也已生成 `gateway/node_modules/@deepseek-ai/dsh-session-format` 链接并要求构建出的 `lib/index.js`。但 macOS release 控制器的 `validate_release` 和部署布局说明仍只列 `dsh-llm`，缺少 session-format 载荷的 release 能通过激活，直到运行时才失败。

## 决策

`validate_release` 在切换 `current` 前要求 `packages/session/session-format/lib/index.js` 与 `lib/types/surface.js` 都存在，与编译图实际导入的两个说明符一致。部署 README 补上了 `packages/session/session-format/` 复制步骤与对应生成链接。

## 已考虑的替代方案

**信任构建自描述。** 否决：控制器校验的是只复制目录过来的 release 树；缺少的兄弟包要到运行时执行导入时才暴露。

**校验所有 workspace 导入。** 否决：`build-production` 里的 `GATEWAY_RUNTIME_PACKAGES` 是独立运行图包清单的唯一枚举归属；与它对齐让同一事实只留在一处。

## 影响

缺少 session-format 载荷的 release 在 `current` 移动前被拒绝，回滚目标得以保留。仅含源码的旧 release 仍可作为回滚目标。今后加入 `GATEWAY_RUNTIME_PACKAGES` 的 workspace 包必须同时扩展这份校验清单和部署复制步骤。

## 验证

`gateway/tests/macos-release-control.spec.ts` 在 `current` 切换前拒绝缺少任一产出文件的编译版 release，既有激活、回滚和清理用例仍然通过。

## 相关

- [原子化 macOS Gateway 发布](../process/2026-08-18-atomic-macos-gateway-releases.zh.md)——本次校验所扩展的控制器契约。
