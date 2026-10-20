# Agent Note：dsh-tool-fs 按工具开关注册各工具

状态：implemented

[English](2026-10-21-tool-fs-registration-switches.md) | 中文

## 问题

`dsh-tool-fs` 无条件注册 `read`、`read_image`、`write` 和 `edit`，组合层无法按需只提供其中一部分文件系统工具。`sdk-minimal` bundle 早已携带 `config: { read: false, readImage: true, write: false, edit: false }`，但这些键不在插件的 `Config` schema 里，被静默忽略：最小 profile 实际暴露了完整的变更工具集，断言 `[bash, read_image, working_directory]` 的 keyless smoke 只有在 provider-proof lane 真正在 PR 上运行时才必然失败——master 的拓扑结构整个跳过该 lane。

## 决策

`Config` 增加四个独立开关——`read`、`readImage`、`write`、`edit`，各默认为 `true`——`apply` 按开关决定各工具是否注册：`read` 守卫 `applyReadTool`，`readImage` 守卫依赖附件存储的 `read_image` 挂载，`write`/`edit` 共享 `FsSandboxController`，只在至少一个变更工具注册时才构造它。关闭 `read` 后 `write` 和 `edit` 仍可用：成功的变更会记录本会话后续修改所需的版本，因此新建文件仍可编辑，而已有的未观察文件仍受 `fs-observation-policy` 保护。

## 备选方案

- **把期望值改成完整工具集** —— 等于默许被静默忽略的配置，让 `sdk-minimal` 暴露其 manifest 声明关闭的变更工具；缺陷在插件而非测试。
- **删掉这些失效配置键** —— `sdk-minimal` 的只读文件系统姿态是值得保留的产品选择；删键只是换一种方式延续假象。
- **改由观察策略是否挂载来控制注册** —— 把工具注册耦合到一个可选插件的挂载状态，会把部署决策藏进无关能力里；开关才是显式机制。

## 后果

组合层现在可以只交付文件系统工具的任意子集，`sdk-minimal` 暴露的工具集与其 patch 声明完全一致。依赖了这些被静默忽略键的部署将获得它们原本要求的行为——模型可见工具集合的缩减是预期后果而非兼容性破坏，因为注册全集从来不是该配置所承诺的契约。
