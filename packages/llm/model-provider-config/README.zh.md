# @deepseek-ai/dsh-model-provider-config

[English](README.md) | 中文

定义单个运行时可用的已启用组织级和项目级模型 Provider 的 Service Definition。Provider 实现通过 `ctx.modelProviderConfig` 发布完整且不可变的 `ModelProviderConfigSnapshot`，并且只在提交替换配置后发出 `model-provider-config/updated`，事件携带替换后的单调递增修订号。适配器 Consumer 注册这些路由，但不会把它们复制到可编辑的用户设置中。

组织路由 id 使用部署保留的 `org-*` 命名空间；项目路由使用带项目编号的 `project-<id>-<slug>` id，并携带项目编号。每个配置包含适配器驱动、线协议、端点、可选的只读凭据引用及开放模型。存储、授权、凭据解析和刷新顺序由 Provider 实现负责。

## 模型体验

间接影响，由 LLM 适配器 Consumer 将启用的组织模型提供给选择与执行流程。

#### KV Cache 影响

无直接影响。Consumer 选择不同模型或 Provider 时，可能进入独立的模型缓存命名空间。

## 已知局限与延后工作

- **不提供持久化或传输**——部署必须挂载负责投影加载、修订顺序和凭据引用传递的 Provider。
