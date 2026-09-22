# @deepseek-ai/dsh-host-directory-picker-native

[English](README.md) | 中文

[目录选择 seam](../directory-picker/README.zh.md) 的**原生 OS 选择器后端**：`NativeDirectoryPicker` 以 `native` 能力注册 `ctx.directoryPicker`，其 `pick(signal)` 每次调用打开一个原生选择器并解析出所选绝对路径（取消时为 `null`）。平台工具不经 shell 调用：macOS 使用 `osascript`，Linux 使用 Zenity 并以 KDialog 回退；调用方的中止信号会终止原生进程。Windows 在 spawn 的子进程中打开现代 `IFileOpenDialog`——由 koffi 在子进程主线程上驱动的 COM 会话，采用宿主接受的最佳线程 DPI 感知（优先 per-monitor-v2），中止时向对话框线程投递 `WM_CLOSE`。在 `Show` 之前，子进程立即通过 `keybd_event` 合成一次 Alt 按键，让对话框即使由后台宿主进程 spawn 也能激活为前台窗口。只有操作者坐在宿主屏幕前时才可用——远程部署应组合 [`-browse`](../directory-picker-browse/README.zh.md)。命令边界（`DirectoryPickerRunner`）与平台事实可注入。共享的免 shell 子进程运行器位于 [`dsh-native-command`](../../util/native-command/README.zh.md)。

**双面包**：浏览器端（`./client`）向 [ui-workspace](../../client/ui-workspace/README.zh.md) 的两个目录流 slot 注册一个无渲染的流程占用者——每次 `open` 请求驱动 `host.pickDirectory`，并通过 slot 的属主交互约定上报唯一结果（所选路径／取消／失败）。两个目录流程声明必须同时处于有效状态，任一贡献才会安装。因此一行 cordis.yml 同时组合原生交互的两侧；客户端不包含任何按能力类型进行的分支，挂载第二个流程包会在加载期失败（slot 的 kind 为 `single`）。

## 概述

坐在宿主屏幕前的操作者通过原生 OS 选择器选择工作区目录：`dsh-host-directory-picker-native` 每次选择打开一个平台目录选择器，并解析出所选绝对路径（取消时为 `null`）。macOS 驱动 `osascript`，Linux 使用 Zenity 并以 KDialog 回退，Windows 在 spawn 的子进程中打开现代 `IFileOpenDialog`。只有操作者坐在宿主屏幕前时才可用——远程部署应组合[浏览后端](../directory-picker-browse/README.zh.md)。一行组合配置还会在工作区流程中注册匹配的浏览器侧交互，因此同时选择两侧。

## 不变量

**运行时不变量：** 未发布配套入口。每次 `pick` 派生一个平台选择器并给出其结果；选择器状态不会在调用后存活。

## 模型体验

无。GUI 宿主的目录选择后端不注册任何面向模型的内容。

#### KV Cache 影响

无；该包既不组装也不发送提供方请求。

## 已知限制与延期工作

- **Linux 依赖桌面工具**——Zenity 与 KDialog 均未安装时，`pick` 以包含解决建议的错误拒绝；它不会回退为手输路径提示（组合层面的回退是 browse 后端）。
- **Windows 没有机制级回退**——通过打包依赖 koffi 运行的子进程选择器是唯一原生层级，因此 COM 拒绝或对话框崩溃会直接上报失败。组合层面的回退仍是 browse 后端。
- **Windows 前台授权依赖注入的输入**——子进程在 `Show` 之前合成一次 Alt 按键，对话框才能从后台宿主取得前台；在合成输入被抑制的环境（安全桌面、受限远程会话、提权前台窗口）中，对话框仍可能在其他窗口后面打开。该技术仅在 Windows 11 上验证过。
