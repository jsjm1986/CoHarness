# DeepSeek Harness Python SDK

[English](https://github.com/deepseek-ai/deepseek-harness/blob/master/python/sdk/README.md) | 中文

通过 JSON-RPC stdio 驱动 DeepSeek Harness 的 Python 子进程 SDK。运行时继承常规的 DeepSeek Harness 环境变量（如 `DEEPSEEK_BASE_URL` 与 `DEEPSEEK_API_KEY`），调用方可以直接使用真实模型端点，也可以把这些变量指向本地代理。

请从 PyPI 安装 `deepseek-harness-sdk` 分发包；导入模块仍为 `deepseek_harness`：

```sh
python -m pip install deepseek-harness-sdk
```

安装 `deepseek-harness-sdk` 会同时安装版本完全相同的 `deepseek-harness-runtime-bin` 平台 wheel 包。因此常规入口不需要传可执行文件参数：

```py
from deepseek_harness import DeepSeekHarness

with DeepSeekHarness(dsh_home="./.harness") as harness:
    result = harness.run("Say hi.")
```

`DeepSeekHarness` 会保留其按需启动的运行时子进程，以便在多次调用之间复用。请像上例一样将其用作上下文管理器，或在使用完毕后显式调用 `close()`。

SDK 使用内置的 `dsh` 可执行文件和 `sdk` 运行 profile。必须显式设置 `dsh_home` 或非空 `DSH_HOME`；SDK 不会隐式选择个人目录。通过 `profile` 和有序 `patches` 配置发行应用。所选 profile 必须提供 stdio JSON-RPC 及其必需服务。

```py
from deepseek_harness import DeepSeekHarness

with DeepSeekHarness(
    provider="deepseek-official",
    model="deepseek-v4-flash",
    max_tokens=49_152,
    dsh_home="./.harness",
    profile="sdk",
    patches=("./sdk.patch.yml",),
) as harness:
    result = harness.run("Make the requested code change.")
```

`provider` 选择指定 Cordis 组合所注册的提供方路由；`model` 是该适配器解析出的模型 ID。`max_tokens` 是一个可选的正整数，用于限制根 agent 及其进程内后代在每次请求中输出的 token 数量；省略该参数时，由提供方的默认行为决定输出上限。压缩摘要继续使用压缩插件单独配置的上限。内置默认组合注册 `deepseek-official`。自定义组合可以挂载 `llm-pi-ai`，在其中配置各提供方专属的凭据和端点，并选择 pi-ai 已安装 catalog 中存在的任意提供方/模型组合。

[Python SDK 教程](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/guide/python-sdk.md)提供一套无需使用 Web UI、按步骤完成安装和首次运行的流程。该教程所用的完整独立 Cordis 配置文件位于 [`jsonrpc-agent` 示例](https://github.com/deepseek-ai/deepseek-harness/blob/master/examples/jsonrpc-agent/README.md)中。

`Session.run()` 的活动区间从其提示词被持久 inbox 接收时开始，到整个 agent 下一次进入空闲状态时结束，并返回 `RunResult(session_id, final_response, finish_reason, events, notifications)`。`final_response` 是该区间内根会话最后提交的助手文本。`finish_reason` 是该区间内根会话最后一个 `turn/end` 的 `kind`，例如 `completed`、`max-tokens` 或 `error`；没有轮次结束时为 `None`。缺少字符串 `data.reason.kind` 的 `turn/end` 违反运行时协议，并会抛出 `SdkProtocolError`。这两个结果字段描述的是 `Session.run()` 所界定的活动区间，并不表示某项输出或结束原因在因果上归属于该提示词。steering（中途引导）、注入的上下文和其他排队工作，也可能在 agent 进入空闲状态前参与这段活动。

`HarnessClient` 会在每个子会话活动期间保留已发现的 subagent 谱系，在收到 `subagent.finished` 后释放对应边，并按通知队列上限限制谱系映射。每次执行 `Session.run()` 时，`RunResult.notifications` 与 `on_notification` 会按协议传输顺序收到根会话及所有已知后代的通知，其中包括嵌套 subagent 的生命周期事件与会话事件。`RunResult.events` 只包含根会话事件，因此后代消息不会覆盖根会话回复。底层 `session_prompt()` 会立即返回已排队消息的 `MessageId`；绕过 `Session.run()` 的调用方必须自行负责后续的活动边界。

`dsh_bin` 指定显式可执行文件；省略时解析内置运行时。补丁路径与 Harness home 在启动前解析。`HarnessClient` 使用相同选项；通用假进程参数仅供内部测试。生产与开发载体见 [sdk-runtime README](https://github.com/deepseek-ai/deepseek-harness/blob/master/python/sdk-runtime/README.md)。

`cwd` 与 `runtime_cwd` 在启动子进程和协议握手前解析为绝对路径。输入行、挂起请求、入站请求、通知和输出都受 `HarnessConfig` 限制。初始化、请求和关闭超时必须是 SDK 计时器范围内的正有限秒数。persona 与持久化设置归 profile 补丁所有；SDK 返回结果，不选择存储目录。
