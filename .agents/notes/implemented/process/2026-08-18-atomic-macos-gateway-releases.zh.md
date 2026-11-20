# Agent Note: macOS Gateway release 生命周期原子化

Status: implemented

[English](2026-08-18-atomic-macos-gateway-releases.md) | 中文

## 问题

launchd 任务可以在 `current` 已切换到新目录后，继续把旧 release 保留为 cwd。当 Gateway 命令、运行时命令和策略插件路径分别包含 `current` 时，后续启动的子进程可能解析到与仍在运行的父进程不同的 release。此时删除旧目录，会把普通升级变成无法可靠回滚的混合版本进程树。进程仍存活且基础健康响应仍为 `{"ok":true}`，都无法发现这种状态。

## 决策

只能向前执行的数据库迁移可能让旧版本无法启动。控制器根据候选实际生效的启动配置和随包迁移文件，在切换前读取实时治理库迁移记录。已应用记录须与候选迁移序列的前缀及校验和一致。专用节点内容卷有独立的迁移记录，须已与对应随包序列完全一致。

macOS 部署把 `gateway/deploy/macos/release-control.sh` 安装到所有 release 之外的稳定控制目录。launchd 以 releases 根目录作为工作目录来运行这份稳定副本。控制器在 Gateway 启动时只解析一次 `current`，把规范目标导出为 `HGW_RELEASE_ROOT`，移除独立配置的 Gateway、CLI、仓库和策略插件路径，再从同一目标启动编译后的 Gateway 入口。生产构建会创建独立 Gateway 所需的相对链接 `gateway/node_modules/@deepseek-ai/*`——对应 `scripts/build-production.ts` 中 `GATEWAY_RUNTIME_PACKAGES` 列出的每一个 workspace 包——激活在切换 `current` 前校验每一份产出载荷文件和每一条运行时链接。launchd 的 `run` 入口接受已处于 current 的旧源码 release，以便执行隐式恢复；显式选择的激活与恢复目标都必须包含编译产物。

存在 `HGW_RELEASE_ROOT` 时，Gateway 配置会验证正在运行的 Gateway 目录属于该 release，从中派生已构建 CLI 命令和 release 自有插件路径，并拒绝冲突的覆盖值。`/healthz` 把不可变目录名作为 `release` 返回，但不暴露宿主机绝对路径。

原生产物校验要求同时具备 `landlock-run` 和 `flock` 的编译后 JavaScript 入口及宿主平台二进制。指向[原生入口包](../../../../native/system/packages/entry/package.json)的链接能够解析，不代表其导出的文件存在。Gateway 健康不能证明 Runtime 能导入 Session 持久化或沙箱；release 验证包含启动完整 Runtime 并通过真实 API 创建 Session。

release 激活在修改 `current` 前要求已注册的 Gateway 任务和 release Runtime 进程全部停止。操作员建立维护窗口并暂停自动启动；控制器不会向 Gateway 或其子孙进程发信号。控制器校验产物、持有激活锁、替换 `current`、启用并启动任务，不强制重启，再核对 PID、cwd 和 release 身份。失败候选仍存活或不可观测时保留其选择；自动回滚要求已经确认进程退出。这保护浏览器空闲状态无法体现的长任务和定时任务。

显式恢复目标在进程操作之前固定，必须解析为 releases 根目录下包含完整编译产物的直属 release。控制器在规范路径解析之前拒绝可变的 `current` 名称以及指向候选目录的别名。失败候选退出后，控制器暂停自动启动，读取备用版本的生效配置，并与候选的数据库及节点坐标比对。回滚要求当时的治理库和已配置内容库迁移记录与备用版本文件完全一致。校验使用只读事务和迁移程序的咨询锁。在切换 `current` 前再次确认进程已停止。备用版本不兼容或证据不可用时保留候选选择并暂停自动启动，等待向前修复。启动备用版本仍须证明 PID、cwd 和包含 release 身份的健康响应一致。

激活过程绝不删除 release。显式 prune 操作会拒绝 `current`、活动 Gateway cwd、被其他进程命令提及的目录，以及仍有打开文件的目录。运维人员至少保留上一个已验证 release，直到后续显式 prune。

发布构建在打包前重新生成引用包的 JavaScript，使它与当前源码和声明一致。发布清单要求包含此 Gateway 使用的新增治理库与节点内容迁移文件。

## 验证

Gateway 配置测试覆盖规范 release 派生和冲突路径拒绝。服务器测试覆盖携带 release 的健康响应。[macOS 控制器测试](../../../../gateway/tests/macos-release-control.spec.ts)覆盖进程与 release 选择、变更前拒绝以及安全清理。PostgreSQL 夹具中的候选进程提交向前迁移后退出；兼容备用进程使用生产迁移程序，并从所选目录回应健康请求。旧备用版本在启动前被拒绝，直接激活也同样被拒绝。两条路径都保留已提交的迁移记录及数据。

## 考虑过的备选方案

**在 plist 中保留 `current`，并要求人工重启。** 这种方案继续让正确性依赖运维顺序，而且 launchd 可以在符号链接变化后保留一个表面健康的父进程。

**只固定子运行时命令。** 这能避免一条 CLI 路径混用版本，却仍允许 Gateway 源码、策略插件和未来其他 release 自有输入分别解析。

**始终恢复最后运行的 release。** 数据库向前迁移后，进程历史不能证明兼容性。显式恢复选择仅在候选停止后，才允许恢复到已验证兼容当前数据库的软件。

**激活后自动删除较旧 release。** 自动清理可以减少磁盘占用，但会把破坏性操作耦合到部署风险最高的阶段。独立且受保护的 prune 会保留回滚目标，并要求删除前取得当前进程证据。

**杀死子孙进程以保证干净重启。** 存续 Runtime 可能持有长任务、定时任务或插件服务。清扫进程树不能证明应用已经取得安全检查点；Gateway 缺失或不健康也不构成终止这些子进程的授权。

## 后果

macOS 生产布局除了 release 目录，还需要一份稳定控制器副本和一份仅所有者控制的环境文件。当产物、launchd 状态、cwd、数据库就绪状态或 release 身份不一致时，激活会直接失败。磁盘清理成为显式步骤，运维人员以少量临时存储增长换取确定性回滚，并确保受支持的流程绝不会删除活动进程所依赖的 release 目录。
