# CoHarness

[English](README.md) | 中文

**CoHarness 是面向团队协作的多用户智能体 Harness。**

CoHarness 是基于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的独立维护项目，遵循 MIT 许可证。项目保留由 Cordis 驱动的插件化运行时，并增加共享项目空间、身份认证协作、管理控制和可部署的 Web UI。

## 主要能力

- **团队工作空间：**共享项目对话，同时保留参与者身份以及项目或私有可见性。
- **访问控制：**管理管理员与普通用户角色、项目只读或读写成员权限，以及目录授权。
- **集中治理：**通过统一 Gateway 管理用户和项目运行时、模型访问与用量信息。
- **插件架构：**通过 Cordis 插件组合工具、服务提供方、策略、界面和智能体行为。
- **自主部署：**可以在本机运行 Web UI，也可以将 Gateway 部署到自行管理的基础设施。

## 项目状态

CoHarness 目前处于发布前的持续开发阶段，配置、API 和持久化格式可能发生不兼容变更。

<a id="run"></a>

## 运行

### 通过 `npm` 运行

安装 `Node.js`，然后运行：

```sh
npx @deepseek-ai/dsh web
```

该命令默认会在 `http://127.0.0.1:3080` 启动 Web UI，本机启动时还会用默认浏览器打开页面。通过 SSH 启动时只打印宿主机 URL，因为本地转发地址由 SSH 客户端或编辑器持有。传入 `--no-open` 可仅运行服务器而不打开浏览器。详见 [Web UI 指南](docs/user/guide/index.zh.md)。

<a id="run-from-source"></a>

### 从源码运行

```sh
git clone https://github.com/jsjm1986/CoHarness.git
cd CoHarness
corepack enable
pnpm install
pnpm run build
pnpm dsh web
```

`pnpm run build` 会准备仓库产物。`pnpm dsh web` 会直接使用这些已构建产物，不会重新构建。

## 社区与支持

- 欢迎通过 [GitHub Discussions](https://github.com/deepseek-ai/deepseek-harness/discussions) 提交反馈或 bug 报告。
- 为你的插件仓库添加 [`dsh-plugin`](https://github.com/topics/dsh-plugin) 话题，便于被发现。
- 欢迎加入 DeepSeek Harness 企微群：扫码添加企微小助手并填写入群问卷，完成后小助手会邀请你入群。

<table>
  <thead>
    <tr>
      <th align="center">企微小助手</th>
      <th align="center">入群问卷</th>
      <th align="center">微信公众号</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td align="center"><img src="https://cdn.deepseek.com/harness/readme/community-wecom-assistant.png" alt="DeepSeek Harness 企微小助手二维码" width="180" height="180"></td>
      <td align="center"><a href="https://trtgsjkv6r.feishu.cn/share/base/form/shrcnIt5twSVdLGD52KJBckGCgg"><img src="https://cdn.deepseek.com/harness/readme/community-wecom-survey.png" alt="DeepSeek Harness 入群问卷二维码" width="180" height="180"></a></td>
      <td align="center"><img src="https://cdn.deepseek.com/harness/readme/community-wechat-official-account.png" alt="DeepSeek Harness 团队微信公众号二维码" width="180" height="180"></td>
    </tr>
  </tbody>
</table>

## 参与贡献

参见 [CONTRIBUTING.md](CONTRIBUTING.zh.md)。

## 开发

修改运行时软件包前请阅读[架构文档](docs/architecture.zh.md)。开发环境和仓库命令参见[开发指南](docs/development.zh.md)，智能体贡献者必须遵循 [AGENTS.md](AGENTS.md)。

## 上游与许可证

CoHarness 是 DeepSeek AI 原始开发的 DeepSeek Harness 的独立衍生项目，并保留原始版权和许可证声明。

本项目使用 [MIT 许可证](LICENSE)。第三方依赖及其许可证见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
