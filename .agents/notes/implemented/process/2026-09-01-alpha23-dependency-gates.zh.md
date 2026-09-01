# Agent Note: 依赖归属与双发行版安装门禁

Status: implemented

[English](2026-09-01-alpha23-dependency-gates.md) | 中文

## 问题

选择性同步上游改动后，workspace 同时包含 host、浏览器、bundle、vendor 和 native 各自的清单策略。已有 workspace 检查不能发现 Host 运行时 import 未列入生产依赖、生产区段重复声明，或两个 DSH 发行版在 npm 树中错误地解析到同一个包目录。

## 决策

`scripts/verify-package-dependencies.ts` 扫描 workspace 清单和 Host 源码 import。它要求使用 workspace 协议范围、DSH 包的 peer/development 对应声明、生产依赖区段不重复、peer 元数据不悬空，并要求每条检测到的 Host 运行时边都存在于 production dependency 区段。Client、bundle、app、vendor 和 native 的策略继续由已有专门检查负责。

`scripts/benchmark-npm-resolution.ts` 提供只读元数据本地 registry resolver。`scripts/verify-npm-install-layout.ts` 构造两个不兼容的合成 DSH 发行版，让 npm 计算 hoisted lock 布局，检查每条已解析 production/optional 边的嵌套与根路径，并要求 Cordis 只存在一份共享路径。本 fork 的完整 DSH peer 图循环过多，npm 严格 solver 会耗尽 Node 堆；因此布局探针先检查源码发行版的 1,244 条 peer 范围，再只在 npm 调用的合成元数据中移除 DSH peer 信息，并直接将全部 2,488 条合成 DSH peer 范围与各自发行版本比对。源码清单和独立的归属门禁仍保留 peer 声明。

归属门禁运行在静态 CI 与 hygiene 中；双发行版布局门禁在 release workflow 的 build 与发布之前运行。两者都是只读操作，只使用临时元数据或临时 consumer。

本笔记收窄了 [npm 发布序列笔记](2026-08-10-npm-release-sequences.zh.md)中的 packed-install 决策：原有 release 探针继续验证打包内容和可执行文件启动，本次升级门禁则验证范围解析与跨发行版放置。

## 考虑过的替代方案

**只依赖 `check-workspace-constraints`、`verify-client-packages` 和 Knip。** 不采用：这些检查不能共同证明 Host 运行时归属或两个不兼容发行版的物理放置。

**对完整 fork 图运行 npm 严格 peer solver。** 不采用：当前 251 个包的 peer 图会耗尽 Node 堆；无法在本地或 CI 完成的发布门禁不是可操作的安全检查。

**只使用手写图模拟。** 不采用：这会验证我们对 npm hoisting 的理解，而不是 npm 生成的实际 lock 布局。npm resolver 仍参与 production/optional 边，peer 范围完整性则独立校验。

**在发布清单中改写或删除 peer 声明。** 不采用：peer 是包约定的一部分，host/client 组装依赖它们；resolver 绕过只限制在合成 benchmark 元数据内。

## 影响

清单漂移会在 release 打包前失败，双发行版回归会报告越过版本边界的具体包路径和边。当前图上的 npm 探针快速且确定，但 peer 的物理放置由静态同版本断言表示，而非 npm 严格 peer solver。未来若减少 peer 循环，可以恢复严格 peer 解析，不必改变归属规则或布局断言。

## 测试

验证器套件覆盖错误区段、重复声明、运行时 import 归属、合成 registry 克隆、npm 元数据解析、路径隔离和共享 Cordis 放置。当前 workspace 上 `CI=true pnpm run verify-package-dependencies` 与 `CI=true pnpm run verify-npm-install-layout` 均通过。
