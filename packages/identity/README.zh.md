# identity/ — 共享身份

[English](README.md) | 中文

跨产品领域共享的身份值。这些值不表示经过身份验证的账户。

| 包 | 职责 | ctx key |
|---|---|---|
| [`anonymous-user-id/`](anonymous-user-id/README.zh.md) | 为遥测、反馈和 DeepSeek 请求持久化一个限定于 Harness home 的匿名关联 id | — |

[session telemetry 子系统页](../../docs/subsystems/session-telemetry.zh.md)负责承载该 id 导出的遥测特性。


## 概述

identity 组为每个 harness home 提供一个匿名 id，该安装的遥测、反馈与 DeepSeek 请求会把它附加到各自的记录上，因此离开同一个 home 的所有内容都能被识别为来自同一套安装，而无需识别用户身份。无需配置任何东西：id 会在这些功能之一首次运行时自动出现，并在文件被删除前保持稳定。本组只有一个包；本页列出本组的组成，包 README 负责细节。
