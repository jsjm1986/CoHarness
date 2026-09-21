# credentials/：凭据引用

[English](README.md) | 中文

凭据能力家族将引用解析与提供方分离：

| 包 | 角色 | ctx 键 |
|---|---|---|
| [`credentials/`](credentials/README.zh.md) | 凭据引用 seam | `ctx.credentials` |
| [`credentials-local/`](credentials-local/README.zh.md) | 环境与本地文件提供方 | 注册 `ctx.credentials` |

配置携带引用而非机密值。消费方在其操作边界解析这些引用；变更、优先级与存储语义由子级 README 负责。

子系统参考——`CredentialRef`、按操作解析、对 UI 安全的 `CredentialInfo`、提供方层——见 [docs/subsystems/credentials.md](../../docs/subsystems/credentials.zh.md)。


## 概述

`credentials/` 组让配置引用机密的名字，而不嵌入机密值。使用 `credentials/` 存储、查询和移除凭据；使用 `credentials-local/` 将凭据私密地存储在本机，并支持按次运行的环境覆盖；当需要向人询问以获取凭据时，使用 `authorization/`。轮换后的存储值会作用于下一次模型请求，而 `DEEPSEEK_API_KEY=… dsh` 在该次运行中优先。配置文件只包含凭据名称；本地机密值只有同一 OS 用户可读。
