---
kind: upgrade-guide
description: "托管 Web 文档存储在插件激活前根据继承的启动凭据通道标记进行选择。"
---

# 升级托管 Web 文档启动

[English](guide.md) | 中文

## 变更

Web 组合根据启动快照中记录的继承 `DSH_GATEWAY_CREDENTIAL_FD` 或 `DSH_GATEWAY_CREDENTIAL_FILE` 选择文档提供方。托管启动等待 Gateway 和执行身份服务，不会在这些插件加载期间激活本地文档存储。独立启动保留本地提供方。项目或用户环境文件中的值不能选择托管存储。

## 操作

部署更新后的 `@deepseek-ai/dsh-web-app/cordis.patch.yml`，并重启托管运行时。不需要迁移文档数据、轮换凭据或调用模型。通过读取当前 `gatewayRuntime` 服务选择文档存储的自定义 Web 覆盖层，必须改用启动快照中的继承凭据通道标记或显式选择提供方。未提供启动快照的原始 Loader 宿主从其继承的进程环境中进行选择。
