---
description: "计算机操作提供方注册：供每次启用一个桌面驱动的部署使用。"
kind: "package-reference"
---

# @deepseek-ai/dsh-computer-use

[English](README.md) | 中文

## 概述

部署每次可启用一个计算机操作提供方。加载另一个提供方时会失败，并报告已注册的提供方名称。各提供方提供自己的工具和桌面操作。本包不添加模型可见工具，也不协调并发 Session。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在 Cordis 组合中，将服务与选定的提供方一起挂载一次：

```yaml
- name: '@deepseek-ai/dsh-computer-use'
```

服务没有配置项。提供方插件注入 `computerUse` 并调用 `ctx.computerUse.register(ComputerUseProviderName(name))`；该品牌类型从 `@deepseek-ai/dsh-computer-use/brand` 导出。返回的 effect 清理函数释放此次注册。

提供方先停止接收工具调用、关闭资源并等待自有工作结束，再释放注册。释放前，`ctx.computerUse.providerName` 始终报告已注册的名称。

提供方通过 `ctx.computerUse.run(execution, operation)` 包裹实际桌面操作。独立本机调用保留宿主操作者权限。受管运行时要求活动 Agent 和 `computerUseAuthorization` 提供方；提供方卸载不会恢复本机权限。部署政策负责资格、会话确认和租约；取消会传入驱动，驱动结束后的已撤权结果也会被拒绝。

可选的 `computerUseAuthorization.confirmation` 控制器读取和修改交互用户的确认。操作要求活动人工请求及确切的根会话、节点和桌面，不作为模型工具。浏览器消费者从 `/types` 导入传输数据类型，不加载 Host 服务声明。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

一个私有名称占用注册位置。Cordis effect 在插件卸载时移除贡献；重复调用清理函数不会移除后续注册。[源码](src/index.ts)不持有驱动 schema，而是将受管操作委派给部署政策。

不发布 `./invariant` 伴随入口：注册表只有一个权威字段，没有可能与之分歧的独立维护观测值。所属测试覆盖重复注册拒绝和插件卸载。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [计算机操作](../../../docs/subsystems/computer-use.zh.md) — 提供方选择和共享桌面限制。
- [Cua Driver MCP 提供方](../../experimental/computer-use-cua-driver-mcp/README.zh.md) — 使用已安装的驱动。
- [Cua Driver 原生提供方](../../experimental/computer-use-cua-driver-native/README.zh.md) — 使用 npm 运行时。

-----

<a id="model-experience"></a>
## 模型体验

无，因为本服务不注册面向模型的工具或提示词片段，结果呈现由提供方负责。

#### KV 缓存影响

注册不改变模型请求。提供方拥有的工具和指导文本决定各自对请求前缀的影响。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

服务在其 Cordis 服务实例内限制注册。

- **共享桌面** — 并发 Session 和独立 DSH 进程可以操作同一桌面；调用方协调完整的计算机操作流程。
- **提供方选择** — 由配置选择提供方；模型不能在运行时切换已注册的驱动。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作背景 — 点击展开</summary>

无。

</details>
