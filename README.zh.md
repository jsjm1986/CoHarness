# CoHarness

[English](README.md) | 中文

**CoHarness 是构建在 DeepSeek Harness（DSH）之上的自托管、多用户智能体工作空间。**

CoHarness 将 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 Cordis 插件运行时与面向认证团队的产品层结合起来，提供个人与共享项目工作空间、持久化对话、文档流程、模型治理、用量核算和管理员 Gateway。用户看到的品牌是 CoHarness；运行时软件包名称、插件 id、文件命名规范和兼容性 API 有意保留 `dsh` 词汇，以便持续进行上游适配。

CoHarness 是独立维护的衍生项目，不是把上游版本重新命名后发布。底层插件和智能体运行时的契约仍以上游 DSH 为参考；CoHarness 在此基础上维护自己的 Gateway、协作、管理、文档、部署和 Android 能力。上游同步采用选择性、基于行为的方式，本仓库不承诺与每个上游版本逐文件或逐提交完全一致。

## 适合谁

- **个人用户**可以在本机运行 Web 工作空间，连接模型 Provider，选择项目目录，让智能体在审批提示和持久化对话历史下检查或修改文件。本地部署不需要 PostgreSQL 或 Gateway。
- **团队成员和项目负责人**可以使用经过认证的个人空间和共享项目，邀请具有 `ro` 或 `rw` 权限的成员，在共享对话中协作，并让项目文件和运行时状态保持在项目 scope 内。
- **组织管理员**可以运行 Gateway，管理用户和项目，授权模型路由，查看用量和审计记录，配置额度，并管理部署和备份流程。
- **集成开发者**可以组合 Cordis 插件，使用 TypeScript 或 Python SDK，通过 JSON-RPC 或 ACP 连接，并添加模型、工具、存储或执行 Provider。

## 选择运行方式

| 场景 | 推荐方式 | 提供的能力 |
| --- | --- | --- |
| 在一台电脑上试用产品 | 本地 `dsh web` | 使用本地文件和本地 Session 存储的浏览器工作空间；不需要 Gateway 或 PostgreSQL。 |
| 运行可重复的自动化任务 | Headless、JSON-RPC、ACP 或 SDK | 非交互 Session、事件流和与脚本或服务的集成。 |
| 为团队提供认证访问 | Gateway 加 Web runtime | 用户、个人空间、共享项目、权限、模型治理、用量和审计。 |
| 强化 Linux 隔离 | 使用 systemd 部署 Gateway | 每个 runtime 独立账户、mount namespace、目录授权和内核级项目隔离。 |
| 在移动设备访问托管工作空间 | Web UI 或 Android 壳 | 访问已部署 Gateway 的浏览器或 Capacitor 客户端；推送通知可选。 |

CoHarness 处于发布前开发阶段。生产部署应被视为需要自行评估和负责的自托管工作：公共 API、配置、数据库 schema、Session format 和部署流程可能变化。Linux systemd 提供的进程和目录隔离强于 macOS；macOS 启动器适合可信团队开发，或适合由主机权限提供所需保护的部署。在向用户开放服务前，请阅读 [Gateway 参考](gateway/README.zh.md) 和[部署手册](gateway/deploy/README.zh.md)。

## 以个人用户身份开始

最短的本地使用路径是：

