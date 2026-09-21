# dsh-native-command

[English](README.md) | 中文

宿主原生 OS 集成共享的**零依赖免 shell `execFile` 运行器**：一次 `runNativeCommand(command, args, signal)` 调用直接 spawn 可执行文件（绝不拼 shell 字符串），以 utf8 捕获 stdout/stderr，把调用方的 abort 传播为子进程终止，并在 Windows 上隐藏瞬时控制台窗口。失败时，调用会以错误拒绝；该错误附带退出 `code` 与两路已捕获输出，调用方无需重跑即可分类（工具缺失、已取消、真实失败）。

它的两个消费方都是宿主侧原生集成：[`directory-picker-native`](../../host/directory-picker-native/README.zh.md) 后端的 OS 选择器命令，以及网关将路径交由默认应用打开的操作（[`dsh-host-apiproxy`](../../host/apiproxy/README.zh.md) 的 `host.openPath`）。`NativeCommandRunner` 类型是这些调用方的可注入命令边界。

它是**库，不是服务或插件**：没有 `ctx`、不注册任何东西、不持有状态、不发事件。

## 概述

`dsh-native-command` 无需 shell 即可运行 Host 可执行文件，并通过桌面打开 Host 文件系统路径。命令运行器捕获 utf8 输出、传播取消，并隐藏 Windows 瞬时控制台。路径打开器支持默认应用与文本编辑器意图、浏览器可渲染文档、WSL 转换与桌面可用性检查。它是库而非插件：没有 `ctx`、无状态、不发事件。

## 接口面

```ts
import { runNativeCommand, type NativeCommandRunner } from '@deepseek-ai/dsh-native-command'
```

## 不变量

**运行时不变量：** 未发布配套入口。每次调用派生一个子进程并给出其捕获的输出；进程状态不会比调用活得更久。

## 模型体验

无：宿主侧工具不注册任何面向模型的内容。

#### KV Cache 影响

此处没有任何内容进入请求前缀；本包既不组装也不发送提供方请求。

## 已知限制与暂缓事项

- **不做输出限量**——两路流在内存中无界缓冲；当前每个调用方只运行输出为一个路径或一行错误的小型原生工具。把它指向输出量可观的命令之前，先接入 `dsh-output-retention` 限量。
