---
description: "English | 中文"
kind: "package-reference"
---

# @deepseek-ai/dsh-host-directory-picker-native

[English](README.md) | 中文

[目录选择 seam](../directory-picker/README.zh.md) 的**原生 OS 选择器后端**：`NativeDirectoryPicker` 以 `native` 能力注册 `ctx.directoryPicker`，其 `pick(signal)` 每次调用打开一个原生选择器并解析出所选绝对路径（取消时为 `null`）。平台工具不经 shell 调用：macOS 使用 `osascript`，Linux 使用 Zenity 并以 KDialog 回退；调用方的中止信号会终止原生进程。Windows 在 spawn 的子进程中打开现代 `IFileOpenDialog`——由 koffi 在子进程主线程上驱动的 COM 会话，采用宿主接受的最佳线程 DPI 感知（优先 per-monitor-v2），中止时向对话框线程投递 `WM_CLOSE`。在 `Show` 之前，子进程立即通过 `keybd_event` 合成一次 Alt 按键，让对话框即使由后台宿主进程 spawn 也能激活为前台窗口。只有操作者坐在宿主屏幕前时才可用——远程部署应组合 [`-browse`](../directory-picker-browse/README.zh.md)。命令边界（`DirectoryPickerRunner`）与平台事实可注入。共享的免 shell 子进程运行器位于 [`dsh-native-command`](../../util/native-command/README.zh.md)。

POSIX 命令输出仅移除一个末尾 LF。此前的回车和其他换行仍属于所选目录名；空选择返回 `null`。

每个服务实例拥有其已接受的选择任务。卸载提供方或 Host 会中止这些任务并等待其 promise；保存的旧能力对象拒绝新的选择。POSIX 取消会等待每个直接辅助进程及其捕获流关闭。取消单个调用方不会撤下提供方，也不会取消其他调用方。

Windows 结果会等待工作进程关闭及未完成的窗口关闭调用。取消会重试 `WM_CLOSE`，随后请求强制终止无响应的子进程。终止请求被拒绝时，选择任务会持续等待进程关闭。观察到工作进程退出后，会取消延迟准备的窗口消息。

本包提供 Host 后端。匹配的浏览器交互属于 [`dsh-client-ui-directory-picker-native`](../../client/ui-directory-picker-native/README.zh.md)。[自动选择器](../directory-picker-auto/README.zh.md) 同时挂载这两个包；显式组合需要包含两个条目。

## 概述

坐在宿主屏幕前的操作者通过操作系统的选择器选取工作区目录。本 Host 后端返回所选路径并保留文件名字符，取消时返回 `null`。自动选择器将其与匹配的浏览器交互组合。远程部署使用[浏览后端](../directory-picker-browse/README.zh.md)。

## 目录

- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="model-experience"></a>
## 模型体验

无。GUI 宿主的目录选择后端不注册任何面向模型的内容。

#### KV Cache 影响

无；该包既不组装也不发送提供方请求。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延期工作

- **Linux 依赖桌面工具**——Zenity 与 KDialog 均未安装时，`pick` 以包含解决建议的错误拒绝；它不会回退为手输路径提示（组合层面的回退是 browse 后端）。
- **Windows 没有机制级回退**——通过打包依赖 koffi 运行的子进程选择器是唯一原生层级，因此 COM 拒绝或对话框崩溃会直接上报失败。组合层面的回退仍是 browse 后端。
- **Windows 前台授权依赖注入的输入**——子进程在 `Show` 之前合成一次 Alt 按键，对话框才能从后台宿主取得前台；在合成输入被抑制的环境（安全桌面、受限远程会话、提权前台窗口）中，对话框仍可能在其他窗口后面打开。该技术仅在 Windows 11 上验证过。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
