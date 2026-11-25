# Agent Note：在托管 web-verification runner 上收窄 Admin 验收矩阵

状态：已实现

[English](2026-11-25-admin-matrix-hosted-budget.md) | 中文

## 问题

`web verification` lane 连续两次精确烧满 90 分钟 `timeout-minutes`，表面像浏览器死锁：最后一个 pool 文件结果在 lane 约 45 分钟处打印后，日志直到取消都零输出。该文件并未死锁——而是算术上不可能完成。`apps/web/tests/admin-responsive-pages.e2e.ts` 在每个测试内部循环全部 18 个 `adminResponsiveSizes` viewport，横跨 20 个 admin 场景与三个浏览器引擎，每个 viewport 遍次执行一次登录、多次页面加载、`networkidle` 等待、控件审计与对话框交互。即使按每次 viewport 数秒的乐观估计，该文件串行需要一到三小时，而 lane 轮到它时最多只剩约 48 分钟——且 Vitest 在非 TTY 运行中把文件输出批到完成时打印，于是过大的矩阵伪装成了挂死进程。更关键的是矩阵在单文件内串行，任何 worker 数都无法缩短其墙钟成本。

## 决策

lane 通过与 `DSH_WEB_SNAPSHOT_WORKERS` 相同的容量条件式设置 `DSH_ADMIN_ENGINES` 与 `DSH_ADMIN_VIEWPORTS`——测试设计本已提供的裁剪旋钮：托管 `ubuntu-latest` 以 chromium 跑代表性宽度 320、390、768、1280（约十倍成本削减），企业与自托管 failover runner 保留完整引擎与 viewport 扫描。390 保留了行使 text-spacing 特例的 viewport，1024 的 coarse/fine 边界仍由相邻宽度覆盖。`scripts/ci-workflow.spec.ts` 在 worker 断言旁钉住两个表达式，未来的 workflow 编辑无法静默丢弃或放宽裁剪。

## 备选方案

- **提高 `timeout-minutes`**——退化托管 runner 上仅该文件的全矩阵就需一到三小时；没有合理的超时能容纳，且 lane 已是 PR 墙钟上限。
- **在测试源码内削减矩阵**——全扫描是有意的本地与发布期深度验收；设计本已为这种调用方决策备好了环境裁剪旋钮，改源码会对所有 runner 类别一并削减覆盖。
- **拆文件或并行化**——Vitest 并行的是文件而非文件内测试，且 `fileParallelism: false` 使 lane 无论如何串行，拆分不改变墙钟成本。
- **按浏览器死锁处理**——证据矛盾：邻位文件全部按时完成，取消两次精确命中超时，成本模型无需额外缺陷即可闭合缺口。

## 影响

托管运行的 Admin 扫描现在以分钟计完成；更重要的是 lane 能完整跑完并报告真实失败清单，而非无声过期——兄弟 admin spec 的失败变为逐测试可见，而非随运行被截断。完整矩阵仍默认在本地运行，并在 master/nightly 扫描的高配 runner 上执行。每测试循环乘上大矩阵的文件都带有 lane 预算风险，本模式——通过测试自有旋钮在 workflow 层裁剪——应予复用。相关：[分层 web 浏览器验证](2026-09-11-web-verification-tiering.zh.md)拥有场景选择并保持权威；本笔记覆盖所选清单内的单文件成本。
