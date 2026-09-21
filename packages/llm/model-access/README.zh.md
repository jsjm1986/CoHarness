# @deepseek-ai/dsh-model-access

[English](README.md) | 中文

精确 `(provider, model)` 路由的部署侧授权 Service Definition。`ModelAccessService` 是发布为 `ctx.modelAccess` 的运行时接口，实现可以是普通对象；`ModelAccessPolicy` 是供树内 provider 选用的 Cordis `Service` 基类。消费方使用同一决策过滤目录、控制模型选择并约束执行。服务缺席表示未挂载模型授权策略。

## 概述

使用 `dsh-model-access` 作为部署方自有、精确到 `(provider, model)` 路由的授权服务定义：目录、模型选择与执行共用同一个 `ctx.modelAccess` 决策；服务缺省即表示未挂载授权策略。


## 模型体验

没有直接影响；授权接缝仅放行或拒绝路由，不贡献任何模型输入。

#### KV Cache 影响

无；本包从不组装或发送提供方请求。

## 已知局限与延后工作

- **不持有策略存储**——部署必须挂载拥有策略持久化与刷新语义的 provider。
