# web-cordis

[English](README.md) | 中文

通过正式 Web 或 ACP Profile 使用只读 [Cordis 运行时检查](../../packages/extensions/tool-cordis/README.zh.md)。Agent 发现确切的 Host API；Web 还提供实时 Client API 与 Slot 信息。该演示不提供执行动态 Plugin 代码的模型工具。

## 运行方式

启动浏览器界面：

```sh
pnpm run demo:cordis
```

也可以启动 ACP 自动化服务：

```sh
pnpm run demo:cordis acp
```

两个命令都通过标准 `dsh` Profile 启动器加载检查覆盖层。模型对话需要 `DEEPSEEK_API_KEY`。可以要求 Agent 列出检查提供者、查询 Tool 提供者，并说明可用的只读 API。持久化 Plugin 变更由创造模式及插件管理器的授权安装流程负责。
