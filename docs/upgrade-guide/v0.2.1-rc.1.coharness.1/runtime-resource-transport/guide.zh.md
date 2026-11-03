---
kind: upgrade-guide
description: "为跨网络数据库往返配置受管 Runtime 的资源请求期限。"
---

# 配置 Runtime 资源传输

[English](guide.md) | 中文

`HGW_RUNTIME_REQUEST_TIMEOUT_MS` 和 `HGW_RUNTIME_CLEANUP_TIMEOUT_MS` 配置各电脑的受管资源登记插件，默认值保留为 5000 和 30000 毫秒。结算期限必须长于单次请求；增加期限不会授予资源，也不会释放结果不确定的占用。

`HGW_RUNTIME_BROWSER_READY_TIMEOUT_MS` 和 `HGW_RUNTIME_BROWSER_STREAM_TIMEOUT_MS` 为该电脑的每个 Runtime 配置现有连接插件的浏览器握手期限，默认值保留为 15000 和 3000 毫秒。受管连接较慢时可增加；主电脑保留自己的设置。这些值不放宽认证，也不改变浏览器所选分配。

同一页面内打开的连接沿用该页面的恢复设置。需要在统一页面内切换时，入口电脑的浏览器期限应覆盖该页面使用的最慢接入电脑，同时配置该接入电脑自身的直接入口。

`HGW_RUNTIME_BROWSER_RPC_TIMEOUT_MS` 配置连接插件的有界 RPC 期限，默认值保留为 30000 毫秒。只延长握手期限不能延长单个 Host 查询；实测往返需要时应同时配置。由用户控制完成的调用及持续流维持原有生命周期。

现有配置记录无需改写。数据库往返较慢的电脑，在当前节点配置中保存按实测确定的期限，再通过现有维护窗口和独立工作进程应用。新 Runtime 代次使用已应用值，已有代次在重启前保留已加载的插件设置。参见[节点配置参考](../../../../gateway/deploy/node-configuration/README.zh.md)。
