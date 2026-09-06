# Agent Note：进程级出站代理策略

状态：已实现

[English](2026-09-06-outbound-proxy-policy.md) | 中文

## 问题

Node 的 `fetch` 不会自动读取代理环境变量，而部分 SDK 会自行创建传输层。因此即使设置了 `HTTP_PROXY` 或 `HTTPS_PROXY`，模型、Web、MCP 或沙箱请求仍可能绕过代理；不同调用点各自实现匹配逻辑还可能得到不同结果。

## 决策

`@deepseek-ai/dsh-http-proxy` 从不可变的启动环境快照解析一份策略，并在第一个 profile 插件挂载前安装。普通 `fetch` 使用已安装的 undici dispatcher。自行持有代理选项的 SDK 使用 `proxyRouteFor`，派生子进程使用 `proxyEnvironmentForChild`，测试和重放进程可使用 `clearedProxyEnv`。

POSIX 下优先小写环境变量，大写作为回退，`ALL_PROXY` 为两个协议提供回退。Loopback 始终绕过。无法支持的协议和非法值会记录诊断，并让对应协议保持直连。Profile fiber 释放后，启动器销毁代理策略，使嵌套运行能够恢复之前的 dispatcher 和环境。

遥测和模型编写的 worker 进程仍然直连。前者使用无法到达全局 dispatcher 的 Node HTTP 传输；后者不能接收可能包含凭据的代理 URL。

## 考虑过的替代方案

**只设置 `NODE_USE_ENV_PROXY`。** 拒绝，因为它无法覆盖启动器的 `.env` 层、较旧的受支持 Node 版本，或拥有独立传输层的 SDK。

**把代理参数传入每个请求。** 拒绝，因为这会重复策略解析，并且未来新增调用点容易漏接。进程级 dispatcher 配合显式例外可以集中执行策略。

**同时代理遥测和模型编写的 worker。** 拒绝，因为遥测传输不共享 dispatcher，而 worker 不应获得含凭据的代理值。

## 结果

新的普通 `fetch` 调用点无需导入即可继承策略。自定义传输必须显式使用 `proxyRouteFor`，每个外部 SDK 路径都需要 egress 测试证明是否走代理。代理安装保持进程级，而不是 Cordis 插件能力。

## 验证

代理策略、安装、匹配一致性、CLI profile、包依赖、类型检查和 release verify 套件已在同步分支通过。
