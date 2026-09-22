# dsh-persona

[English](README.md) | 中文

把 agent（智能体）人设做成一个可组装的行：它既可以遮蔽部署级人设，也可以拥有完整系统提示词。

[`dsh-system-prompt`](../../core/system-prompt/README.zh.md) 以自身配置持有部署级人设，并且无条件注册该段落，因此一个进程只有一份。[agent preset](../agent-presets/README.zh.md) 无法自行挂载提示词注册表——若没有属于自己的行，preset 能改变 agent 的工具，却永远改不了它的身份。本包就是那一行。

## 概述

`dsh-persona` 让单个 agent（智能体）拥有自己的人设：preset 挂载这一可组装的行来注册人设前缀与后缀段落，为该会话遮蔽部署级默认值。它还可以把前缀变成该会话的完整系统提示词、抑制所有其他段落，并可为该会话关闭动态 runtime-context 快照。请把它挂在 preset 组装内部——全局挂载会与提示词注册表自身的人设注册相撞并明确报错。没有这一行，preset 能改变 agent 的工具，却永远改不了它的身份。

## 仅限 scope 内使用

在 agent scope 之外挂载本行，会与注册表自身的 `deployment:persona-prefix` 注册相撞并明确报错。这不是需要绕开的限制：部署级人设已经有归属，而本行存在的意义正是为某一个 agent 遮蔽它。请把它挂在 preset 组装内部，由 preset 的挂载过程提供 agent scope。

## 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `text` | 必填 | 作为 `deployment:persona-prefix` 段落渲染的人设文本 |
| `complete` | `false` | 组装后将此人设恢复为唯一的系统提示词段落 |
| `includeRuntimeContext` | `true` | 是否为此 agent 作用域包含动态 runtime-context 快照；false 会抑制所有上下文贡献，但不禁用拥有它们的服务 |

`text` 与任何提示词段落一样是模板：完整的 `{{…}}` 组在提示词**渲染**时（而非组装时）严格解析为已注册的提示词变量。空文本同样占据该槽位，因此会把部署级人设整个遮蔽掉，然后在渲染时消失。启用 `complete: true` 时，组装仍会解析上下文、工具、变量和协作式监听器，之后提示词注册表将这份确切人设恢复为唯一段落；身份、工具引导或监听器都无法追加提示词文本。启用 `includeRuntimeContext: false` 时，此作用域的上下文提供方不会被求值，组装监听器添加的上下文也会被丢弃。

## 不变量

**运行时不变量：** 未发布配套入口。本包贡献一行声明式组合；解析后的提示词由 preset 组合拥有。

## 模型体验

### 人设段落

#### 模型看到什么

位于 order `0` 的 `deployment:persona-prefix` 段落携带本行的 `prefix`；位于 order `10200` 的 `deployment:persona-suffix` 在第一方指导之后携带其 `suffix`。两者分别替换对应的部署默认值，并解析提示词变量。在完整模式下，模型只会看到渲染后的前缀段落作为系统提示词。Runtime context 默认保持启用；禁用后，新建 agent 不会收到来自沙箱策略、批准策略、委派或其他 system-prompt 上下文提供方的 runtime-context 快照。

#### Token 影响

对给定 preset 而言是固定的：该 agent 的每次请求都携带人设前缀与后缀的 token，其他 agent 一个都不带。空文本不贡献任何 token。完整模式会移除该 agent 的其他所有系统提示词 token。

#### KV Cache 影响

渲染后的模板变量与文本不变时，前缀保持稳定。模型、前缀与工具一致时，后缀变化不改变前置指令。前缀变化会影响靠前的前缀；不保证提供方共享缓存。

## 已知限制与暂缓事项

- **不支持全局挂载** —— 提示词注册表拥有未加 scope 的人设槽位，因此本行只能从带 scope 的组装中使用。要改变部署级人设，应在 `system-prompt` 行自身的配置中修改。
