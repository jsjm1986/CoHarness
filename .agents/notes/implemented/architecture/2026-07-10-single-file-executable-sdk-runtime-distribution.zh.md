# Agent Note: SDK 可执行运行时分发

Status: implemented

[English](2026-07-10-single-file-executable-sdk-runtime-distribution.md) | 中文

## 问题

Python SDK 需要无需另行安装 Node.js 的平台运行时。其可执行文件必须通过标准包解析加载 ESM 插件，并暴露 SDK 使用的同一 stdio JSON-RPC 服务。Profile 与显式 patch 文件必须保留组合权威，仓库开发者也需要显式选择的 Node carrier 来调试源码。

## 决策

### 增强 SEA 与配置所有权

可执行文件使用 `@yao-pkg/pkg@6.21.0` 的 `--sea` 模式，目标为 Node 24。增强 SEA 层提供 `/snapshot` 虚拟文件系统与模块 hook，同时保留 ESM 和顶层 await。每次调用构建一个目标。该 VFS 与仓库的回放快照无关。

已记录的 macOS arm64、Node 24 验证确认了 VFS 内的裸包名 ESM 导入、CJS 互操作、`node:sqlite`、共享 Cordis 实例、缺失打包名称时报错、磁盘 ESM 导入、保持不变的 `file:///snapshot/...` 模块 URL，以及 ad-hoc 签名。这些观察不能替代其他平台或后续产物的验收。

[协议包](../../../../packages/sdk/server/README.zh.md)拥有 JSON-RPC 服务与 stdio 传输。未挂载它的组合可以合法地不提供服务。协议关闭先回复并刷新，再释放根并退出；插件卸载停止服务但不退出进程。[SDK 应用](../../../../packages/bundle/sdk-app/README.zh.md)将 stdin EOF 绑定到 CLI launcher 有界的成功关闭。Launcher 收到 SIGTERM 时释放后以 0 退出，收到 SIGINT 时以 130 退出。管道必须在所请求轮次完成前保持打开。

Python client 默认启动 `dsh --profile sdk`。其 `profile` 选择其他组合，按顺序提供的 `patches` 转为 `--patch` 参数。Client 要求显式 `dsh_home` 或非空 `DSH_HOME`，不会隐式选择用户的默认 home。两种 carrier 都由共享的 `runtime-bootstrap.mjs` 分派到 CLI。

### 已安装包闭包与外部资源

CLI 的 [profile loader](../../../../packages/boot/app-boot/README.zh.md)根据安装树和有序 bundle 依赖图计算运行时包解析。安装树对它提供的包名拥有优先级；相对的插入插件以 patch 文件为基准解析。两种 SDK carrier 都使用 runtime 解析，可执行打包产物强制使用该模式。不保证任意外部插件依赖的兼容性；相对导入本身不能建立共享 Cordis 身份。

[`python/sdk-runtime/package.json`](../../../../python/sdk-runtime/package.json)是独立、私有的部署清单。应用 bin 声明其运行时导入；carrier 声明所分发的插件闭包。[闭包校验](../../../../scripts/verify-runtime-closure.ts)按平台矩阵检查所分发预设，并遍历必需 workspace peer。校验时，无法解释的平台表达式仍视为激活，避免隐藏缺失依赖。

构建器使用 `pnpm deploy --legacy --prod`，采用 hoisted 布局，禁用自动 peer 安装，并启用 workspace linking。Legacy deploy 支持本仓库配置；hoisting 提供单一包身份；禁用 peer 自动安装使闭包保持显式；workspace linking 选择本地依赖。构建器恢复遗漏的直接包、将包链接物化、移除 `.bin` 链接，并拒绝剩余符号链接或缺失依赖。Workspace overrides 保持 vendored 依赖来自本地。包的 `files` 声明必须包含生成的共享 chunk。

[构建器](../../../../scripts/build-exe-for-python-sdk.ts)打包声明的运行时资产，包括插件图标，并输出可执行文件、原生 ripgrep、Office 依赖、平台资源，以及适用时的 macOS spawn helper。资源清单归构建器与[平台清单](../../../../python/sdk-runtime/platforms.json)所有。开发 carrier 同步保留资源的相对符号链接与可执行权限，使复制树重定位后不依赖构建目录。共享 pkg 补丁通过临时文件重命名发布解包的原生文件，避免暴露只写入一部分的缓存文件。

