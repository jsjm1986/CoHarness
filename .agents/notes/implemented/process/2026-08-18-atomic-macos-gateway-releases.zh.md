# Agent Note: macOS Gateway release 生命周期原子化

Status: implemented

[English](2026-08-18-atomic-macos-gateway-releases.md) | 中文

## 问题

launchd 任务可以在 `current` 已切换到新目录后，继续把旧 release 保留为 cwd。当 Gateway 命令、运行时命令和策略插件路径分别包含 `current` 时，后续启动的子进程可能解析到与仍在运行的父进程不同的 release。此时删除旧目录，会把普通升级变成无法可靠回滚的混合版本进程树。进程仍存活且基础健康响应仍为 `{"ok":true}`，都无法发现这种状态。

## 决策

只能向前执行的数据库迁移，可能让激活前运行的 release 无法读取数据库。因此，进程历史不能决定兼容的恢复目录。运维人员单独确认数据库兼容性；release 产物校验不会读取、迁移或降级数据库。

macOS 部署把 `gateway/deploy/macos/release-control.sh` 安装到所有 release 之外的稳定控制目录。launchd 以 releases 根目录作为工作目录来运行这份稳定副本。控制器在 Gateway 启动时只解析一次 `current`，把规范目标导出为 `HGW_RELEASE_ROOT`，移除独立配置的 Gateway、CLI、仓库和策略插件路径，再从同一目标启动编译后的 Gateway 入口。生产构建会创建独立 Gateway 所需的相对链接 `gateway/node_modules/@deepseek-ai/*`——对应 `scripts/build-production.ts` 中 `GATEWAY_RUNTIME_PACKAGES` 列出的每一个 workspace 包——激活在切换 `current` 前校验每一份产出载荷文件和每一条运行时链接。launchd 的 `run` 入口接受已处于 current 的旧源码 release，以便执行隐式恢复；显式选择的激活与恢复目标都必须包含编译产物。

存在 `HGW_RELEASE_ROOT` 时，Gateway 配置会验证正在运行的 Gateway 目录属于该 release，从中派生已构建 CLI 命令和 release 自有插件路径，并拒绝冲突的覆盖值。`/healthz` 把不可变目录名作为 `release` 返回，但不暴露宿主机绝对路径。

原生产物校验要求同时具备 `landlock-run` 和 `flock` 的编译后 JavaScript 入口及宿主平台二进制。指向[原生入口包](../../../../native/system/packages/entry/package.json)的链接能够解析，不代表其导出的文件存在。Gateway 健康不能证明 Runtime 能导入 Session 持久化或沙箱；release 验证包含启动完整 Runtime 并通过真实 API 创建 Session。

release 激活过程校验必需的生产产物，持有一个文件系统锁，原子替换 `current` 符号链接，并强制重启 launchd。只有 launchd 取得不同的 PID、该 PID 的 cwd 指向目标 Gateway 目录，且 `/healthz` 报告目标 release 时，控制器才接受目标。失败时，默认恢复上一个 release；`--rollback-target <directory>` 可选择另一个恢复 release。控制器再次重启 launchd，并在返回错误前验证选定的 release。

显式恢复目标在进程操作之前固定，必须解析为 releases 根目录下包含完整编译产物的直属 release。控制器在规范路径解析之前拒绝可变的 `current` 名称，也拒绝解析为候选目录的别名。上一个 PID 和子进程清理始终跟随真实运行的 release，与恢复目标选择相互独立。如果选定的恢复目标不健康或报告其他 release 身份，控制器会返回错误，不再尝试可能不兼容的上一个 release。

激活过程绝不删除 release。显式 prune 操作会拒绝 `current`、活动 Gateway cwd、被其他进程命令提及的目录，以及仍有打开文件的目录。运维人员至少保留上一个已验证 release，直到后续显式 prune。

## 验证

Gateway 配置测试覆盖规范 release 派生和冲突路径拒绝。服务器测试覆盖携带 release 的健康响应。[macOS 控制器测试](../../../../gateway/tests/macos-release-control.spec.ts)覆盖单次路径解析、成功激活、隐式和显式恢复、修改前拒绝、恢复身份校验失败后不再额外重启，以及 `current` 已指向别处但活动 Gateway 仍使用旧 release 时拒绝 prune。进程控制夹具同时拦截外部命令和 Bash 内建 `kill`；这些测试验证产物与控制器行为，不证明数据库兼容性。

## 考虑过的备选方案

**在 plist 中保留 `current`，并要求人工重启。** 这种方案继续让正确性依赖运维顺序，而且 launchd 可以在符号链接变化后保留一个表面健康的父进程。

**只固定子运行时命令。** 这能避免一条 CLI 路径混用版本，却仍允许 Gateway 源码、策略插件和未来其他 release 自有输入分别解析。

**始终恢复最后运行的 release。** 数据库向前迁移后，进程历史不能证明兼容性。显式选择恢复 release，使进程停止继续针对真实的上一个进程，同时允许恢复到已对当前数据库验证的软件。

**激活后自动删除较旧 release。** 自动清理可以减少磁盘占用，但会把破坏性操作耦合到部署风险最高的阶段。独立且受保护的 prune 会保留回滚目标，并要求删除前取得当前进程证据。

## 后果

macOS 生产布局除了 release 目录，还需要一份稳定控制器副本和一份仅所有者控制的环境文件。当产物、launchd 状态、cwd、数据库就绪状态或 release 身份不一致时，激活会直接失败。磁盘清理成为显式步骤，运维人员以少量临时存储增长换取确定性回滚，并确保受支持的流程绝不会删除活动进程所依赖的 release 目录。
