# Agent Note：Win32 目录对话框前台激活

Status: implemented

[English](2026-09-20-win32-directory-dialog-foreground.md) | 中文

## 问题

上游 `dsh-v0.1.6-alpha.2` 修复了一个本分叉同样存在的缺陷：由后台 Web Host 拉起的文件夹对话框在 Windows 上会开到所有其他窗口之后。Windows 只把前台激活授予前台进程、它启动的进程、或近期收到输入的进程——picker worker 三者都不满足。

## 决策

移植上游缓解方案。`win32-dialog-bindings` 绑定 `user32!keybd_event` 并暴露 `pressAltForForeground`，在 `Show` 前合成一次 Alt 按下（按下后抬起），使该 worker 被计为最近输入持有者。此技术是社区经验、无正式契约，因此绑定层将其文档记为尽力而为：在安全桌面或受限远程会话中可能失败；而对本就有前台权的调用方（控制台启动的 CLI），这次 Alt 是惰性的，但可能让焦点窗口的菜单栏短暂高亮。

## 备选方案

**把对话框所有者设为 shell 窗口，或在 `Show` 后调用 `SetForegroundWindow`。** 否决：两者仍需要 worker 本不具备的激活授权；Alt 按键是唯一制造授权本身的手段。

**通过 `AttachThreadInput` 把对话框挂到浏览器窗口。** 否决：跨进程输入挂接比同进程合成按键更侵入，且 Web Host 没有可让渡的稳定窗口句柄。

## 影响

worker 在普通桌面上获得前台授权；COM/对话框生命周期的其余部分不变。调用方不感知这次授权尝试——失败时退化为原先的窗后行为，而非新增错误。

## 测试

`pnpm exec vitest run packages/host/directory-picker-native`——47 通过、1 跳过，覆盖 `keybd_event` 绑定契约、logic spec 中 `pressAltForForeground` 先于 `Show` 的调用次序，以及 win32 对话框 spec 的能力探针。
