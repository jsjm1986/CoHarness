# extensions/：agent（智能体）修改自身运行时

[English](README.md) | 中文

agent 修改自身运行时：检查已加载的插件与服务接口、定义并运行模型编写的动态包（dynamic package）并再次撤下，外加受限 repository Plugin 运行时。两个浏览器半的包住在这里而不是 `packages/client/`，因为它们是本子系统双半包的其中一半；host 聚合把它们排除在外，让两个契约面各自保有独立的编译 program。设计居所：[工具集 Agent Note](../../.agents/notes/implemented/feature/2026-07-08-self-referential-cordis-toolset.zh.md)。

| 包 | 角色 | ctx 键 |
|---|---|---|
| [`tool-cordis/`](tool-cordis/README.zh.md) | `cordis_inspect`／`cordis_define`／`cordis_run`／`cordis_stop`／`cordis_undefine` 工具：读取当前进程运行时，并在一个自有分组 fiber 下管理内存中的动态包 | 注册到 `ctx.tools` |
| [`cordis-host-runner/`](cordis-host-runner/README.zh.md) | 定义注册表、host 半的 `node:vm` 沙箱，以及 request-run 往返 | 提供 `ctx.dynamicCordisRunner` |
| [`cordis-client-runner/`](cordis-client-runner/README.zh.md) | 双半包的浏览器半：把定义求值成活的浏览器插件，并应答运行请求 | client 面；提供浏览器侧 `ctx.dynamicCordisRunner` |
| [`ui-cordis/`](ui-cordis/README.zh.md) | 浏览器面：操作全部定义的全局面板，与只读的 define 卡片 | client 面；注册 slot |

[extensions 子系统页](../../docs/subsystems/extensions.zh.md)记录生成的 `ctx.cordisInspect` 与 `ctx.dynamicCordisRunner` 服务 API。


## 概述

extensions 组为 agent 提供只读运行时 API 发现、供程序和浏览器消费者使用的进程内 runner，以及历史生成插件卡片。Creator 模式通过 [Plugin Manager](../boot/plugin-manager/README.zh.md) 安装持久化插件。按需选择检查、Host 执行、Client 执行或浏览器控件子包。
