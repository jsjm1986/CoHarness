---
kind: upgrade-guide
description: "原生和命令行 Cua Driver 的桌面检测及 DesktopStatus 不可用响应要求更新配置和客户端。"
---

# 桌面环境可用性

[English](guide.md) | 中文

## 变更

原生和命令行 Cua Driver 提供方的 `desktopMode` 默认为 `auto`。未检测到图形会话时，提供方只发布不可用状态与模型说明，不启动驱动或其工具。桌面会话信息不代表系统权限或账户授权。外部 VNC 目标与另行配置的无头浏览器保持独立。

`desktop.status` 除完整确认和 `null` 外，还可返回 `{ unavailableReason: 'headless' | 'disabled' }`。因该限制拒绝的确认操作返回 `desktop-unavailable`，原因位于 `details.reason`。浏览器先说明环境限制，再决定是否提供确认操作。

受管运行时即使未配置驱动，也会加载只读的 `gateway-execution/desktop-availability` 插件。启动就绪检查等待其元数据，匹配版本的客户端可通过 `host.describe.computerUseUnavailableReason` 在连接恢复期间说明限制。这些元数据不授予桌面权限；已注册提供方负责报告实际可用性。

## 迁移

1. 一起更新 Gateway、Runtime 与 Web 客户端。`DesktopStatus` 的消费者先处理不可用响应，再读取确认字段。确认类型化的 `host.describe` 客户端在解码后保留可选的 `computerUseUnavailableReason` 字段。
2. 普通本机桌面与无 GUI 服务器保持 `desktopMode: auto`。`disabled` 关闭此提供方的桌面工具。对于已准备好但无法自动发现的桌面，或连接远端桌面的可执行包装器，明确设置 `enabled`；系统权限和受管用户授权仍然有效。
3. 打开所选电脑的 Admin 部署或桌面配置，确认桌面提示对应这台电脑，再检查用户端桌面对话框。无 GUI 服务器会显示说明且不提供确认按钮；文件、终端及已配置的无头浏览器仍受各自权限管理。
