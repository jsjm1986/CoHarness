# Agent Note: Python 运行时发布原生 Windows x64 wheel 包

Status: implemented

[English](2026-09-25-windows-x64-python-runtime.md) | 中文

## 问题

Python 运行时分发此前实际上只覆盖 POSIX：平台清单虽已写入一行 `win-x64`，可执行程序构建器也已建模 `win` 平台，但没有任何工作流构建该目标；ripgrep 伴随文件查找会搜 `runtime.exe-rg` 而非 `runtime-rg.exe`；极简组合只挂载 bash 方言；打包运行时冒烟测试把 bash 命令与 `/tmp` 写死。因此 Windows x64 用户没有可安装的 wheel 包，也没有阻断合并的信号保护打包后的 Windows 路径。

## 决策

`win-x64` 成为一等运行时目标，在 `py3-none-win_amd64` 标签下发布 `deepseek-harness-sdk-runtime-win-x64.exe` 及 `deepseek-harness-sdk-runtime-win-x64-rg.exe` 伴随文件。[resolveRgPath](../../../../packages/fs/tool-fs-search/src/search-core.ts) 在 Windows 上从 `process.execPath` 解析出的主干名推导伴随文件名，其余平台保留 `<execPath>-rg` 约定；上游的 Electron `.asar.unpacked` 分支未携带——本地无 Electron 宿主，随桌面宿主引入时补。

[极简组合](../../../../examples/jsonrpc-agent/minimal.cordis.yml) 通过 `disabled: !!js` 条件按平台选择持久 shell 方言：Windows 上为 `pwsh` 方言 `dsh-terminal-bash` 后端之上的 `dsh-tool-pwsh-persistent`，其余平台为 `dsh-tool-bash-persistent`。打包运行时冒烟测试按 `sys.platform` 选择 `pwsh`/`bash` 工具名、PowerShell/bash 命令体，以及 `tempfile.gettempdir()`/`/tmp` 期望值。极简模型可见快照新增 `minimal/win-x64/` 变体，因为对外公布的工具名、描述与命令参数文本随方言不同；advanced 快照保持单份，因为其工具面与平台无关。

必需的拉取请求 CI 通过共享构建器在两个目标的原生 runner 上构建 `node24-linux-x64` 与 `node24-win-x64`，Windows 步骤在原生 `pwsh` 下运行。[发布验证](../../../../.github/workflows/python-release.yml) 保留全部五个目标，并检查 `win_amd64` wheel 包的精确文件名。

## 曾考虑的替代方案

**通过 Wine 运行打包运行时。** 不予采纳，因为受支持的产品面是原生 Windows 执行——ConPTY 终端、ACL 沙箱与 `pwsh` 解析——而 Wine 已另承担独立的 Windows 构建/站点检查，不负责已发布的 wheel 包。

**在 Windows 上经 WSL 或 Git-Bash 保留 bash。** 不予采纳，因为 `pwsh` 是 harness 的 Windows shell 方言，且持久 `pwsh` 工具已存在，极简组合不应挂载仅 POSIX 的接口。

**单份极简快照。** 不予采纳，因为模型可见的工具名及其描述随方言不同；把它们掩码掉会移除快照本应固定的面。

## 后果

Windows x64 用户与 POSIX 用户安装同一生产载体契约。打包后的 Windows 路径——可执行文件、`-rg.exe` 伴随文件、`pwsh` 组合、wheel 包标签与装后冒烟——在每个拉取请求上阻断合并；macOS 与 Linux ARM64 的打包回归仍归发布验证。

## 验证

`verify-runtime-closure` 报告 4 个 agent preset 与 151 个工作区包构成闭合图；`scripts/ci-workflow.spec.ts` 固定 PR 与发布目标清单（18 个测试）；`tool-fs-search` 通过 153 个测试（含固定 POSIX/Windows 伴随命名与无 sidecar 回退的解析用例）；macOS arm64 构建加 `scripts/smoke-python-runtime.py --scenario all` 通过全部无密钥场景并重录 POSIX 快照。原生 Windows 执行归 CI 所有；检入的 `minimal/win-x64` 期望输出即 Windows 腿的比对基准。