1. 从包含智能体要使用的文件的目录启动[Web UI](#run-from-source)。
2. 打开**设置 → 模型**，配置 DeepSeek 密钥或其他受支持的 Provider。
3. 在 Web UI 中选择工作区目录。
4. 让智能体检查、解释、编辑或整理工作区。文件修改、命令和其他受治理的操作可能需要根据当前权限策略审批。
5. 之后返回同一工作区即可恢复持久化 Session，并查看对话和工具历史。

[Web 用户指南](docs/user/guide/index.zh.md)介绍首次 Session、模型配置、工作区和后续任务。[CLI 参考](apps/cli/reference/README.zh.md)介绍 headless 任务、profile 和插件管理的部署方式。

## 以团队方式使用

Gateway 是多用户控制面。每个账户拥有个人空间，共享项目则使用一个项目 scope 内的 runtime 和持久化存储。项目成员拥有 `ro` 或 `rw` 权限；对话可以对项目可见，也可以仅创建者可见，项目权限由 Host 检查，不能信任浏览器自行保证。管理员可以管理用户、项目、邀请、模型路由授权、额度、用量汇总、审计记录和运行时健康状态。

组织管理的模型路由可以按角色、用户和项目授权。个人用户可以使用自己的 BYOK 路由；共享项目 runtime 仍由目录控制。用量记录会在不把 API 密钥、提示词或回复写入账本的情况下归属活动。Linux 部署增加 systemd 和 mount namespace 隔离；macOS 不提供这一内核边界，应按相应限制使用。

请阅读 [Gateway 参考](gateway/README.zh.md)了解控制面的行为，阅读[部署手册](gateway/deploy/README.zh.md)了解 PostgreSQL、release、隔离、TLS、备份、升级和回滚。

## 当前能力

| 领域 | 当前能力 |
| --- | --- |
| 智能体运行时 | Cordis profile 与 bundle、事件溯源 Session、持久化恢复/分叉、提示词和工具组合、模型请求、审批、问题、计划、目标、待办、后台任务、工作流、上下文压缩、telemetry 和 Session 投影。 |
| 工具与执行 | 工作区文件系统工具、图片读取、Shell 与持久终端、LSP、网页搜索/抓取提供方、skill、结构化附件、用户文档，以及 sandbox 或目录策略。 |
| 模型 | DeepSeek 与 pi-ai 适配器、目录和自定义 Provider、OpenAI 兼容及其他支持的协议、个人 BYOK 路由、组织托管路由、模型选择、推理控制、图片准入/规范化、Files 上传与回退，以及不会把秘密写入日志的凭据引用。 |
| Web UI | 响应式浏览器应用，包含 Session、实时对话历史、模型选择、命令和 `@` 建议、图片/文档附件、文档管理、工作区选择、权限控制、目标、subagent、任务、设置、本地化、主题和反馈。 |
| 项目 | 个人与共享项目 scope、每项目一个共享运行时、`ro`/`rw` 成员、邀请、项目或创建者私有对话、参与者归属、根对话可见性继承、目录授权、管理员权限，以及组织模型的项目级默认授权。 |
| 文档 | 命名用户文档、上传/下载、加入对话、按 scope 浏览、跨 scope 复制、快照谱系、操作历史、冲突安全的目标命名，以及 PostgreSQL 元数据对账；文件字节仍保存在运行时拥有的目录中。默认不设置单文档大小上限，但仍受传输、文件系统和部署存储限制。 |
| Gateway 与管理端 | PostgreSQL 认证、用户、项目、实例、协作、模型 Provider 与目录、额度、用量、审计、文档目录、HTTP/WebSocket 代理、运行时 principal、健康诊断和独立 Admin SPA。 |
| 安全与部署 | Linux systemd mount namespace、`dsh-directory-guard`、sandbox 策略、Landlock/原生启动器、macOS 本地/launchd 运行、Nginx 或 tunnel 入口、所有者私有凭据文件、不可变生产 release，以及 SQLite 到 PostgreSQL 的导入/回滚工具。 |
| 集成 | TypeScript SDK、Python SDK 与 bundled runtime、JSON-RPC、Agent Client Protocol（ACP）、Codex 和 Claude Code hook bridge、可选 Codex/Claude subagent 提供方，以及支持 FCM/JPush/厂商推送的 Capacitor Android 壳。 |

## 与 DSH 的关系和命名规范

仓库有意保留以下上游约定：

- npm scope 继续使用 `@deepseek-ai/dsh-*`，保持运行时软件包兼容。
- Cordis 插件名称、profile 和 bundle manifest、`cordis.patch.yml`、`DSH_HOME` 以及 DSH 配置词汇继续可用。
- 在 CoHarness 没有增加产品层的地方，以上游架构、协议、Session event 和插件契约作为兼容参考。
- CoHarness 自有功能按 CoHarness 行为记录，可能与上游 DSH 使用不同的存储、授权、UI 和部署契约。

请先阅读[架构文档](docs/architecture.zh.md)了解插件模型，再阅读[用户指南](docs/user/guide/index.zh.md)了解当前 Web 流程。[Gateway 参考](gateway/README.zh.md)和[部署手册](gateway/deploy/README.zh.md)负责自托管多用户控制面。

<a id="run"></a>

## 本地运行

### 从源码运行

<a id="run-from-source"></a>

要求：Node.js `^22.19.0` 或 `>=24.0.0`、Corepack，以及受支持的本地运行平台。

```sh
git clone https://github.com/jsjm1986/CoHarness.git
cd CoHarness
corepack enable
pnpm install
pnpm run build
pnpm dsh web --no-open
```

打开命令输出的地址，通常是 `http://127.0.0.1:3080`。启动命令所在目录会成为初始文件系统位置。全新的 Web UI 不会自动选中工作区，开始对话前请先选择目录。

打开**设置 → 模型**配置模型。支持 DeepSeek 密钥、目录 Provider 和自定义 Provider/model 路由。个人用户可以自由添加 Provider 与 model 身份；Gateway 只向管理员记录不含秘密的登记活动，不会把登记历史当成审批名单。详见[模型配置](docs/user/guide/providers.zh.md)。

不使用浏览器执行一次性任务：

```sh
pnpm dsh --profile headless "Inspect this repository and summarize the main risks."
```

headless profile 会写入持久化 Session，并打印最后的 assistant 回复。profile 和外部插件 bundle 由[`dsh` CLI 参考](apps/cli/reference/README.zh.md)负责管理。

### 部署多用户 Gateway

Gateway 是认证用户和共享项目的生产路径。它使用 PostgreSQL 17、已配置的组织和计算节点、构建后的 Web/Admin bundle，以及 Linux systemd 或 macOS launchd/local 启动器。Gateway 可以放在 Nginx 或 Cloudflare Tunnel 等入口之后。

```sh
pnpm install --frozen-lockfile
pnpm run build:production
```

数据库准备、migration、凭据文件、项目根目录、运行时隔离、切换、备份和回滚请按照[gateway/deploy/README.zh.md](gateway/deploy/README.zh.md)执行。部署公共服务时，不要直接暴露 Gateway 或运行时端口。

## 仓库目录

| 路径 | 职责 |
| --- | --- |
| [`apps/cli/`](apps/cli/README.zh.md) | `dsh` 启动器、profile、Web/headless 入口和插件管理。 |
| [`apps/web/`](apps/web) | Web 应用入口和生产前端构建。 |
| [`apps/android-shell/`](apps/android-shell/README.zh.md) | 加载托管 CoHarness Web UI 的 Capacitor Android 壳。 |
| [`gateway/`](gateway/README.zh.md) | PostgreSQL 认证控制面、Admin SPA、代理、运行时生命周期、治理、用量、审计和部署资源。 |
| [`packages/`](packages/README.zh.md) | Cordis 能力软件包以及浏览器/Host UI 软件包。 |
| [`plugins/`](plugins) | 树外策略和安全插件，包括模型治理与目录强制。 |
| [`python/`](python/README.zh.md) | Python SDK 和 bundled runtime carrier。 |
| [`native/`](native/README.zh.md) | 原生启动器，包括基于 Landlock 的进程隔离。 |
| [`docs/`](docs) | 架构、用户、开发、协议、测试和生成参考文档。 |
| [`examples/`](examples) | 可运行的 Cordis 组合和集成示例。 |

## 开发与验证

修改运行时软件包前请阅读 [AGENTS.md](AGENTS.md) 和[架构文档](docs/architecture.zh.md)。常用检查命令：

```sh
pnpm run typecheck
pnpm run test
pnpm run build
pnpm run doc-sync
```

Gateway 专用检查在 `gateway/` 目录执行：

```sh
npm install
npm run typecheck
npm test
npm run test:postgres
```

PostgreSQL 测试需要临时 `HGW_TEST_DATABASE_URL`；Provider e2e 测试需要其文档规定的凭据，并且只在测试策略允许时无密钥跳过。无密钥 snapshot、文档门禁和构建产物检查属于仓库验证流程。详见[测试文档](docs/testing.zh.md)和[开发文档](docs/development.zh.md)。

## 状态与兼容范围

CoHarness 处于发布前开发阶段。公共 API、配置、数据库 schema、Session format 和部署流程可能发生不兼容变更。PostgreSQL migration 由 Gateway 启动 runner 应用；SQLite 只作为停止写入后的导入与回滚来源，不是生产控制面。

项目面向希望自行运行完整工作空间的团队。部署可以只使用本地 DSH runtime、只使用 Gateway，或同时使用二者。依赖 PostgreSQL、Linux systemd、Android 厂商服务、Codex、Claude Code 或外部模型 Provider 的功能，需要先配置对应依赖，不会被无提示地替换成无关回退。

## 参与与支持

- 在 [GitHub Issues](https://github.com/jsjm1986/CoHarness/issues) 报告 CoHarness 问题和产品问题。
- 准备修改前请阅读[贡献指南](CONTRIBUTING.zh.md)。
- 插件、工具、服务和 LLM adapter 的开发流程见[开发者文档](docs/user/develop/basic/index.zh.md)。
- 上游 DSH 契约、生态软件包和上游讨论请访问 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)。

## 许可证与归属

CoHarness 使用[MIT 许可证](LICENSE)发布。本仓库是 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的独立衍生项目，上游项目同样使用 MIT 许可证；仓库保留上游版权和许可证声明。在保留必要声明的前提下，你可以按照 MIT 条款使用、复制、修改、发布、分发、再许可和销售本软件。

第三方依赖、vendor 源码及其许可证见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。本仓库的 MIT 许可证不表示可以删除第三方声明，也不替代源代码之外适用的 Provider、平台和服务条款。
