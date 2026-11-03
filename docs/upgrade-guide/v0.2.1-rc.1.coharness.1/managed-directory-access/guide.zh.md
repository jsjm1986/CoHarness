---
kind: upgrade-guide
description: "受管目录浏览保留 Runtime 授权来源、空权限与只读授权。"
---

# 升级受管目录访问

[English](guide.md) | 中文

## 变化

Gateway 受管目录浏览要求使用 Runtime 的私有授权文件。有效空数组不允许列举或创建；受管文件缺失或无效会使插件激活失败。创建目录要求最具体的包含授权为 `rw`。独立启动保留可选文件下从操作系统家目录开始浏览的行为。参见[浏览提供方](../../../../packages/host/directory-picker-browse/README.zh.md)。

自动选择器会为继承的 Gateway 凭据通道选择浏览交互，包括回环监听。直接使用 `DirectoryPickerHostFacts` 的代码需提供 `gatewayRuntime`，通过 `launchedByGateway(launchEnvironmentOf(ctx))` 取得。标准 Gateway 保护包已经显式选择浏览交互。

授权根在激活时绑定其文件系统对象。用不同目录或链接替换路径后，会拒绝列举与创建；指向未授权目标的链接被省略。操作执行期间保留父句柄，返回结果前校验逻辑路径。可选设置 `readBatchEntries` 控制标准库与 POSIX 读取批量，默认32，范围1–65,536；受授权约束的 Windows 读取使用协议限定大小的缓冲区。

## 迁移

1. 在每台升级的 POSIX 电脑上部署 `@deepseek-ai/node-addon-system` 0.1.3 或更高版本及其匹配的平台包。受限浏览会拒绝缺失的原生能力；安装时不会编译。
2. 重启已升级的 Runtime，使其启动环境获得私有 `DSH_DIRECTORY_GRANTS` 路径，并让提供方记录当前根身份。随附 CLI 会拒绝项目环境文件中的这一设置；自定义宿主也从继承快照确定受管浏览器的位置。
3. 如果受管浏览器激活失败，请通过 Gateway 管理恢复有效的 Runtime 授权投影并重启 Runtime。仅为确实允许创建的目录授予写入权限；只读根仍可浏览。
4. 主动用不同目录替换授权根后，刷新其授权投影并重启对应 Runtime。恢复原目录对象会保留其已有身份。
5. 没有文件系统浏览权限时保留有效空数组。它不会启用宿主家目录访问。

Session 代际与数据库结构不变。[目录选择器决策](../../../../.agents/notes/implemented/architecture/2026-07-28-directory-picker-capability-seam.zh.md)记录授权归属和部署选择。
