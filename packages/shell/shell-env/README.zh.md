# @deepseek-ai/dsh-shell-env

[English](README.md) | 中文

工具无关的 shell 环境插件：拥有 `ctx.shellEnv` 注册表，管理受信任的、每次执行收集的 `DSH_*` 变量，供模型可见的 shell 工具（`dsh-tool-bash`、`dsh-tool-pwsh`）收集进每次 shell 调用的环境。内置 shell 事实（`DSH_HOME`、`DSH_SHELL=1`、`DSH_SESSION_ID`）归注册表自身所有；其他插件可以注册额外的可枚举事实，注册随插件纤维（fiber）释放，重复所有权或未声明的运行时键会响亮失败。

包根导出 Cordis 插件约定（`name`、`inject`、`Config`、`apply`）以及 `ShellEnvRegistry` 服务类及其 contributor 类型；消费方在加载本插件后使用 `ctx.shellEnv`。

## 概述

`dsh-shell-env` 提供每次模型 shell 调用——bash 或 pwsh——所运行的受信 `DSH_*` 环境：内置事实如 `DSH_HOME`、`DSH_SHELL=1` 与 agent（智能体）的 `DSH_SESSION_ID`。插件作者可以注册自己的事实，带声明键、按每次执行收集，并随插件释放；重复所有权或未声明的运行时键会明确报错，而不是静默覆盖。注册表不会改变模型看到的其他任何内容——shell 工具拥有各自的 schema 与提示词。任何挂载了模型 shell 工具的组合都适合选择它；配置只决定 Harness 主目录。

## Config

```yaml
- id: shell-env
  name: '@deepseek-ai/dsh-shell-env'
  config:
    dshHome: C:\Users\me\.dsh   # default: $DSH_HOME, then ~/.dsh
```

## Managed environment

每次前台与后台模型 shell 调用都会收到一份新收集的受信任 `DSH_*` 环境。`DSH_HOME` 是由 [`@deepseek-ai/dsh-home-paths`](../../util/home-paths/README.zh.md) 解析的 Harness 主目录绝对路径（`dshHome` 配置，然后环境变量 `$DSH_HOME`，然后 `~/.dsh`），`DSH_SHELL=1` 标识受管理的子进程。带 agent（智能体）的调用额外收到 `DSH_SESSION_ID=agent.session.header.id`；当活动的持久化 seam 定位到 JSONL 工件时，它们还会收到 `DSH_SESSION_JSONL=<绝对目标路径>`。JSONL 路径只是位置提示：首次 flush 之前它可能不存在，也不一定包含当前缓冲中的轮次，并且它不是授权凭据。

`ctx.shellEnv` 负责收集。其他插件可以注册一个受 effect 作用域约束的 contributor，带有稳定名称、已声明的键/描述以及 `resolve(execution: ToolExecution)`；重复所有权与未声明的运行时键会响亮失败，而 `list()` 只枚举声明、不执行 provider。Harness 内置键保留 `DSH_HOME`、`DSH_SHELL` 与 `DSH_SESSION_ID`；本插件的持久化翻译器通过读取与后端无关的 `sessionPersistence.locate()` seam 拥有 `DSH_SESSION_JSONL`。

```ts
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-shell-env'

export const inject = ['shellEnv']

export function apply(ctx: Context): void {
  ctx.shellEnv.register({
    name: 'deployment-region',
    variables: { DSH_DEPLOYMENT_REGION: { description: 'Current deployment region.' } },
    resolve: execution => execution.agent === undefined ? {} : { DSH_DEPLOYMENT_REGION: 'cn-north' },
  })
}
```

覆盖层根据当前 `ToolExecution` 计算，并通过专用的 `ShellExecRequest.dshEnv` 通道传递。本地执行器在合并该快照前移除所有继承的 `DSH_*`，因此嵌套 harness 与并发的父子 agent 无法泄漏陈旧身份。`process.env` 永不被修改。shell 工具的描述只教授通用的 `$DSH_*` 约定，而不是点名持久化相关的变量或添加常驻的 system-prompt 段落。

## 不变量

**运行时不变量：** 未发布配套入口。注册表是带 effect 作用域释放的贡献集合；收集到的变量按 shell 调用从已注册事实计算。

## 模型体验

通过 shell 工具（`dsh-tool-bash`、`dsh-tool-pwsh`）间接产生影响；这些工具把本注册表的受管 `DSH_*` 事实暴露在每次 shell 工具调用中。

#### KV Cache 影响

受管环境永远不会进入请求前缀，因此不会使提供方缓存复用失效；任何前缀变更都取决于 shell 工具定义与当前请求信封。

## Known Limitations and Deferred Work

- **`list()` 只枚举 contributor 声明的变量** — 注册表自有的内置键（`DSH_HOME`、`DSH_SHELL`、`DSH_SESSION_ID`）不包含在内，因此诊断、prompt 或 UI 代码不得把 `list()` 当作完整的环境目录。

**运行时不变式：** 不发布伴生入口。环境注册表会在每次注册和收集时校验所有权与收集值，也不发布可供伴生入口交叉检查的独立快照。