MCP client 可连接配置的外部服务器；运行时不捆绑这些服务器。[MCP 实现](../../../../packages/mcp/mcp-client/README.zh.md)支持工具与资源读取，默认不启用服务器。MCP prompt template 与资源订阅仍不受支持。

### Carrier、平台与隔离执行

Python 自动解析选择可执行 carrier。`DSH_RUNTIME_MODE=node` 显式用系统 Node.js 运行开发闭包中的 `runtime-bootstrap.mjs`，并要求 Node.js 位于[仓库支持的 engine 范围](../../../../package.json)；wheel 不包含这个 carrier。

[平台清单](../../../../python/sdk-runtime/platforms.json)声明 Linux x64/arm64、macOS arm64/x64 与 Windows x64；可执行文件名以 `deepseek-harness-sdk-runtime-` 开头，Windows 带 `.exe` 后缀。[发布构建器](../../../../scripts/build-python-release.py)从根仓库版本派生两个 Python 包版本，将预发布版本转换为 PEP 440，并让 SDK 精确依赖同版本运行时。提供的 `python-v` tag 必须一致；开发哨兵版本不能决定发布版本。构建器携带许可与运行时 notices，构建平台无关的 SDK wheel 和带平台 tag 的运行时 wheel，并校验可执行文件、sidecar 与资源。运行时包拒绝 sdist、universal tag、不支持的平台，以及混合或不完整载荷。

[GitHub 工作流](../../../../.github/workflows/build-exe-for-python-sdk.yml)负责所选目标的原生构建与 wheel 安装验证，包括 Linux ABI 检查与 macOS deployment target 检查。必需 PR 验证与发布各自由所属工作流选择矩阵。[GitLab 发布](../../../../.gitlab-ci.yml)负责其配置的构建子集与串行 registry 发布。配置了 job 不代表该 job 已通过。

打包 bootstrap 在启动 JSON-RPC agent 前分派 Windows ACL runner argv、Node PTC 环境选择器，以及私有 subprocess 选择器。选择器在 guest 执行前被消费。[Workflow provider](../../../../packages/workflow/workflow-ptc/README.zh.md)使用共享 Node PTC executor 与调用 Session 的文件策略，不需要单独的 workflow worker-thread carrier。

## 备选方案

**裸 Node SEA。** 在本打包设计中被否决，因为其 blob 不提供包文件系统或标准裸包名解析。静态注册每个插件会取代配置驱动的包加载。

**标准 pkg 模式，或预先将全部 ESM 转为 CJS。** 已记录的标准模式验证以 `ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING` 拒绝动态导入；其修补版 Node 二进制也缺少所需的 macOS arm64 预构建。增强 SEA 保留模块语义，无需该转换层。

**让应用 bin 携带部署闭包。** 否决：这会声明 bin 未导入的打包依赖，并要求包规则例外。独立 carrier 让应用包的实际依赖保持明确含义。

## 后果

用户随平台运行时获得 Node 与所分发的 Harness 插件。可执行文件及其必需资源共同组成一个安装；单独的可执行文件不是完整载荷。两种 carrier 都保留包解析与外部配置的权威。

VFS 内源码仍可读取；该方案不提供混淆。最初验证生成了约 174 MB 的可执行文件，这不是对当前完整安装体积的保证。社区维护的 VFS 与模块 hook 仍是固定版本依赖，变更需要产物级验证。

## 验证

Python 单元测试覆盖协议处理、子进程清理、cwd 传递与 carrier 选择。[运行时 smoke](../../../../scripts/smoke-python-runtime.py)通过默认与自定义配置、直接协议调用、持久 Shell 状态、文件系统搜索、首次 prompt 前的 MCP 发现、动态插件、PTC／workflow 执行及恢复记录，检查构建产物与已安装 wheel。Minimal profile 提供一个持久 Shell；编辑器 smoke 显式挂载编辑器 overlay。无需密钥的回放比较 SDK 输出及持久的父／子 Session 日志。这些可执行产物专用 fixture 与 ACP 回放保持独立，因为它们检查不同协议与产物。
