# Agent Note：在托管 web-verification runner 上收窄 Admin 验收矩阵

状态：已实现

[English](2026-11-25-admin-matrix-hosted-budget.md) | 中文

## 问题

`web verification` lane 连续两次精确烧满 90 分钟 `timeout-minutes`，表面像浏览器死锁：最后一个 pool 文件结果在 lane 约 45 分钟处打印后，日志直到取消都零输出。该文件并未死锁——而是算术上不可能完成。`apps/web/tests/admin-responsive-pages.e2e.ts` 在每个测试内部循环全部 18 个 `adminResponsiveSizes` viewport，横跨 20 个 admin 场景与三个浏览器引擎，每个 viewport 遍次执行一次登录、多次页面加载、`networkidle` 等待、控件审计与对话框交互。即使按每次 viewport 数秒的乐观估计，该文件串行需要一到三小时，而 lane 轮到它时最多只剩约 48 分钟——且 Vitest 在非 TTY 运行中把文件输出批到完成时打印，于是过大的矩阵伪装成了挂死进程。更关键的是矩阵在单文件内串行，任何 worker 数都无法缩短其墙钟成本。过大的矩阵还暴露了第二重结构性缺口：按观测的字节执行速率外推完整 180 文件清单，单 worker 串行测试时间约 95 分钟——尚未计入 checkout、安装与构建——即使移除 Admin 扫描也超出超时，因为清单在本发布候选栈中从 144 膨胀到 180 文件，而托管并行度仍为一。

## 决策

lane 通过与 `DSH_WEB_SNAPSHOT_WORKERS` 相同的容量条件式设置 `DSH_ADMIN_ENGINES` 与 `DSH_ADMIN_VIEWPORTS`——测试设计本已提供的裁剪旋钮：托管 `ubuntu-latest` 以 chromium 跑代表性宽度 320、390、768、1280（约十倍成本削减），企业与自托管 failover runner 保留完整引擎与 viewport 扫描。390 保留了行使 text-spacing 特例的 viewport，1024 的 coarse/fine 边界仍由相邻宽度覆盖。托管 pool 并行度从一 worker 提升到二——正是 master 快照扫描在同款 runner 上已在运行的配置，它在该配置下约 43 分钟完成更小的 master 清单；pool 文件按并行安全书写（临时端口、逐文件 fixture），因为串行所有者早已被抽进独立进程。`scripts/ci-workflow.spec.ts` 钉住全部三个表达式，未来的 workflow 编辑无法静默丢弃或放宽任一杠杆。

## 备选方案

- **提高 `timeout-minutes`**——退化托管 runner 上仅该文件的全矩阵就需一到三小时；没有合理的超时能容纳，且 lane 已是 PR 墙钟上限。
- **在测试源码内削减矩阵**——全扫描是有意的本地与发布期深度验收；设计本已为这种调用方决策备好了环境裁剪旋钮，改源码会对所有 runner 类别一并削减覆盖。
- **拆文件或并行化**——Vitest 并行的是文件而非文件内测试，且 `fileParallelism: false` 使 lane 无论如何串行，拆分不改变墙钟成本。
- **只提高超时而并行度不变**——单 worker 下即使 120 分钟也没有应对 runner 退化的余量，且每个 full 模式变更的 PR 墙钟翻倍；同款 runner 上 sweep 的双 worker 先例才是有证据的校准。
- **按浏览器死锁处理**——证据矛盾：邻位文件全部按时完成，取消两次精确命中超时，成本模型无需额外缺陷即可闭合缺口。

## 影响

托管运行的 Admin 扫描现在以分钟计完成；更重要的是 lane 能完整跑完并报告真实失败清单，而非无声过期——兄弟 admin spec 的失败变为逐测试可见，而非随运行被截断。完整矩阵仍默认在本地运行，并在 master/nightly 扫描的高配 runner 上执行。每测试循环乘上大矩阵的文件都带有 lane 预算风险，本模式——通过测试自有旋钮在 workflow 层裁剪——应予复用。相关：[分层 web 浏览器验证](2026-09-11-web-verification-tiering.zh.md)拥有场景选择并保持权威；本笔记覆盖所选清单内的单文件成本。
