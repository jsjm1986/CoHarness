# Agent Note：打包 JSON-RPC 可执行文件按环境选择器调度 worker 模式

Status: implemented

[English](2026-09-22-packaged-exe-worker-dispatch.md) | 中文

## 问题

Python 单文件可执行文件为每一个携带子进程的 worker 重新调用自身：PTC Node 运行时以 `DSH_PTC_RUNTIME_NODE=1` 派生 `process.execPath`，子进程 provider 的作用域 runner 以 `DSH_SUBPROCESS_RUNNER=<locator>` 派生它。打包入口此前只会启动 JSON-RPC agent 组合，因此每次 worker 派生都落在 agent 的 `usage:` 行上退出而不是运行 worker，`tools.mode: both` 的组合在打包运行时内永远无法执行 `run_code`。

## 决定

`packaged-bin.ts` 是可执行文件唯一的调度点，按序先于 agent 启动判定：

1. Windows 上，`argv[2]` 等于解析出的 `@deepseek-ai/dsh-sandbox-windows-acl/runner` 入口时运行 ACL runner（先从 `argv` 移除注入的快照入口）。
2. `DSH_PTC_RUNTIME_NODE === '1'` 删除该选择器并副作用导入 `@deepseek-ai/dsh-ptc-runtime-node/process`，由其打开继承的控制通道并运行 worker 协议。
3. `DSH_SUBPROCESS_RUNNER` 已设置时删除该选择器并调用 `@deepseek-ai/dsh-subprocess-local/runner` 的 `runSelectedSubprocessRunner(selection)`。
4. 其余情况入口照常执行 `runJsonrpcAgent(import.meta.url)`——`bareModuleBaseUrl` 只属于 agent 分支，因为 worker 分支不通过它解析任何内容。

每个选择器在读取后即删除，worker 子进程再次调用该可执行文件时不会命中同一分支。`jsonrpc-demo` 将三个包声明为 `dependencies`，使 exe 构建的闭包遍历能打包它们的 `lib/runner*.js` 与 `lib/process*.js` 产物。

## 曾考虑的替代方案

**给 worker 子进程传递组合配置。** 拒绝：PTC worker 不启动 cordis 组合——它经继承的控制通道运行私有 worker 协议；转发 `DSH_CORDIS_CONFIG` 只会启动第二套 agent 栈而仍无通道。

**为 worker 入口拆出独立可执行文件。** 拒绝：打包管线只交付一个二进制；经 `process.execPath` 的 worker 重调用正是 pkg 虚拟文件系统下派生目标保持真实文件的机制。

## 后果

`tools.mode: both`、作用域子进程 runner 与 workflow worker 在打包运行时内可用；`smoke-python-runtime.py` 的自定义组合端到端覆盖 `run_code` 路径。代价是 agent 分支不执行的一段调度块，以 `v8 ignore` 标记，因为只有构建出的可执行文件能触达它。
