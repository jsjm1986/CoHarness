---
description: "离线安装节点本地解释器和文档库，并返回明确的执行路径。"
kind: "package-reference"
---

# @deepseek-ai/dsh-workspace-dependencies

[English](README.md) | 中文

## Summary

本插件提供 `load_workspace_dependencies` 工具：安装由部署提供的 Python、Node.js、pnpm 和文档库载荷，并返回绝对路径。它不操作桌面、不授予 computer-use 权限、不修改 PATH，也不替换 Office 技能和预览转换。

## Table of Contents

- [Configuration](#configuration)
- [Installation](#installation)
- [Dev Note](#dev-note)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

## Configuration

在 `tools` 和文件系统提供者旁挂载本插件。`source` 是内置载荷的绝对目录；`root` 是本运行时拥有的绝对安装目录。两条路径均不由模型控制，且源和目标不能重叠。

```yaml
- name: '@deepseek-ai/dsh-workspace-dependencies'
  config:
    source: /opt/coharness/runtime/primary-runtime
    root: /var/lib/coharness/runtime/primary-runtime
```

当前 Agent 的文件系统必须能够把宿主路径映射到其执行环境。SSH 等无法映射的执行目标在安装前被拒绝。受管部署保留已有工具授权和沙箱政策；本工具不授予桌面、项目或命令执行权限。

## Installation

使用[固定版本构建器](../../../scripts/workspace-runtime/prepare.ts)构建载荷，再通过[安装后运行时检查](../../../scripts/workspace-runtime/verify-installed.ts)验证迁移到新路径的安装：

```sh
pnpm run build:workspace-runtime --target mac-arm64 --output .artifacts/workspace-runtime/mac-arm64 --cache .artifacts/workspace-runtime/downloads
pnpm exec tsx scripts/workspace-runtime/verify-installed.ts --source .artifacts/workspace-runtime/mac-arm64
```

固定目标包括 `mac-arm64`、`mac-x64`、`win-x64`、`linux-x64` 和 `linux-arm64`。下载内容必须符合 SHA-256，Python 分发版本必须与完整 wheel 清单一致。本机目标构建会执行解释器、包管理器和 Office 文档读写验证。异平台目标必须显式指定 `--cross`，并报告 `executionVerified: false`；复制文件不构成平台执行证据。构建器拒绝已有输出目录。Linux wheel 要求其固定标签声明的 glibc 版本。

[CLI 补丁](../../../apps/cli/config/workspace-dependencies.cordis.patch.yml)在所选 profile 中启用工具。将 `DSH_WORKSPACE_RUNTIME_SOURCE` 设置为部署方持有的载荷绝对路径，并向 `dsh --profile sdk`、`web` 或 `headless` 传入此补丁。私有安装位置是所选 Harness home 下的 `workspace-runtime`。可以使用 `--dump-config` 检查解析后的组合。部署打包必须在应用旁携带载荷；npm 插件本身不包含解释器。

安装器检查清单版本与平台身份，暂存完整副本，再在共享跨进程写入锁下替换安装树。替换中断后可以恢复前一棵树。复用同一清单会保留用户额外安装的包；返回的发行版本仅描述内置载荷。不发布运行期 invariant 伴生模块：安装检查在发布时执行，工具注册表负责注册释放。

## Dev Note

安装器源自固定 alpha.2 的 `desktop-host` 实现。CoHarness 将其作为 CLI 和 Gateway 运行时可使用的插件，增加跨进程安装串行化，并拒绝当前执行目标无法使用的路径。[Office 技能](../../skill/skill-office/README.zh.md)提供文档工作流；[computer-use](../../computer-use/computer-use/README.zh.md)负责桌面访问。

## Model Experience

### Request context and condition

#### What the model sees

`load_workspace_dependencies` 工具返回 `python`、`node`、`pnpm`、`pythonPackages`、`nodePackages` 和 `pythonDistributions`。使用返回的 Node 可执行文件调用 pnpm 脚本。加载路径不执行用户脚本，也不证明脚本输出。

#### Token effect

挂载贡献一个工具 schema。调用以普通工具结果返回安装路径表；载荷内容从不进入请求。

#### KV Cache effect

挂载增加一个工具 schema。调用产生普通工具结果，不额外添加系统提示词。

## Known Limitations and Deferred Work

- **载荷获取由部署构建负责** — 载荷下载、平台打包和安装后解释器验证属于部署构建；安装器不下载缺失组件，也不向 SSH 目标安装。
- **遗留写入锁由运维处理** — 遗留写入锁需要运维调查；竞争者不会仅因为锁较旧就删除它。
