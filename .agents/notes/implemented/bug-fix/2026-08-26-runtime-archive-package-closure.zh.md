# Agent Note: Keep the archive runtime package in the installation dependency closure

Status: implemented

[English](2026-08-26-runtime-archive-package-closure.md) | 中文

## Problem

树外的 model-governance 插件会把 `@deepseek-ai/dsh-archive-gateway` 插入每个 runtime profile。生产 profile 通过 dsh 安装的依赖闭包和扁平 fallback 链接解析裸插件名。此前 archive 包不在该闭包中，所以即使 Gateway 和包产物都存在，新启动的 runtime 仍会在提供 Web 端点前失败。

## Decision

base dsh bundle 声明 `@deepseek-ai/dsh-archive-gateway` 为 workspace 依赖。安装链接器遍历 bundle 依赖图时会发现该包，并为所有 profile 创建所需的 fallback 链接。该包仍是使用 peer 依赖的 runtime 插件，不会被复制进树外的 governance bundle。

## Alternatives considered

**给现有每个 runtime home 手工添加链接。** 不采用，因为新用户或新项目第一次启动时仍会失败，并且会让宿主状态成为包解析的一部分。

**Gateway 启动时把 archive 包复制到 model-governance。** 不采用，因为这会复制安装所有的包，并让树外插件负责另一个包的生命周期和产物复制。

**只在 Gateway service 中声明该包。** 不采用，因为失败发生在每个 runtime 进程内部独立解析的 dsh profile 依赖图中。

## Consequences

执行标准 workspace 依赖安装的生产部署会在任何 runtime 启动前，将 archive 包暴露给 profile fallback healing。现有 profile 可以在下次重启时自动修复；不会修改对话数据或 Gateway 数据库记录。移除该依赖会在 governance patch 引用 archive entry 时重新引入 runtime 启动失败。

## Testing

现有 `healProfilesModuleFallback` 测试覆盖 bundle 的传递依赖。生产验证还会从安装 anchor 解析构建后的 archive 包，并在依赖链接修复后启动受影响的个人和项目 runtime 探针。
