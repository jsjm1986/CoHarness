# dsh-agent-tool-presentation

[English](README.md) | 中文

[agent preset](../../preset/agent-presets/README.zh.md) 用来声明「模型看到的工具是哪一种形态」的那一行：`native`（全部 schema）、`ptc`（只有 `run_code` 加一份生成的 TypeScript SDK）或 `both`；`code` 保留为兼容别名。

## 概述

在 [agent preset](../../preset/agent-presets/README.zh.md) 中使用 `dsh-agent-tool-presentation`，可固定模型看到全部原生工具 schema、只有带生成 SDK 的 `run_code`，还是同时看到两种形态。每个 preset 可独立选择，因此 native 与 PTC agent 可以共享同一进程，而不共享工具目录。选择 `ptc` 或 `both` 需要兼容的 PTC 运行时；没有该运行时的部署会在挂载时拒绝 preset，不会等到收到第一条提示词。使用本包时 `mode` 字段为必填；省略本包则沿用部署默认值。

## 为什么是一行插件，而不是把注册表搬下来

工具注册表搬不进 preset。它的消费者全在宿主平面——[`dsh-agent-loop`](../agent-loop/README.zh.md) 读它的调度器，[`dsh-apiproxy`](../../host/apiproxy/README.zh.md) 读它的 presenter 来渲染工具卡，每个工具插件都往里注册——而一个服务只有在**所有**消费者一起下沉时才能下沉。

preset 能拥有的是这份注册表的**呈现方式**。`ctx.tools.presentAs()` 只为正在挂载的那个 agent 声明，于是一个 PTC mode 会话可以和多个 native 会话同进程并存，各自看到各自的清单。[`dsh-tools`](../tools/README.zh.md) 那一行上的 `mode` 仍然是默认值，供未作声明的 agent 使用。

## 它做什么

`native` 立即生效。PTC mode 则等待 `ctx.ptcRuntime`——这是一个宿主平面服务（[`dsh-ptc-runtime-node`](../../ptc-runtime/ptc-runtime-node/README.zh.md)）：若某个 preset 在未组装运行时的部署上选择 PTC mode，本行就停在 pending，`dsh-agent-presets` 会指名此 id 拒绝挂载。另一种做法——先乐观应用——会把失败推迟到该会话的第一次请求，那时操作者对 preset 和组装都已无从下手。

`mode` 是必填而非有默认值：不带这一行的 preset 本来就会拿到部署默认值，省略它等于这一行白组装了。

一个 agent 只声明一次呈现方式。同一份组装里的第二次声明会被拒绝而不是合并：对「模型看到哪种形态」给出两个答案是矛盾，不是覆盖。

## 不变量

**运行时不变量：** 未发布配套入口。本包贡献一行在组合时消费的声明式 preset；它不拥有运行时状态。

## 模型体验

通过在 `dsh-tools` 中选择的工具呈现方式间接影响——这一行只在 `dsh-tools` 拥有的两种投影之间选择，本身不注册任何提示词、schema 或结果。

#### KV Cache 影响

没有直接的失效影响；呈现方式在 agent 组装时即固定，因此其请求前缀在该会话的整个生命周期内保持稳定。

## 已知限制与暂缓事项

- **运行时仍在宿主平面** —— preset 可以选择 PTC mode，却无法自带它所需的 TypeScript 运行时；未组装运行时的部署也就无法组装任何 PTC mode 的 preset。
