# Agent Note: 按退化 Windows 助手送达需求调整 lsp-stdio 拆除预算

Status: implemented

[English](2026-11-24-windows-teardown-budget-headroom.md) | 中文

## 问题

托管 Windows 镜像从 `20261103.298` 滚版到 `20261111.635` 后，`packages/lsp/lsp-stdio/tests/instance.spec.ts` 中每个触及强制拆除的用例都烧满 180s 超时（master 上 24 例挂 14）。该 spec 经裸 `spawnSubprocess` spawn，其 Windows 拆除只有一条送达路径：受 `spawnSync` 超时约束的 `taskkill /T /F`——而产品刻意把该超时绑定到 spawn 的 `graceMs`（`taskkillProcessTree(pid, spec.graceMs)`；deadline fixture 正是为证明该预算传播而存在）。spec 的 100–200ms 升级预算在退化宿主上使助手饥饿：`spawnSync` 在 taskkill 送达前将其 SIGKILL，进程树存活，而 `forceTerminate` 刻意无界的 `waitForManagedRangeExit` 对活性无限轮询。姊妹 `lifecycle.spec.ts` 约 16s 通过，因为 provider 路径经 `launchWindowsJob` 的 Job Object 终结，从不调用 taskkill。

## 决定

只提高 spec 侧预算：`SHUTDOWN_TIMEOUT_MS`/`KILL_GRACE_MS` 常量设为 2s，替换全部 100–500ms 字面量；`waitForProcessExit`/`waitForFile` 的轮询上限提至 10s。常量记录了这些预算是助手送达包络而非紧凑的升级节奏：挂起服务器用例在升级前等待 2s 的关闭预算，而提前落地的终止仍经由 range-exit 观察清除 grace 定时器。产品代码不变：`taskkillProcessTree` 的属主预算绑定是 deadline fixture 断言的契约，`forceTerminate` 的无界等待是文档化的静默后置条件。

## 备选方案

- **在 `taskkillProcessTree` 内设超时下限**——破坏了 native-control deadline fixture 的前提（助手生命周期必须跟随属主预算以证明 deadline 传播），并削弱了「进程树终止失败仍对释放方可见」的契约；环境属性应归于调用方而非助手。
- **taskkill 后追加 `child.kill` 兜底**——会在进程树终止静默失败时仍终结子进程，掩盖释放方本应观察到的幸存后代。
- **经 `windowsUnsupportedTests` 排除 Windows**——能让 lane 变绿，但 fallback 拆除路径的真实延迟需求将不再被任何测试发现。

## 后果

spec 的强制拆除用例给予 taskkill 两秒包络——较健康镜像预算高一个数量级——同时保持升级顺序与静默断言完整。若 `windows-native` 暴露的是助手送达被阻断而非仅缓慢（例如 Node 不再为被 taskkill 的子进程发布 `exit`），`windowsUnsupportedTests` 仍是文档化的排除退路。
