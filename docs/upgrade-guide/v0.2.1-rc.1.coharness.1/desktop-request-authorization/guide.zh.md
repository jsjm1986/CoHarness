---
kind: upgrade-guide
description: "桌面应用路由在启动和重载期间始终要求当前浏览器认证。"
---

# 升级桌面请求授权

[English](guide.md) | 中文

## 变更

`@deepseek-ai/dsh-host-open-in-app` 除 `webServer` 和 `subprocess` 之外还必须依赖 `connection`。缺少认证服务时不注册其路由。认证服务撤下或插件卸载期间暂停的请求收到 503；当前浏览器认证的拒绝保留原有状态。目录应用列表、图标结果和每次新的启动交接均要求当前授权。已经打开的桌面应用仍保持独立生命周期。

## 操作

重新构建并部署主机包，在自定义桌面组合中包含这三个服务。不要通过缺省 Connection 提供者来暴露匿名桌面路由。云端 Web bundle 仍不挂载该能力，无需迁移数据。
