# @deepseek-ai/dsh-tool-cordis

[English](README.md) | 中文

## 概述

只读发现 Host 和 Client API，以及已有的会话所属 Cordis Package。创造模式将这些工具与[插件管理器](../../boot/plugin-manager/README.zh.md)组合使用，由插件管理器的安装流程负责持久化 Profile 变更。

## 使用方式

将工具集与提供检查注册表的 [Cordis Host 运行器](../cordis-host-runner/README.zh.md)一同加载。先用 `cordis_inspect_list` 发现提供者，再用 `cordis_inspect_query` 查询确切 API。`cordis_inspect_self` 读取已有 Plugin 摘要、版本指针或指定 Package 的源码与诊断。显式 `@pluginId` 引用为当前会话所属定义补充只读上下文。

工具集不能定义、激活、停止或移除动态 Plugin。这些退役工具名称会被工具执行器拒绝。历史定义卡片和生命周期卡片仍可读取；读取日志不会重新创建运行时副作用。持久化修改使用已安装的 `cordis-plugin-development` 技能及插件管理器的授权路径。[退役决策](../../../.agents/notes/implemented/simplification/2026-09-22-retire-dynamic-cordis-model-tools.zh.md)说明安全与兼容范围。

## 实现

Host 提供者将生成的 [API 目录](src/api-catalog.ts)与请求 Agent 的实时工具注册表结合。Client 提供者同步清单，并从已连接页面回答查询。检查返回数据，不调用业务服务方法。工具、提供者、提示词和引用监听器均由 Cordis effect 持有；卸载插件会移除这些注册。

检查直接读取其提供者，不维护独立运行时投影，因此不发布不变量伴随模块。工具集没有配置；查询传输及保留的动态定义由 Host 运行器负责。

## 模型体验

### 运行时检查

#### 模型看到什么

[三个只读工具 schema](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-cordis)、[检查指引](src/prompt.ts)及确切查询结果。只有显式指定 Plugin 和 Package 才返回 Package 源码。API 声明描述可用接口，不授予执行权限。

#### Token 影响

插件可见时，schema 和指引进入请求。结果追加到历史；定向查询避免引入无关声明。

#### KV Cache 影响

未变化的 schema 和指引保持前缀稳定。结果追加到历史，其他插件的变化可能改变后续工具 schema。

## 已知限制与后续工作

- Client 查询需要页面响应或取消。
- 会话所属动态引用仅存在于当前进程，重启后可能不可用。检查不会恢复定义或执行日志中的代码。
