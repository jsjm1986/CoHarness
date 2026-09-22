# attachment/：持久附件能力族

[English](README.md) | 中文

持久二进制附件和命名用户文档能力族，包含本地实现与面向模型的个人文档 Consumer。

| 包 | 角色 | ctx 键 |
|---|---|---|
| `attachment/` | 不可变附件引用、图片限制和存储服务 | `ctx.attachments` |
| `attachment-local/` | `DSH_HOME` 下的私有内容寻址存储 | （注册至 `ctx.attachments`） |
| `userdoc/` | 命名用户文档引用、限额与存储服务 | `ctx.userDocs` |
| `userdoc-local/` | 一个用户可见文档根目录下的真实文件存储 | （注册至 `ctx.userDocs`） |
| `tool-userdoc/` | 面向模型的个人文档发现与读取工具 | （消费 `ctx.userDocs`） |

未发送的浏览器草稿刻意位于这项能力之外。只有用户提交提示词，或提供方适配器提交结构化模型输出时，字节才进入持久存储。

[Attachment 子系统参考](../../docs/subsystems/attachment.zh.md)负责服务契约、载荷类型与 `ctx.attachments` Cordis 面。


## 概述

`attachment/` 组提供持久图片附件：把图片附加到提示词和命令，harness 会把它保存到你的机器上，重新显示在对话历史中，并在后续轮次发送给模型。随附的 `dsh` 组合无需任何设置即可支持这一点。该能力与它的存储拆分为两个包，见下文。已存储的图片在重启后依然存在且永远不会被自动删除，并且只支持光栅图片格式。
